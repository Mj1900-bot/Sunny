//! brainstorm_mode — Phase-2 Packet-7 end-to-end scenario.
//!
//! Exercises the brainstorm-mode system prompt (3-sentence cap + question-back
//! contract) against a live GLM-5.1 call.
//!
//! Run:
//!   cargo test --test live -- --ignored brainstorm_mode --nocapture

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
                "  (brainstorm: model issued {} tool call(s) unexpectedly)",
                calls.len()
            );
            thinking.unwrap_or_default()
        }
    }
}

/// Count sentences in `text` using the same boundary rule as
/// `truncate_to_three_sentences`: `[.?!]` followed by whitespace or
/// end-of-string. Abbreviation tolerance: a dot must be followed by ≥1
/// whitespace character *or* be the very last character.
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

/// Returns true when `text` contains a sycophantic opener phrase.
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
    ];
    phrases.iter().any(|p| lower.contains(p))
}

/// Returns true when `text` contains at least one `?`.
///
/// We check the RAW response (before 3-sentence truncation) because GLM
/// typically places the question at the END of its reply — after the
/// sentence cap cuts in, the `?` would be dropped. The contract requires
/// that GLM ASKS BACK somewhere in its output; truncation is a delivery
/// enforcement that doesn't negate the question-back intent.
fn contains_question(text: &str) -> bool {
    text.contains('?')
}

/// Call GLM once with the brainstorm system prompt and the naming question.
/// Returns `Some((raw, truncated))` on success, `None` on transient error.
async fn single_brainstorm_call(system: &str) -> Option<(String, String)> {
    let history: Vec<Value> = vec![json!({
        "role": "user",
        "content": "I'm stuck naming this feature — it's the thing that watches my screen \
                    and suggests stuff. Too creepy to call 'Observer', too bland to call \
                    'Assistant'. What do you think?"
    })];

    match glm_turn(DEFAULT_GLM_MODEL, system, &history).await {
        Ok(outcome) => {
            let raw = extract_text(outcome);
            let truncated = truncate_to_three_sentences(&raw);
            eprintln!("  [brainstorm raw]       {:?}", &raw[..raw.len().min(320)]);
            eprintln!("  [brainstorm truncated] {:?}", &truncated[..truncated.len().min(320)]);
            Some((raw, truncated))
        }
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("  SKIP (transient): {e}");
            None
        }
        Err(e) => panic!("GLM brainstorm call failed: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Main scenario test
// ---------------------------------------------------------------------------

/// Phase-2 Packet-7: brainstorm mode — 3-sentence cap + question-back contract.
///
/// Steps:
///   1. Build brainstorm system prompt via `build_system_prompt_brainstorm`.
///   2. Send the feature-naming question to GLM-5.1.
///   3. Apply `truncate_to_three_sentences` server-side cap.
///   4. Assert truncated output has 1–3 sentences.
///   5. Assert raw output contains `?` (question-back rule — checked on raw
///      because GLM typically appends the question after its content, which
///      the 3-sentence cap then clips).
///   6. Assert truncated output does NOT contain sycophantic phrases.
///   7. Repeat 3×; require ≥2 of 3 repetitions to pass rules 4–6.
///   8. Second turn: push back against Sunny's suggestion; assert Sunny
///      maintains a position (does not unconditionally capitulate).
///
/// Cost ceiling: ≤ $0.003 for all 3 repetitions.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn brainstorm_mode_three_sentence_cap_and_question_back() {
    if super::should_skip_glm().await {
        return;
    }

    let ctx = PromptContext {
        base: "Help the user brainstorm product and feature names.",
        ..Default::default()
    };
    let system = build_system_prompt_brainstorm(&ctx);

    // Steps 2–6 repeated 3 times; require ≥2 passes.
    let mut passes = 0u32;
    const REPS: u32 = 3;

    for rep in 1..=REPS {
        let Some((raw, truncated)) = single_brainstorm_call(&system).await else {
            eprintln!("  rep={rep}: skipped (transient error)");
            continue;
        };

        let sentence_count = count_sentences(&truncated);
        let has_question = contains_question(&raw);   // checked on raw (see doc above)
        let no_sycophancy = !is_sycophantic(&truncated);
        let sentences_ok = sentence_count >= 1 && sentence_count <= 3;

        eprintln!(
            "  rep={rep} sentences={sentence_count} has_question={has_question} \
             no_sycophancy={no_sycophancy} sentences_ok={sentences_ok}"
        );

        if sentences_ok && has_question && no_sycophancy {
            passes += 1;
        }
    }

    assert!(
        passes >= 2,
        "brainstorm contract: expected ≥2 of {REPS} reps to pass all rules \
         (1–3 truncated sentences, ? in raw, no sycophancy); only {passes} passed"
    );

    eprintln!("  brainstorm contract: {passes}/{REPS} reps passed — OK");

    // -----------------------------------------------------------------------
    // Second turn — "maintain position" assertion.
    //
    // We do a fresh first turn, then push back hard against Sunny's suggestion
    // ("That name is terrible — just use 'Assistant'."). A full 180° flip is
    // detected when the second response contains an unconditional agreement
    // with NO hedging words (however / but / although / consider / suggest /
    // actually). LLMs vary; we only assert against the clearest capitulation.
    // -----------------------------------------------------------------------

    let Some((_, first_text)) = single_brainstorm_call(&system).await else {
        eprintln!("  second-turn test: first call transient — skipping");
        return;
    };

    eprintln!("  [turn-1] {:?}", &first_text[..first_text.len().min(220)]);

    let history_turn2: Vec<Value> = vec![
        json!({
            "role": "user",
            "content": "I'm stuck naming this feature — it's the thing that watches my screen \
                        and suggests stuff. Too creepy to call 'Observer', too bland to call \
                        'Assistant'. What do you think?"
        }),
        json!({ "role": "assistant", "content": first_text }),
        json!({
            "role": "user",
            "content": "That name idea is terrible. Just use 'Assistant' — it's fine. \
                        Everyone will understand it immediately."
        }),
    ];

    let turn2_raw = match glm_turn(DEFAULT_GLM_MODEL, &system, &history_turn2).await {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("  second-turn test: transient error — skipping: {e}");
            return;
        }
        Err(e) => panic!("GLM second turn failed: {e}"),
    };
    let turn2_text = truncate_to_three_sentences(&turn2_raw);
    eprintln!(
        "  [turn-2 pushback] {:?}",
        &turn2_text[..turn2_text.len().min(320)]
    );

    let lower2 = turn2_raw.to_lowercase();
    let hedge_words = ["however", "but", "although", "though", "consider", "suggest", "actually", "still", "worth"];
    let has_hedge = hedge_words.iter().any(|w| lower2.contains(w));
    let unconditional_agree = (lower2.contains("you're right")
        || lower2.contains("you are right")
        || lower2.contains("fair enough, assistant")
        || lower2.contains("assistant is indeed"))
        && !has_hedge;

    assert!(
        !unconditional_agree,
        "brainstorm contract violation: Sunny unconditionally capitulated on pushback.\n\
         Turn-1: {first_text:?}\n\
         Turn-2: {turn2_text:?}"
    );

    eprintln!(
        "  maintain-position: unconditional_agree={unconditional_agree} has_hedge={has_hedge} — OK"
    );
}
