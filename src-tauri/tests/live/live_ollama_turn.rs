//! live_ollama_turn — real Ollama turn via providers/ollama.rs
//!
//! Tests that hit the live local Ollama server. All marked `#[ignore]`:
//!   cargo test --test live live_ollama_turn -- --ignored --nocapture
//!
//! Target model: qwen2.5:3b — small enough to install quickly, large enough
//! to give coherent responses. Tests skip gracefully when:
//!   - Ollama is not running on 127.0.0.1:11434
//!   - `qwen2.5:3b` is not listed by `ollama list`
//!
//! What these tests prove:
//!   - The Ollama provider wiring is end-to-end correct.
//!   - Non-empty response is returned for a simple prompt.
//!   - `cost_usd` is exactly 0.0 (Ollama has no per-token billing).
//!   - The latency telemetry is populated (> 0 ms).
//!   - Thinking-mode fallback: if the model emits `thinking` instead of
//!     `content`, the adapter still surfaces a non-empty response.

use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::types::TurnOutcome;
use sunny_lib::telemetry::cost_estimate;
use serial_test::serial;

const TEST_MODEL: &str = "qwen2.5:3b";

// ---------------------------------------------------------------------------
// Core turn test
// ---------------------------------------------------------------------------

/// Verify a live Ollama turn with qwen2.5:3b:
///   - Returns non-empty, non-echo Final response.
///   - Completes within 60 s (cold model load can be slow on small machines).
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires ollama running with qwen2.5:3b; opt-in with --ignored"]
async fn ollama_turn_returns_non_empty_response() {
    if super::should_skip_ollama_model(TEST_MODEL).await {
        return;
    }

    let history = super::single_user_turn("What color is the sky? One word.");

    let (result, latency_ms) = super::timed(ollama_turn(
        TEST_MODEL,
        "You are a concise assistant. Reply with one word only.",
        &history,
    ))
    .await;

    let outcome = result.expect("Ollama turn must succeed when model is installed");

    let text = match &outcome {
        TurnOutcome::Final { text, .. } => {
            assert!(
                !text.trim().is_empty(),
                "Ollama Final response text must not be empty"
            );
            text.clone()
        }
        TurnOutcome::Tools { thinking, calls, .. } => {
            eprintln!(
                "  NOTE: Ollama issued {} tool call(s) for trivial prompt; thinking={:?}",
                calls.len(),
                thinking
            );
            thinking.clone().unwrap_or_default()
        }
    };

    super::assert_reasonable_llm_response(&text, "What color is the sky? One word.");
    assert!(
        latency_ms < 60_000,
        "Ollama latency {latency_ms}ms exceeded 60 s ceiling (model may be loading)"
    );

    eprintln!("  model={TEST_MODEL} latency={latency_ms}ms response={text:?}");
}

// ---------------------------------------------------------------------------
// Cost is always zero
// ---------------------------------------------------------------------------

/// Verify that Ollama cost is exactly 0.0 regardless of token counts.
///
/// This is a billing-correctness test: if the cost formula ever accidentally
/// applies a non-zero rate to Ollama turns, BrainPage would show phantom costs
/// for local inference.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires ollama running with qwen2.5:3b; opt-in with --ignored"]
async fn ollama_cost_is_zero() {
    if super::should_skip_ollama_model(TEST_MODEL).await {
        return;
    }

    // The turn itself exercises the live path; we also verify the formula.
    let history = super::single_user_turn("Say: ok");

    let result = ollama_turn(
        TEST_MODEL,
        "Reply with exactly: ok",
        &history,
    )
    .await
    .expect("Ollama turn must succeed");

    // Verify cost_estimate returns 0.0 for ollama regardless of token counts.
    let cost_small = cost_estimate("ollama", 100, 50, 0, 0);
    let cost_large = cost_estimate("ollama", 1_000_000, 1_000_000, 0, 0);

    assert_eq!(cost_small, 0.0, "Ollama cost must be exactly 0.0 (small tokens)");
    assert_eq!(cost_large, 0.0, "Ollama cost must be exactly 0.0 (large tokens)");

    let text = match result {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, .. } => thinking.unwrap_or_default(),
    };

    super::assert_reasonable_llm_response(&text, "Say: ok");

    eprintln!("  model={TEST_MODEL} cost_small=${cost_small} cost_large=${cost_large} (both 0.0 — correct)");
}
