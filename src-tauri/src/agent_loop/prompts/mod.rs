//! System prompt composition for the SUNNY agent loop.
//!
//! ## Architecture
//!
//! The system prompt is built from four independent, immutable blocks:
//!
//! ```text
//! ┌─────────────────────────────┐
//! │  SAFETY block               │  anti-injection, no fabrication, clarify,
//! │  (safety_block.rs)          │  tool economy, no secret paths
//! ├─────────────────────────────┤
//! │  CAPABILITIES block         │  factual tool inventory
//! │  (capabilities_block.rs)    │
//! ├─────────────────────────────┤
//! │  TOOL USE block             │  when/how to call tools + few-shot examples
//! │  (tool_use_block.rs)        │
//! ├─────────────────────────────┤
//! │  PERSONA block              │  who SUNNY is — British voice, no emoji
//! │  (persona_block.rs)         │  (SOUL bundle or compact fallback)
//! ├─────────────────────────────┤
//! │  base prompt                │  caller-supplied task/role text
//! ├─────────────────────────────┤
//! │  memory digest (optional)   │  recalled facts about user
//! ├─────────────────────────────┤
//! │  query hint (optional)      │  per-turn current-events nudge
//! ├─────────────────────────────┤
//! │  name-seed hint (optional)  │  ask for name if unknown
//! ├─────────────────────────────┤
//! │  canary sentinel            │  prompt-injection tripwire (always last)
//! └─────────────────────────────┘
//! ```
//!
//! Each block file is self-contained and independently testable. `mod.rs`
//! (this file) only composes them — it contains no prompt text of its own.
//!
//! ## Public surface
//!
//! * `build_system_prompt(ctx)` — new primary entry point; takes a `PromptContext`
//! * `compose_system_prompt(...)` — legacy positional signature kept for `core.rs`
//! * `default_system_prompt()` — minimal base prompt used when no SOUL bundle exists
//! * `query_hint(msg)` — returns per-turn current-events hint if needed
//! * `seed_user_profile_if_empty()` — async; checks if we should ask for the user's name
//! * `load_soul_file()` — reads + caches the ~/.sunny/ SOUL bundle

pub mod capabilities_block;
pub mod persona_block;
pub mod safety_block;
pub mod tool_use_block;

// Re-export the building blocks so callers can use them individually in tests.
pub use capabilities_block::build_capabilities_block;
pub use persona_block::{build_persona_block, compact_persona};
pub use safety_block::build_safety_block;
pub use tool_use_block::{build_tool_use_block, VOICE_LATENCY_RULE};

// Legacy constants re-exported so any code that imports them by name still compiles.
pub use safety_block::SAFETY_INJECTION_DEFENCE as SAFETY_AMENDMENT;
pub use tool_use_block::TOOL_USE_DIRECTIVE;

/// Marker placed in the composed system prompt to separate the
/// prompt-cache-stable prefix from the per-turn dynamic suffix. The
/// Anthropic provider splits on this so `cache_control` only tags the
/// stable half — session-specific content (memory digest, continuity
/// digest, query hint, canary) stays below the marker and does not
/// invalidate the prompt cache between turns.
pub const SUNNY_CACHE_BOUNDARY: &str = "\n<!-- SUNNY_CACHE_BOUNDARY -->\n";

/// Split a composed system prompt on [`SUNNY_CACHE_BOUNDARY`]. Returns
/// `(stable_prefix, dynamic_suffix)`. When the marker isn't present
/// (legacy prompts built without `build_system_prompt`) the whole string
/// is treated as stable and the suffix is empty — callers fall back to
/// the single-block behaviour.
pub fn split_system_prompt_cache_boundary(s: &str) -> (String, String) {
    match s.split_once(SUNNY_CACHE_BOUNDARY) {
        Some((prefix, suffix)) => (prefix.to_string(), suffix.to_string()),
        None => (s.to_string(), String::new()),
    }
}

/// All inputs needed to build a system prompt. Using a struct means new
/// optional fields can be added without breaking every call site.
#[derive(Debug, Default)]
pub struct PromptContext<'a> {
    /// Core task/role description (was the `base` positional arg).
    pub base: &'a str,
    /// Pre-built memory digest to inject after the base prompt.
    pub digest: Option<&'a str>,
    /// Per-turn current-events hint (from `query_hint`).
    pub query_hint: Option<&'static str>,
    /// If true, append the name-seed nudge.
    pub needs_name_prompt: bool,
    /// Session identifier — if it starts with `"sunny-voice-"` the voice
    /// latency supplement is added to the tool-use block.
    pub session_id: Option<&'a str>,
}

/// Primary entry point. Composes the full system prompt from a `PromptContext`.
///
/// Block order (safety-first, canary-last):
///   SAFETY → CAPABILITIES → TOOL_USE → PERSONA → base → digest → hint → canary
///
/// Returns a newly allocated `String` — nothing is mutated.
pub fn build_system_prompt(ctx: &PromptContext<'_>) -> String {
    let is_voice = ctx
        .session_id
        .is_some_and(|s| s.starts_with("sunny-voice-"));

    let soul = load_soul_file();

    let safety = build_safety_block();
    let capabilities = build_capabilities_block();
    let tool_use = build_tool_use_block(is_voice);
    let persona = build_persona_block(soul.as_deref());

    let mut out = String::with_capacity(
        safety.len()
            + capabilities.len()
            + tool_use.len()
            + persona.len()
            + ctx.base.len()
            + ctx.digest.map(str::len).unwrap_or(0)
            + 512,
    );

    // Stable prefix: identical across every turn in a session (modulo
    // SOUL-bundle edits, which refresh every 5 s). Lives above the
    // cache boundary so Anthropic's prompt cache serves it from the KV
    // store instead of reprocessing ~19 KB of safety+tools+persona on
    // every keystroke.
    out.push_str(&safety);
    out.push_str("\n\n");
    out.push_str(&capabilities);
    out.push_str("\n\n");
    out.push_str(&tool_use);
    out.push_str("\n\n");
    out.push_str(&persona);
    out.push_str("\n\n");
    out.push_str(ctx.base);

    // Everything below the boundary is per-session or per-turn state
    // (recent session refs, recalled user facts, current-events nudge,
    // name-seed, canary sentinel with its random token). Changing any
    // of these is EXPECTED to invalidate that turn's cache read — but
    // never the stable prefix above.
    out.push_str(SUNNY_CACHE_BOUNDARY);

    if let Some(cont) = super::memory_integration::build_continuity_digest(3) {
        out.push_str(&cont);
        out.push_str("\n\n");
    }
    if let Some(d) = ctx.digest {
        out.push_str(d);
        out.push_str("\n\n");
    }
    if let Some(hint) = ctx.query_hint {
        out.push_str(hint);
        out.push_str("\n\n");
    }
    if ctx.needs_name_prompt {
        out.push_str(NAME_SEED_HINT);
        out.push_str("\n\n");
    }
    out.push_str(&crate::security::canary::sentinel_line());
    out
}

/// Legacy positional entry point. Delegates to `build_system_prompt` so
/// existing callers in `core.rs` compile without changes.
pub fn compose_system_prompt(
    base: &str,
    digest: Option<&str>,
    query_hint_val: Option<&'static str>,
    needs_name_prompt: bool,
    session_id: Option<&str>,
) -> String {
    let ctx = PromptContext {
        base,
        digest,
        query_hint: query_hint_val,
        needs_name_prompt,
        session_id,
    };
    build_system_prompt(&ctx)
}

/// Appended only on the very first main-agent turn when the semantic
/// memory store has no user-name fact yet. Prompts SUNNY to ask politely
/// instead of hallucinating a name.
pub const NAME_SEED_HINT: &str = "NOTE: You don't know the user's name yet. If they haven't told you, \
politely ask at the end of your first reply: \"By the way, what should I call you?\" Do not ask \
again once you know.";

/// Appended to the system prompt when the user message contains
/// current-events keywords. The extra nudge is load-bearing for smaller
/// Ollama models that still ignore the global tool directive.
pub const CURRENT_EVENTS_HINT: &str = "NOTE: User query contains current-events keywords. You must call \
web_search or the appropriate live tool. Do not answer from prior knowledge.";

/// Detect current-events trigger words in the user's message and return an
/// extra system-prompt line nudging the model toward `web_search`.
pub fn query_hint(msg: &str) -> Option<&'static str> {
    let m = msg.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "now",
        "right now",
        "today",
        "current",
        "latest",
        "president",
        "news",
        "weather",
        "time in",
        "who is",
        "who's",
    ];
    if NEEDLES.iter().any(|n| m.contains(n)) {
        Some(CURRENT_EVENTS_HINT)
    } else {
        None
    }
}

/// Minimal base prompt. Used when the caller passes an empty base and no
/// SOUL bundle is present on disk. Deliberately does NOT bake in the user's
/// name — that lives in semantic memory.
pub fn default_system_prompt() -> &'static str {
    "You are SUNNY, a personal desktop assistant on macOS. You have access \
    to real tools — web_search, web_fetch, weather, Safari, Mail, Calendar, \
    Reminders, Notes, app launch, calculator, timezone lookup, unit \
    conversion, memory_recall, memory_remember, stock quotes, battery / \
    system metrics, focused window, screen OCR, clipboard history, media \
    playback, spawn_subagent, and scheduled tasks.\n\n\
    HARD RULES — your training data is stale; you MUST call a tool in \
    these cases:\n\
    - Any question about current events, politics, news, presidents, \
      leaders, prices, sports, or any living public figure → web_search.\n\
    - Any question about weather, time zones, dates, or the calendar → \
      the relevant tool.\n\
    - Any question about the user (their name, location, preferences, \
      history) → memory_recall FIRST, then answer from the result.\n\
    - Any statement from the user that is a durable fact about them \
      (\"my name is X\", \"I live in Y\", \"I prefer Z\", \"remember that \
      W\") → memory_remember immediately.\n\
    - Any compound research / drafting / multi-step task → spawn_subagent \
      with the appropriate role.\n\n\
    Do not guess from prior knowledge when a tool exists. Do not apologise \
    for not knowing — call the tool. Speak in short British sentences, \
    no emoji. Once you have the answer, reply directly without chaining \
    further tool calls."
}

/// Read the Soul Spec bundle from `~/.sunny/` and return it as a single
/// concatenated block. Files are delimited by their own headers.
///
/// Files in priority order:
///   SOUL.md, IDENTITY.md, STYLE.md, AGENTS.md, HEARTBEAT.md
///
/// Any missing file is silently skipped. The whole bundle is cached with a
/// 5 s refresh so on-disk edits land without an app restart.
/// Returns `Some(_)` iff at least one file was readable.
pub fn load_soul_file() -> Option<String> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    static CACHE: OnceLock<Mutex<Option<(Instant, Option<String>)>>> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cell.lock() {
        if let Some((when, maybe_text)) = guard.as_ref() {
            if when.elapsed() < Duration::from_secs(5) {
                return maybe_text.clone();
            }
        }
    }

    let dir = match dirs::home_dir() {
        Some(d) => d.join(".sunny"),
        None => return None,
    };
    const FILES: &[&str] = &["SOUL.md", "IDENTITY.md", "STYLE.md", "AGENTS.md", "HEARTBEAT.md"];
    let mut parts: Vec<String> = Vec::with_capacity(FILES.len());
    for name in FILES {
        let path = dir.join(name);
        if let Ok(text) = std::fs::read_to_string(&path) {
            parts.push(format!(
                "===== {name} (from ~/.sunny/{name}) =====\n{}\n",
                text.trim()
            ));
        }
    }
    let result = if parts.is_empty() { None } else { Some(parts.join("\n")) };
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

/// Check the semantic store for any user-name fact. Returns `true` when we
/// should nudge the model to ask for the user's name. Never errors visibly.
pub async fn seed_user_profile_if_empty() -> bool {
    let result = tokio::task::spawn_blocking(|| {
        let sem = crate::memory::semantic_search("user name".to_string(), Some(1))?;
        if !sem.is_empty() {
            return Ok::<(usize, usize), String>((sem.len(), 0));
        }
        let epi = crate::memory::note_search("user name".to_string(), Some(1))?;
        Ok((sem.len(), epi.len()))
    })
    .await;
    match result {
        Ok(Ok((sem_hits, epi_hits))) => {
            let empty = sem_hits == 0 && epi_hits == 0;
            log::info!(
                "[tool-use] seed_user_profile: semantic={} episodic={} — {}",
                sem_hits,
                epi_hits,
                if empty { "asking for name" } else { "skip" }
            );
            empty
        }
        Ok(Err(e)) => {
            log::info!("[tool-use] seed_user_profile: search failed ({e}) — skip");
            false
        }
        Err(e) => {
            log::info!("[tool-use] seed_user_profile: join error ({e}) — skip");
            false
        }
    }
}


/// Brainstorm-mode system prompt variant. Used when `chat_mode == "brainstorm"`.
///
/// Behavioural contract (honoured server-side):
///   1. Hard cap: replies truncated to first 3 sentences before delivery.
///   2. One question per turn — never end with more than one `?`.
///   3. Willing to disagree; raises the contrarian case if evidence supports it.
///   4. No tool calls in brainstorm mode — pure conversational reasoning only.
///
/// Returns a newly allocated `String`. Nothing is mutated.
pub fn build_system_prompt_brainstorm(ctx: &PromptContext<'_>) -> String {
    let soul = load_soul_file();
    let persona = build_persona_block(soul.as_deref());

    let brainstorm_block = "--- BRAINSTORM MODE ---\nYou are now in brainstorm mode: a sounding board for ideas, plans, and decisions.\n\
\nCONTRACT (inviolable):\n1. HARD REPLY CAP: every response must be exactly three sentences or fewer.\n   If you have more to say, pick the three most useful sentences and stop.\n2. ONE QUESTION PER TURN: end with at most one question mark. Never ask two questions.\n3. WILLING TO DISAGREE: if the user's framing is flawed, challenge it directly.\n   State your disagreement in the first sentence; do not hedge.\n4. NO TOOLS: do not call web_search, memory_recall, or any tool.\n   Reason from what you know; flag uncertainty inline if needed.\n5. CONVERSATIONAL: warm, dry, British. No preambles. No emoji.\n--- END BRAINSTORM MODE ---";

    let mut out = String::with_capacity(
        persona.len() + brainstorm_block.len() + ctx.base.len() + 256,
    );
    out.push_str(brainstorm_block);
    out.push_str("\n\n");
    out.push_str(&persona);
    if !ctx.base.is_empty() {
        out.push_str("\n\n");
        out.push_str(ctx.base);
    }
    if let Some(d) = ctx.digest {
        out.push_str("\n\n");
        out.push_str(d);
    }
    out.push_str("\n\n");
    out.push_str(&crate::security::canary::sentinel_line());
    out
}

/// Truncate an assistant reply to the first 3 sentences. Splits on `.`, `?`,
/// or `!` followed by whitespace or end-of-string. Returns a new `String`;
/// nothing is mutated. If the text has 3 or fewer sentences it is returned
/// unchanged (cloned). The cut is clean — no trailing ellipsis.
pub fn truncate_to_three_sentences(text: &str) -> String {
    let trimmed = text.trim();
    // Split into sentence-like chunks. We find sentence-ending punctuation
    // boundaries and count them. A "sentence" ends at the first `.`, `?`,
    // or `!` that is followed by whitespace or end-of-string.
    let chars: Vec<char> = trimmed.chars().collect();
    let len = chars.len();
    let mut sentence_count = 0;
    let mut last_cut = len;
    let mut i = 0;
    while i < len {
        let c = chars[i];
        if c == '.' || c == '?' || c == '!' {
            // Consume runs of sentence-ending punctuation (e.g. "!?", "...")
            let mut j = i + 1;
            while j < len && (chars[j] == '.' || chars[j] == '?' || chars[j] == '!') {
                j += 1;
            }
            // After the run: must be whitespace or end of string.
            if j >= len || chars[j].is_whitespace() {
                sentence_count += 1;
                if sentence_count == 3 {
                    last_cut = j;
                    break;
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    if sentence_count < 3 {
        // Fewer than 3 sentences — return as-is.
        return trimmed.to_string();
    }
    trimmed[..last_cut].trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Structural block-presence tests ─────────────────────────────────────

    /// build_system_prompt must contain the SUNNY name — the name is in both
    /// the persona block and the default_system_prompt base.
    #[test]
    fn build_system_prompt_contains_sunny() {
        let ctx = PromptContext {
            base: default_system_prompt(),
            ..Default::default()
        };
        let out = build_system_prompt(&ctx);
        assert!(out.contains("SUNNY"), "prompt must mention SUNNY");
    }

    /// The persona block (via build_persona_block fallback) must mention
    /// the British voice register.
    #[test]
    fn build_system_prompt_contains_british_voice_marker() {
        let ctx = PromptContext {
            base: "base",
            ..Default::default()
        };
        let out = build_system_prompt(&ctx);
        assert!(
            out.contains("British"),
            "prompt must reference British voice register"
        );
    }

    /// The tool-use section (fence marker) must be present.
    #[test]
    fn build_system_prompt_contains_tool_use_section() {
        let ctx = PromptContext {
            base: "base",
            ..Default::default()
        };
        let out = build_system_prompt(&ctx);
        assert!(
            out.contains("--- TOOL USE ---"),
            "prompt must contain TOOL USE section"
        );
    }

    /// The safety section (fence marker) must be present.
    #[test]
    fn build_system_prompt_contains_safety_section() {
        let ctx = PromptContext {
            base: "base",
            ..Default::default()
        };
        let out = build_system_prompt(&ctx);
        assert!(
            out.contains("--- SAFETY ---"),
            "prompt must contain SAFETY section"
        );
    }

    /// The capabilities section must be present.
    #[test]
    fn build_system_prompt_contains_capabilities_section() {
        let ctx = PromptContext {
            base: "base",
            ..Default::default()
        };
        let out = build_system_prompt(&ctx);
        assert!(
            out.contains("--- CAPABILITIES ---"),
            "prompt must contain CAPABILITIES section"
        );
    }

    // ── Canary sentinel tests (preserve existing tripwire contracts) ─────────

    #[test]
    fn compose_system_prompt_appends_canary_sentinel() {
        let out = compose_system_prompt("base", None, None, false, None);
        assert!(
            out.contains("PRIVILEGED_CONTEXT"),
            "compose_system_prompt must append the canary sentinel"
        );
    }

    #[test]
    fn voice_session_prompt_also_gets_canary_sentinel() {
        let out = compose_system_prompt(
            "voice base",
            None,
            None,
            false,
            Some("sunny-voice-session-001"),
        );
        assert!(
            out.contains("PRIVILEGED_CONTEXT"),
            "voice-session compose_system_prompt must append the canary sentinel, got:\n{out}"
        );
    }

    #[test]
    fn digest_does_not_displace_canary_sentinel() {
        let digest = "MEMORY DIGEST: user name: Sunny, location: Vancouver BC";
        let out = compose_system_prompt("base", Some(digest), None, false, None);
        assert!(out.contains("PRIVILEGED_CONTEXT"), "canary sentinel must survive digest injection");
        let digest_pos = out.find(digest).expect("digest should be in output");
        let canary_pos = out.find("PRIVILEGED_CONTEXT").expect("canary should be in output");
        assert!(
            canary_pos > digest_pos,
            "canary sentinel ({canary_pos}) must follow digest ({digest_pos})"
        );
    }

    #[test]
    fn multiple_compose_calls_produce_identical_canary_text() {
        let extract_sentinel = |s: &str| -> String {
            s.lines()
                .filter(|l| l.contains("PRIVILEGED_CONTEXT"))
                .last()
                .unwrap_or("")
                .to_owned()
        };
        let out1 = compose_system_prompt("base", None, None, false, None);
        let out2 = compose_system_prompt("other base", None, None, false, None);
        let out3 = compose_system_prompt("base", Some("digest"), None, false, None);
        let s1 = extract_sentinel(&out1);
        let s2 = extract_sentinel(&out2);
        let s3 = extract_sentinel(&out3);
        assert!(!s1.is_empty(), "sentinel must be present in first call");
        assert_eq!(s1, s2, "canary text must be identical across different base prompts");
        assert_eq!(s1, s3, "canary text must be identical when digest is present");
    }

    // ── Ordering tests ───────────────────────────────────────────────────────

    /// Safety must come before capabilities, which comes before tool-use,
    /// which comes before the base prompt, which comes before the canary.
    #[test]
    fn block_order_is_safety_capabilities_tooluse_base_canary() {
        let base = "MY_UNIQUE_BASE_MARKER_XYZ";
        let out = compose_system_prompt(base, None, None, false, None);

        let safety_pos = out.find("--- SAFETY ---").expect("SAFETY fence must be present");
        let caps_pos = out.find("--- CAPABILITIES ---").expect("CAPABILITIES fence must be present");
        let tools_pos = out.find("--- TOOL USE ---").expect("TOOL USE fence must be present");
        let base_pos = out.find(base).expect("base must be in output");
        let canary_pos = out.find("PRIVILEGED_CONTEXT").expect("canary must be in output");

        assert!(safety_pos < caps_pos, "SAFETY must precede CAPABILITIES");
        assert!(caps_pos < tools_pos, "CAPABILITIES must precede TOOL USE");
        assert!(tools_pos < base_pos, "TOOL USE must precede base prompt");
        assert!(base_pos < canary_pos, "base prompt must precede canary sentinel");
    }

    // ── Legacy compatibility ─────────────────────────────────────────────────

    /// The legacy SAFETY_AMENDMENT alias must still work (used by canary.rs docs).
    #[test]
    fn safety_amendment_alias_is_non_empty() {
        assert!(!SAFETY_AMENDMENT.is_empty(), "SAFETY_AMENDMENT alias must not be empty");
        assert!(
            SAFETY_AMENDMENT.contains("untrusted_source"),
            "SAFETY_AMENDMENT alias must reference untrusted_source"
        );
    }

    // ── query_hint tests ─────────────────────────────────────────────────────

    #[test]
    fn query_hint_matches_current_events_keywords() {
        assert!(query_hint("who is the president today").is_some());
        assert!(query_hint("what's the latest news").is_some());
        assert!(query_hint("what time is it right now").is_some());
        assert!(query_hint("current weather in Vancouver").is_some());
    }

    #[test]
    fn query_hint_does_not_match_unrelated_phrases() {
        assert!(query_hint("how do I sort a list in Python").is_none());
        assert!(query_hint("remind me to buy milk").is_none());
        assert!(query_hint("what is 2 + 2").is_none());
    }

    // ── Snapshot-style absence-detection tests ───────────────────────────────
    // These fail loudly if any block is accidentally dropped from the composed prompt.

    #[test]
    fn snapshot_safety_fence_present() {
        let out = build_system_prompt(&PromptContext { base: "x", ..Default::default() });
        assert!(out.contains("--- SAFETY ---"), "SNAPSHOT FAIL: SAFETY block was removed");
        assert!(out.contains("--- END SAFETY ---"), "SNAPSHOT FAIL: SAFETY closing fence removed");
    }

    #[test]
    fn snapshot_capabilities_fence_present() {
        let out = build_system_prompt(&PromptContext { base: "x", ..Default::default() });
        assert!(out.contains("--- CAPABILITIES ---"), "SNAPSHOT FAIL: CAPABILITIES block was removed");
        assert!(out.contains("--- END CAPABILITIES ---"), "SNAPSHOT FAIL: CAPABILITIES closing fence removed");
    }

    #[test]
    fn snapshot_tool_use_fence_present() {
        let out = build_system_prompt(&PromptContext { base: "x", ..Default::default() });
        assert!(out.contains("--- TOOL USE ---"), "SNAPSHOT FAIL: TOOL USE block was removed");
        assert!(out.contains("--- END TOOL USE ---"), "SNAPSHOT FAIL: TOOL USE closing fence removed");
    }

    #[test]
    fn snapshot_few_shot_examples_present() {
        let out = build_system_prompt(&PromptContext { base: "x", ..Default::default() });
        assert!(
            out.contains("Example 1") && out.contains("Example 2") && out.contains("Example 3"),
            "SNAPSHOT FAIL: one or more few-shot examples were removed from TOOL USE block"
        );
    }

    #[test]
    fn snapshot_no_fabrication_rule_present() {
        let out = build_system_prompt(&PromptContext { base: "x", ..Default::default() });
        assert!(
            out.contains("FABRICATION") || out.contains("fabricat"),
            "SNAPSHOT FAIL: anti-fabrication safety rule was removed"
        );
    }

    #[test]
    fn snapshot_secret_path_rule_present() {
        let out = build_system_prompt(&PromptContext { base: "x", ..Default::default() });
        assert!(
            out.contains(".env") || out.contains("SECRET PATHS"),
            "SNAPSHOT FAIL: secret-path redaction rule was removed"
        );
    }

    // ── Brainstorm prompt tests ──────────────────────────────────────────────

    /// Brainstorm prompt must mention the 3-sentence contract.
    #[test]
    fn brainstorm_prompt_mentions_three_sentence_cap() {
        let ctx = PromptContext { base: "think", ..Default::default() };
        let out = build_system_prompt_brainstorm(&ctx);
        assert!(
            out.to_ascii_lowercase().contains("three sentence")
                || out.to_ascii_lowercase().contains("3 sentence")
                || out.contains("3-sentence")
                || out.contains("three sentences"),
            "brainstorm prompt must mention the 3-sentence cap, got: {out}"
        );
    }

    /// Brainstorm prompt must forbid tool calls.
    #[test]
    fn brainstorm_prompt_forbids_tools() {
        let ctx = PromptContext { base: "think", ..Default::default() };
        let out = build_system_prompt_brainstorm(&ctx);
        assert!(
            out.to_ascii_lowercase().contains("no tool")
                || out.to_ascii_lowercase().contains("no_tool")
                || out.to_ascii_lowercase().contains("do not call"),
            "brainstorm prompt must forbid tool calls"
        );
    }

    // ── truncate_to_three_sentences tests ────────────────────────────────────

    /// Text with exactly 3 sentences is returned unchanged.
    #[test]
    fn truncate_three_sentences_returns_three_unchanged() {
        let text = "Sentence one. Sentence two. Sentence three.";
        let result = truncate_to_three_sentences(text);
        assert_eq!(result, text.trim());
    }

    /// Text with 2 sentences is returned unchanged.
    #[test]
    fn truncate_fewer_than_three_is_noop() {
        let text = "Only two sentences here. That is all.";
        let result = truncate_to_three_sentences(text);
        assert_eq!(result, text.trim());
    }

    /// Text with 5 sentences is truncated to 3.
    #[test]
    fn truncate_five_sentences_to_three() {
        let text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
        let result = truncate_to_three_sentences(text);
        assert_eq!(result.trim(), "First sentence. Second sentence. Third sentence.");
    }

    /// Truncation works with question marks and exclamation points.
    #[test]
    fn truncate_handles_mixed_terminators() {
        let text = "Is this the first? Yes it is! This is the third. And this is the fourth.";
        let result = truncate_to_three_sentences(text);
        // Should stop after "This is the third."
        assert!(result.contains("This is the third."), "must include third sentence");
        assert!(!result.contains("fourth"), "must NOT include fourth sentence");
    }

}
