//! Query expansion — paraphrase a user query into several variants so a
//! downstream hybrid search can hit stored facts that use different
//! surface words than the query.
//!
//! Motivating failure mode: the user asks *"what do I like to drink?"*
//! but memory holds *"morning drink: espresso"* or *"Sunny prefers
//! espresso in the morning"*. Pure BM25 misses ("like" vs "prefers"),
//! and while the embedding-cosine leg of `hybrid::search` (R15-C)
//! softens this, a query with one or two tokens doesn't have much
//! semantic surface area for the embed to bite. Expansion amplifies:
//! generate 4 paraphrases ("drink preferences", "favorite beverage",
//! "morning habit", "what I usually drink") and each one lights up a
//! different corner of the store. `hybrid::search_expanded` then
//! de-duplicates hit IDs across the variants and keeps the best score.
//!
//! ### Model choice
//! The paraphraser is a **small, fast Ollama model** (qwen2.5:7b-
//! instruct-q4_0) — never the 30B main loop model. Two reasons:
//!
//!   1. **Latency budget.** This runs on the hot path of a recall call.
//!      A 30B model adds 3–6 s. A 7B instruct model answers this prompt
//!      in 200–600 ms on Apple silicon, which fits inside the 2 s hard
//!      timeout with margin for the first-token cold start.
//!   2. **Task fit.** Paraphrasing short queries is exactly the kind of
//!      shallow rewrite a 7B instruct model handles well — no tool use,
//!      no reasoning, no long-context juggling. Spending a 30B call on
//!      it is pure waste.
//!
//! The same model is already used elsewhere in the codebase for
//! summariser / critic sub-agents, so it's almost certainly pulled.
//!
//! ### Failure policy
//! Every failure mode (Ollama off, model missing, timeout, garbage
//! output, parse error) collapses to the same behaviour: return a
//! `Vec<String>` containing only the original query. That way the
//! caller's code path is *"expand, then search each"* unconditionally
//! — no special-case for the degraded mode, no "expansion unavailable"
//! error bubbling up through the tool surface.
//!
//! ### No recursion
//! We expand once. Expanding the expansions gets silly quickly (the
//! variants themselves contain near-synonyms which the model would
//! paraphrase into yet more near-synonyms, and the result set balloons
//! without new signal). Single level only.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const OLLAMA_GENERATE_URL: &str = "http://127.0.0.1:11434/api/generate";

/// Small, fast instruct model — matches the `summarizer` / `critic`
/// sub-agent choice elsewhere in the codebase, so the model is almost
/// certainly already resident.
const EXPAND_MODEL: &str = "qwen2.5:7b-instruct-q4_0";

/// Hard wall-clock budget for the whole paraphrase call (connect +
/// generate + parse). Tight on purpose: if the model isn't cooperating
/// we'd rather return the original query and let `hybrid::search` do
/// its own thing than stall the recall tool.
const EXPAND_TIMEOUT: Duration = Duration::from_secs(2);

/// Cap on variants the model is allowed to suggest. Asking for more
/// than ~6 tends to produce redundant rewrites (the 7B instruct model
/// runs out of genuinely different phrasings), and each extra variant
/// is another hybrid search the caller has to run.
const MAX_VARIANTS_CEILING: usize = 8;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Produce up to `max_variants` query strings by paraphrasing `query`
/// with a small local LLM. The returned vec always starts with the
/// original query (unchanged) so callers can treat it as
/// `[original, paraphrase_1, paraphrase_2, …]`.
///
/// * Never errors — any upstream failure collapses to `vec![original]`.
/// * Never recurses — this function does not call itself on the
///   generated variants.
/// * Deduplicates case-insensitively; near-duplicates that differ only
///   in punctuation are collapsed.
pub async fn expand_query(query: &str, max_variants: usize) -> Vec<String> {
    let original = query.trim().to_string();
    // An empty query has nothing to expand — and the downstream FTS would
    // reject it anyway. Return an empty vec so the caller short-circuits.
    if original.is_empty() {
        return Vec::new();
    }

    // `max_variants` includes the original. 1 = no expansion at all;
    // just return the original. Clamp to a sane ceiling.
    let budget = max_variants.clamp(1, MAX_VARIANTS_CEILING);
    if budget == 1 {
        return vec![original];
    }

    // Number of *paraphrases* to ask the model for. The system prompt is
    // hard-coded to ask for 4 ("Rephrase this query 4 ways…") to match
    // the R16-H spec. If the caller asked for fewer variants we'll trim
    // after parsing; asking for more is pointless on a 7B model.
    let requested_paraphrases = budget.saturating_sub(1).min(4);

    match tokio::time::timeout(
        EXPAND_TIMEOUT,
        generate_paraphrases(&original, requested_paraphrases),
    )
    .await
    {
        Ok(Ok(variants)) => merge_with_original(&original, variants, budget),
        Ok(Err(e)) => {
            log::debug!("expand_query: paraphrase failed ({e}); returning original only");
            vec![original]
        }
        Err(_) => {
            log::debug!(
                "expand_query: paraphrase exceeded {}ms budget; returning original only",
                EXPAND_TIMEOUT.as_millis()
            );
            vec![original]
        }
    }
}

// ---------------------------------------------------------------------------
// Internals — Ollama call + parsing
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GenerateResponse {
    #[serde(default)]
    response: String,
}

/// Fire a single `/api/generate` call against the local Ollama daemon
/// and parse its newline-separated response into paraphrases.
async fn generate_paraphrases(
    query: &str,
    n: usize,
) -> Result<Vec<String>, String> {
    // The prompt is deliberately terse — every extra sentence on a 7B
    // instruct model is another chance for it to misbehave (add
    // numbering, quote the original, preface with "Sure, here are…").
    // The phrasing matches the R16-H spec.
    let prompt = format!(
        "Rephrase this query {n} ways with different wording. \
         Return ONLY the {n} rephrased versions, one per line, no numbering. \
         Query: {query}"
    );

    let body = json!({
        "model": EXPAND_MODEL,
        "prompt": prompt,
        "stream": false,
        // Short keep-alive — this is a hot-path helper, not an
        // interactive chat. Don't pin VRAM if recall calls are
        // infrequent.
        "keep_alive": "5m",
        "options": {
            // Mild temperature — enough for wording variety, not enough
            // to start inventing new concepts the user didn't ask about.
            "temperature": 0.6,
            // Hard cap on tokens: n lines * ~15 tokens/line + slack.
            // Keeps a hallucinating model from running to the full
            // default 128-token budget.
            "num_predict": (n as i64).saturating_mul(25).max(60),
        }
    });

    let client = crate::http::client();
    let req = client
        .post(OLLAMA_GENERATE_URL)
        .timeout(EXPAND_TIMEOUT)
        .json(&body);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("expand transport: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("expand http {}", resp.status()));
    }

    let parsed: GenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("expand parse: {e}"))?;

    Ok(parse_variants(&parsed.response, n))
}

/// Split a free-text model response into clean candidate paraphrases.
/// Exposed to tests so we can pin the parser behaviour without running
/// a real Ollama.
pub(crate) fn parse_variants(raw: &str, n: usize) -> Vec<String> {
    raw.lines()
        .map(strip_leading_noise)
        .map(|s| s.trim().trim_matches(['"', '\'', '`']).to_string())
        .filter(|s| !s.is_empty())
        .take(n.saturating_mul(2)) // tolerate some garbage; merge_with_original will cap
        .collect()
}

/// Strip the cosmetic prefixes that 7B instruct models habitually add:
/// "1.", "- ", "* ", "1) ", etc. Keeps the function signature pure so
/// tests can hit it directly.
fn strip_leading_noise(line: &str) -> String {
    let mut s = line.trim_start();

    // Drop a leading bullet / dash / asterisk if present.
    if let Some(rest) = s.strip_prefix(['-', '*', '•']) {
        s = rest.trim_start();
    }

    // Drop a leading "1.", "2)", "3:" etc. Only if it looks like a list
    // marker (digits + separator + space). Bail out on anything
    // ambiguous so we don't mangle queries like "42 tokyo time".
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0
        && i < bytes.len()
        && matches!(bytes[i], b'.' | b')' | b':')
        && bytes.get(i + 1) == Some(&b' ')
    {
        s = &s[i + 2..];
    }

    s.to_string()
}

/// Combine the original query with the model's paraphrases, dedupe
/// case-insensitively, and cap at `budget`. The original is always
/// index 0 so callers who want to "search just the original if
/// something goes wrong" can read `result[0]` unconditionally.
fn merge_with_original(
    original: &str,
    variants: Vec<String>,
    budget: usize,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(budget);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let original_key = normalise(original);
    seen.insert(original_key);
    out.push(original.to_string());

    for v in variants {
        if out.len() >= budget {
            break;
        }
        let key = normalise(&v);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(v);
    }
    out
}

/// Normalised lookup key for dedup — lowercase, whitespace-collapsed,
/// punctuation-stripped. Two variants that differ only in "?" vs "."
/// collapse to the same key.
fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

// ---------------------------------------------------------------------------
// Tests — parser + merger only. The Ollama call is not exercised here;
// it would require a live daemon and the failure paths already fall
// back to the original query, which is the behaviour a unit test cares
// about.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_strips_numbering_and_bullets() {
        let raw = "1. favorite drink\n2) beverage preference\n- what I drink\n* morning habit";
        let got = parse_variants(raw, 4);
        assert_eq!(
            got,
            vec![
                "favorite drink".to_string(),
                "beverage preference".to_string(),
                "what I drink".to_string(),
                "morning habit".to_string(),
            ]
        );
    }

    #[test]
    fn parse_strips_quotes_and_blank_lines() {
        let raw = "\"favorite drink\"\n\n'morning beverage'\n`what I like to drink`\n";
        let got = parse_variants(raw, 3);
        assert_eq!(
            got,
            vec![
                "favorite drink".to_string(),
                "morning beverage".to_string(),
                "what I like to drink".to_string(),
            ]
        );
    }

    #[test]
    fn parse_does_not_mangle_numeric_queries() {
        // "42 tokyo time" is a legitimate query, not a list marker.
        // The stripper should only fire when the digits are followed
        // by `.`, `)`, or `:` and a space.
        let raw = "42 tokyo time";
        let got = parse_variants(raw, 1);
        assert_eq!(got, vec!["42 tokyo time".to_string()]);
    }

    #[test]
    fn merge_always_puts_original_first() {
        let out = merge_with_original(
            "what do I drink",
            vec!["favorite drink".into(), "beverage preference".into()],
            5,
        );
        assert_eq!(out[0], "what do I drink");
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn merge_dedupes_case_and_punct_insensitively() {
        // All three variants are the same as the original modulo case
        // and punctuation — should collapse to just the original.
        let out = merge_with_original(
            "what do I drink?",
            vec![
                "What do I drink".into(),
                "what do I drink.".into(),
                "WHAT  DO  I  DRINK!".into(),
            ],
            10,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "what do I drink?");
    }

    #[test]
    fn merge_respects_budget() {
        let out = merge_with_original(
            "q",
            vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
            3,
        );
        // budget includes the original
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], "q");
    }

    #[test]
    fn merge_skips_empty_variants() {
        let out = merge_with_original(
            "q",
            vec!["".into(), "   ".into(), "a".into()],
            10,
        );
        assert_eq!(out, vec!["q".to_string(), "a".to_string()]);
    }

    #[tokio::test]
    async fn expand_empty_query_returns_empty_vec() {
        let out = expand_query("", 5).await;
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn expand_budget_one_returns_only_original() {
        // budget=1 means no expansion at all — must not even call the
        // network. If this test times out, we're hitting Ollama when we
        // shouldn't be.
        let out = tokio::time::timeout(
            Duration::from_millis(50),
            expand_query("what do I drink", 1),
        )
        .await
        .expect("should not touch the network at budget=1");
        assert_eq!(out, vec!["what do I drink".to_string()]);
    }

    #[test]
    fn normalise_collapses_whitespace_and_punct() {
        assert_eq!(normalise("What Do I Drink?"), "what do i drink");
        assert_eq!(normalise("  what   do    i  drink  "), "what do i drink");
        assert_eq!(normalise("WHAT, DO. I! DRINK?"), "what do i drink");
    }
}
