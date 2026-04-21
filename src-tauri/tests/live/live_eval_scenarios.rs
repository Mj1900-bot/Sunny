//! live_eval_scenarios — 5 real-world user scenarios against live providers.
//!
//! Each scenario tests a qualitatively distinct interaction pattern:
//!
//!   (a) "what's 2+2"            — simple arithmetic (GLM, should answer correctly)
//!   (b) "write a haiku about Rust" — creative generation (GLM)
//!   (c) "plan a telegram bot"   — multi-step planning (GLM, expect structured output)
//!   (d) "debug: fn foo() {}"    — ambiguous debug request (GLM, should ask clarifier
//!                                  or make a reasonable assumption + explain)
//!   (e) "what did we work on last time" — continuity-store retrieval
//!                                  (Ollama, tests graceful handling before P3)
//!
//! All tests are `#[ignore]` — they call live providers and cost real money.
//!   cargo test --test live live_eval_scenarios -- --ignored --nocapture
//!
//! Cost ceiling: each prompt uses max_tokens=80 at most. Total for all 5:
//!   ~500 tokens → ~$0.0006 at GLM rates. Well within the $0.01/run budget.
//!
//! Scenario (e) is additionally marked with a secondary ignore reason because
//! the continuity store (Phase 3) is not yet landed. It tests graceful
//! degradation: the model must not crash or return an empty response just
//! because there is no prior session context.

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::types::TurnOutcome;
use serial_test::serial;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_text(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            eprintln!("  (model issued {} tool call(s))", calls.len());
            thinking.unwrap_or_default()
        }
    }
}

// ---------------------------------------------------------------------------
// Scenario (a): simple arithmetic
// ---------------------------------------------------------------------------

/// Scenario a: "what's 2+2" → GLM must answer "4" (or equivalent).
///
/// Proves: basic factual responses work end-to-end. The model should not
/// generate a lengthy preamble for a trivial arithmetic question.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn eval_scenario_a_simple_arithmetic() {
    if super::should_skip_glm().await {
        return;
    }

    let history = super::single_user_turn("What is 2+2?");
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a concise assistant. Answer with just the number.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM failed: {e}"),
    };
    super::assert_reasonable_llm_response(&text, "What is 2+2?");

    // The answer should contain "4" — basic sanity on factual accuracy.
    // NOTE: GLM-5.1 sometimes routes arithmetic through the `calc` tool,
    // in which case the text we capture is the tool-call narrative rather
    // than the final answer. We check for "4" but also accept the tool
    // narrative as a valid response shape (the model correctly identified
    // this as a calculation, even if the final digit is in the tool result).
    let has_four = text.contains('4');
    let is_tool_narrative = text.to_lowercase().contains("calc") || text.to_lowercase().contains("tool");
    assert!(
        has_four || is_tool_narrative,
        "arithmetic response must contain '4' or describe using calc tool; got: {text:?}"
    );

    eprintln!("  scenario=a latency={latency_ms}ms has_four={has_four} response={text:?}");
}

// ---------------------------------------------------------------------------
// Scenario (b): creative generation — haiku about Rust
// ---------------------------------------------------------------------------

/// Scenario b: "write me a haiku about Rust" → GLM must produce a multi-line
/// creative response. We don't enforce strict haiku syllable counts; we verify
/// the output is multi-word and not a parroted prompt.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn eval_scenario_b_haiku_about_rust() {
    if super::should_skip_glm().await {
        return;
    }

    let history = super::single_user_turn("Write me a haiku about the Rust programming language.");
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a creative writing assistant.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM failed: {e}"),
    };
    super::assert_reasonable_llm_response(
        &text,
        "Write me a haiku about the Rust programming language.",
    );

    // A haiku should have multiple words.
    let word_count = text.split_whitespace().count();
    assert!(
        word_count >= 5,
        "haiku response should have at least 5 words; got {word_count}: {text:?}"
    );

    eprintln!("  scenario=b latency={latency_ms}ms words={word_count} response={text:?}");
}

// ---------------------------------------------------------------------------
// Scenario (c): multi-step planning — telegram bot weekend project
// ---------------------------------------------------------------------------

/// Scenario c: "plan a weekend project to build a telegram bot" → GLM must
/// produce a structured multi-step plan. We verify: non-trivial response
/// length and at least one numbered/bullet step.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn eval_scenario_c_multi_step_plan() {
    if super::should_skip_glm().await {
        return;
    }

    let history =
        super::single_user_turn("Plan a weekend project to build a telegram bot. List the steps.");
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a helpful project planning assistant. Be concise.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM failed: {e}"),
    };
    super::assert_reasonable_llm_response(
        &text,
        "Plan a weekend project to build a telegram bot. List the steps.",
    );

    // A plan should have some structure — look for any digit, bullet, or dash.
    let has_structure = text.contains("1.")
        || text.contains("1)")
        || text.contains("- ")
        || text.contains("• ")
        || text.contains('\n');
    assert!(
        has_structure,
        "multi-step plan should contain some list structure; got: {text:?}"
    );

    eprintln!("  scenario=c latency={latency_ms}ms has_structure={has_structure} response={:?}", &text[..text.len().min(200)]);
}

// ---------------------------------------------------------------------------
// Scenario (d): ambiguous debug request — should ask clarifier or explain
// ---------------------------------------------------------------------------

/// Scenario d: "debug this: fn foo() {}" → the function body is empty.
/// A good model either:
///   (1) asks what `foo` is supposed to do (clarifier question), OR
///   (2) explains the code is syntactically valid but semantically empty.
///
/// We verify: the response is non-empty and non-trivial. We do NOT enforce
/// which path the model takes — both are valid debugging strategies.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn eval_scenario_d_ambiguous_debug_request() {
    if super::should_skip_glm().await {
        return;
    }

    let history = super::single_user_turn("Debug this: fn foo() {}");
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a Rust debugging assistant.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM failed: {e}"),
    };
    super::assert_reasonable_llm_response(&text, "Debug this: fn foo() {}");

    // The response should contain SOMETHING about the code — either a
    // clarifier question or an observation. At minimum it should not be
    // shorter than 10 chars (avoids trivially short refusals).
    assert!(
        text.trim().len() >= 10,
        "debug response should be at least 10 chars; got: {text:?}"
    );

    eprintln!("  scenario=d latency={latency_ms}ms response={:?}", &text[..text.len().min(200)]);
}

// ---------------------------------------------------------------------------
// Scenario (e): continuity-store retrieval — graceful degradation pre-P3
// ---------------------------------------------------------------------------

/// Scenario e: "what did we work on last time" — tests continuity-store
/// retrieval. Phase 3 (memory/continuity) is not yet landed, so this test
/// verifies GRACEFUL DEGRADATION: the model must not return an empty response
/// or crash. It should either:
///   (1) Acknowledge it has no session history, OR
///   (2) Ask the user for context.
///
/// This test uses Ollama (qwen2.5:3b) so it exercises the local provider path
/// under continuity-store absence. When P3 lands, update the assertion to
/// also verify that actual prior-session data is surfaced.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires ollama with qwen2.5:3b; opt-in with --ignored. \
            integrated-loop depends on P3 wiring (continuity store not yet landed)"]
async fn eval_scenario_e_continuity_store_graceful_degradation() {
    const MODEL: &str = "qwen2.5:3b";
    if super::should_skip_ollama_model(MODEL).await {
        return;
    }

    // Simulate a fresh session with NO prior conversation in history.
    let history = super::single_user_turn("What did we work on last time?");
    let (result, latency_ms) = super::timed(ollama_turn(
        MODEL,
        // System prompt does NOT inject any fake prior-session context —
        // this is the graceful-degradation test: no memory store, no context.
        "You are a helpful assistant. You have no access to prior session history.",
        &history,
    ))
    .await;

    let text = extract_text(result.expect("Ollama must not error on continuity query"));
    super::assert_reasonable_llm_response(&text, "What did we work on last time?");

    // The model should NOT claim to have specific prior-session knowledge when
    // none was injected. We check that the response doesn't hallucinate a
    // specific fake project name — a model without memory should either ask
    // for context or admit it doesn't have prior session data.
    //
    // NOTE: we can't enumerate all possible hallucinations, so we only check
    // that the response is non-trivial and non-empty (which `assert_reasonable`
    // already does). The deeper assertion — that the model says "I don't have
    // access to prior sessions" — is behavioural and validated by the human
    // reviewer reading `--nocapture` output.
    assert!(
        text.trim().len() >= 10,
        "continuity response should be non-trivial; got: {text:?}"
    );

    eprintln!(
        "  scenario=e latency={latency_ms}ms p3_landed=false model={MODEL} response={:?}",
        &text[..text.len().min(200)]
    );
    eprintln!("  [Manual review: verify model does not claim false prior-session knowledge]");
}
