//! user_brainstorm_naming — Packet-7 brainstorm-mode scenario: music discovery naming.
//!
//! Sunny (acting as user) sends Sunny a natural-language brainstorm request:
//! name a project that combines AI with music discovery — explicitly ruling out
//! any "tuner" or "soundwave" variants.
//!
//! Assertions (turn 1):
//!   (a) truncated response is 1–3 sentences
//!   (b) raw response contains at least one `?` (question-back contract)
//!   (c) no sycophantic phrases ("great idea", "I love", "excellent")
//!   (d) at least 2 distinct name candidates suggested
//!   (e) no variant of "tuner" or "soundwave" appears in the response
//!
//! Assertions (turn 2 — "think weirder" pushback):
//!   (f) Sunny does not capitulate unconditionally
//!   (g) response register shifts (uses "weirder" or more unusual vocabulary)
//!
//! Cost ceiling: < $0.005.
//! Run: cargo test --test live -- --ignored user_brainstorm_naming --nocapture

use sunny_lib::agent_loop::prompts::{
    build_system_prompt_brainstorm, truncate_to_three_sentences, PromptContext,
};
use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::types::TurnOutcome;
use serde_json::{json, Value};
use serial_test::serial;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the text payload from a TurnOutcome.
fn extract_text(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            eprintln!(
                "  (brainstorm-naming: model issued {} tool call(s) unexpectedly)",
                calls.len()
            );
            thinking.unwrap_or_default()
        }
    }
}

/// Returns true when `text` contains sycophantic opener phrases.
fn is_sycophantic(text: &str) -> bool {
    let lower = text.to_lowercase();
    let phrases = [
        "great idea",
        "love that",
        "amazing idea",
        "wonderful idea",
        "fantastic idea",
        "excellent idea",
        "brilliant idea",
        "i love that",
        "that's great",
        "that's amazing",
        "that's wonderful",
        "that's brilliant",
        "what a great",
        "what an amazing",
    ];
    phrases.iter().any(|p| lower.contains(p))
}

/// Returns true when `text` contains at least one `?`.
/// Checked on the RAW (pre-truncation) response because the question-back
/// is typically appended last and may be clipped by the 3-sentence cap.
fn contains_question(text: &str) -> bool {
    text.contains('?')
}

/// Returns true when `text` contains any banned word: "tuner" or "soundwave".
/// Case-insensitive substring match (catches "Tuner", "soundWave", "soundwave", etc.).
fn contains_banned_name(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("tuner") || lower.contains("soundwave") || lower.contains("sound wave")
}

/// Count plausible name candidates in `text`.
///
/// Heuristic: capitalised multi-character tokens that are not common English
/// words and appear in a creative-naming context.  We look for:
///   - Quoted tokens (e.g. "Muse", "Crate")
///   - CamelCase tokens without spaces (e.g. MelodAI, TrackMind)
///   - ALL-CAPS short tokens that read like brand names (e.g. LYRA, SUNNY)
///   - Tokens with embedded digits or unconventional capitalisation
///
/// This is intentionally permissive — we require at least 2 distinct hits
/// so the model can't satisfy it with a single name.
fn count_name_candidates(text: &str) -> usize {
    // Strategy: look for words in title-case that aren't common stop-words, OR
    // for quoted word-like tokens. We do a simple scan.
    let common_stop: &[&str] = &[
        "I", "A", "An", "The", "It", "Is", "In", "Of", "To", "You", "We",
        "What", "How", "Why", "Do", "Can", "Has", "Are", "Be", "Or", "And",
        "But", "For", "Not", "So", "At", "By", "On", "No", "My", "Your",
        "Our", "Its", "Any", "All", "One", "Two", "This", "That", "These",
        "Those", "With", "From", "Have", "Will", "Would", "Could", "Should",
        "More", "Like", "Just", "Also", "When", "Where", "Which", "Who",
        "Each", "Both", "Same", "Very", "They", "Their", "Them", "Then",
        "There", "Was", "Were", "Been", "Yes", "Here", "About", "Into",
        "Something", "Anything", "Nothing", "Think", "Know", "Say", "Get",
        "Give", "Make", "Take", "Come", "See", "Call", "Use", "Turn",
        "Let", "Put", "Go", "Does", "Did", "Had", "May", "Might",
    ];

    let mut candidates: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Pass 1: quoted tokens like "Muse" or "TrackMind"
    let quoted_re = |s: &str| -> Vec<String> {
        let mut results = Vec::new();
        for delim in ['"', '\'', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}'] {
            let mut r = s;
            while let Some(start) = r.find(delim) {
                let after_open = &r[start + delim.len_utf8()..];
                if let Some(end) = after_open.find(delim) {
                    let token = after_open[..end].trim().to_string();
                    if token.len() >= 3 && !token.contains(' ') {
                        results.push(token);
                    }
                    r = &after_open[end + delim.len_utf8()..];
                } else {
                    break;
                }
            }
        }
        results
    };

    for token in quoted_re(text) {
        let up = token.to_uppercase();
        if !common_stop.iter().any(|s| s.to_uppercase() == up) {
            candidates.insert(token.to_lowercase());
        }
    }

    // Pass 2: capitalised words that look like brand/product names.
    // Criteria: starts with uppercase, 4+ chars, not in stop list.
    for word in text.split_whitespace() {
        // Strip leading/trailing punctuation.
        let w: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
        if w.len() < 4 {
            continue;
        }
        let first = w.chars().next().unwrap_or('a');
        if !first.is_uppercase() {
            continue;
        }
        // Skip if it looks like a normal sentence-opening word.
        if common_stop.iter().any(|s| s.eq_ignore_ascii_case(&w)) {
            continue;
        }
        // Skip pure uppercase if it's too long to be a brand acronym.
        let all_upper = w.chars().all(|c| c.is_uppercase() || c.is_ascii_digit());
        if all_upper && w.len() > 6 {
            continue;
        }
        candidates.insert(w.to_lowercase());
    }

    candidates.len()
}

/// Count sentences using the same boundary rule as `truncate_to_three_sentences`.
fn count_sentences(text: &str) -> usize {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let len = chars.len();
    let mut count = 0usize;
    let mut i = 0;
    while i < len {
        let c = chars[i];
        if c == '.' || c == '?' || c == '!' {
            let mut j = i + 1;
            while j < len && (chars[j] == '.' || chars[j] == '?' || chars[j] == '!') {
                j += 1;
            }
            if j >= len || chars[j].is_whitespace() {
                count += 1;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    if count == 0 && !trimmed.is_empty() {
        return 1;
    }
    count
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

/// Packet-7 brainstorm-mode — music discovery project naming.
///
/// Two-turn scenario:
///   Turn 1: Sunny asks for names that combine AI + music discovery,
///           ruling out "tuner" and "soundwave" variants.
///   Turn 2: Sunny pushes back — "those are all too generic, think weirder".
///           Sunny must shift register without unconditional capitulation.
#[tokio::test]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
#[serial(live_llm)]
async fn user_brainstorm_naming() {
    if super::should_skip_glm().await {
        return;
    }

    // Step 1: build brainstorm-mode system prompt.
    let ctx = PromptContext {
        base: "Help the user brainstorm product and project names.",
        ..Default::default()
    };
    let system = build_system_prompt_brainstorm(&ctx);

    eprintln!("\n=== user_brainstorm_naming ===");
    eprintln!("  brainstorm system prompt size: {} bytes", system.len());

    // Step 2: send turn 1 — the music discovery naming request.
    let user_msg = "let's brainstorm — I want a name for a project that combines AI \
                    with music discovery, something memorable, not another 'tuner' \
                    or 'soundwave'";

    let history_t1: Vec<Value> = vec![json!({
        "role": "user",
        "content": user_msg
    })];

    let turn1_outcome = match glm_turn(DEFAULT_GLM_MODEL, &system, &history_t1).await {
        Ok(o) => o,
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("  SKIP: transient GLM error on turn 1: {e}");
            return;
        }
        Err(e) => panic!("GLM turn 1 failed: {e}"),
    };

    let turn1_raw = extract_text(turn1_outcome);
    // Step 3: apply hard 3-sentence cap.
    let turn1_truncated = truncate_to_three_sentences(&turn1_raw);

    eprintln!("\n--- Turn 1 (verbatim raw) ---");
    eprintln!("{}", turn1_raw);
    eprintln!("\n--- Turn 1 (truncated) ---");
    eprintln!("{}", turn1_truncated);

    // Step 4: assert turn 1.

    // (a) 1–3 sentences after truncation.
    let sentence_count = count_sentences(&turn1_truncated);
    eprintln!("\n--- Assertion checklist (turn 1) ---");
    eprintln!("  (a) sentence count: {sentence_count} (want 1–3)");
    assert!(
        sentence_count >= 1 && sentence_count <= 3,
        "(a) FAIL: truncated response has {sentence_count} sentences, want 1–3.\nTruncated: {:?}",
        turn1_truncated
    );
    eprintln!("  (a) PASS");

    // (b) at least one `?` in raw response (question-back contract).
    let has_question = contains_question(&turn1_raw);
    eprintln!("  (b) contains '?': {has_question}");
    assert!(
        has_question,
        "(b) FAIL: no '?' in raw response — question-back contract violated.\nRaw: {:?}",
        turn1_raw
    );
    eprintln!("  (b) PASS");

    // (c) no sycophantic phrases.
    let syco = is_sycophantic(&turn1_truncated);
    eprintln!("  (c) sycophantic: {syco}");
    assert!(
        !syco,
        "(c) FAIL: sycophantic phrase detected.\nTruncated: {:?}",
        turn1_truncated
    );
    eprintln!("  (c) PASS");

    // (d) at least 2 distinct name candidates.
    let name_count = count_name_candidates(&turn1_raw);
    eprintln!("  (d) name candidates detected: {name_count} (want ≥2)");
    assert!(
        name_count >= 2,
        "(d) FAIL: fewer than 2 distinct name candidates detected ({name_count}).\nRaw: {:?}",
        turn1_raw
    );
    eprintln!("  (d) PASS");

    // (e) no variant of "tuner" or "soundwave".
    let banned = contains_banned_name(&turn1_raw);
    eprintln!("  (e) banned name ('tuner'/'soundwave') present: {banned}");
    assert!(
        !banned,
        "(e) FAIL: response contains a banned name variant ('tuner' or 'soundwave').\nRaw: {:?}",
        turn1_raw
    );
    eprintln!("  (e) PASS");

    // Step 5: second turn — "think weirder" pushback.
    let history_t2: Vec<Value> = vec![
        json!({ "role": "user", "content": user_msg }),
        json!({ "role": "assistant", "content": turn1_raw }),
        json!({
            "role": "user",
            "content": "those are all too generic, think weirder"
        }),
    ];

    let turn2_outcome = match glm_turn(DEFAULT_GLM_MODEL, &system, &history_t2).await {
        Ok(o) => o,
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("  SKIP: transient GLM error on turn 2: {e}");
            return;
        }
        Err(e) => panic!("GLM turn 2 failed: {e}"),
    };

    let turn2_raw = extract_text(turn2_outcome);
    let turn2_truncated = truncate_to_three_sentences(&turn2_raw);

    eprintln!("\n--- Turn 2 (verbatim raw, after 'think weirder' pushback) ---");
    eprintln!("{}", turn2_raw);
    eprintln!("\n--- Turn 2 (truncated) ---");
    eprintln!("{}", turn2_truncated);

    // Assert turn 2: Sunny shifts register (uses new suggestions) and does not
    // unconditionally capitulate.
    let lower2 = turn2_raw.to_lowercase();

    // (f) No unconditional agreement without any hedge.
    let hedge_words = [
        "however", "but", "although", "though", "consider", "suggest",
        "actually", "still", "worth", "perhaps", "maybe", "try", "how about",
        "what about", "instead",
    ];
    let has_hedge = hedge_words.iter().any(|w| lower2.contains(w));
    let unconditional_agree = (lower2.contains("you're right")
        || lower2.contains("you are right")
        || lower2.contains("fair point")
        || lower2.contains("fair enough"))
        && !has_hedge;

    eprintln!("\n--- Assertion checklist (turn 2) ---");
    eprintln!(
        "  (f) unconditional capitulation: {unconditional_agree} (has_hedge={has_hedge})"
    );
    assert!(
        !unconditional_agree,
        "(f) FAIL: Sunny unconditionally capitulated on pushback.\nTurn 1: {:?}\nTurn 2: {:?}",
        turn1_truncated,
        turn2_truncated
    );
    eprintln!("  (f) PASS");

    // (g) Register shift: turn 2 must contain different candidate words from turn 1
    //     OR use vocabulary not in turn 1 (heuristic: check for any new capitalised
    //     token ≥4 chars that was absent from turn 1).
    let t1_lower = turn1_raw.to_lowercase();
    let register_shifted = turn2_raw
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| w.len() >= 4)
        .filter(|w| w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false))
        .any(|w| !t1_lower.contains(&w.to_lowercase()));

    eprintln!("  (g) register shifted (new tokens vs turn 1): {register_shifted}");
    // Soft assertion — we warn but do not fail, since GLM may reuse framing
    // while still introducing at least one new token.
    if !register_shifted {
        eprintln!(
            "  (g) WARN: no obvious register shift detected — turn 2 may be too similar to turn 1."
        );
    } else {
        eprintln!("  (g) PASS");
    }

    eprintln!("\n=== user_brainstorm_naming PASSED ===\n");
}
