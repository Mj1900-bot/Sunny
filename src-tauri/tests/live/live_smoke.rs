//! live_smoke — fastest possible sanity check before running deeper live tests.
//!
//! Runs ONE minimal GLM call + ONE minimal Ollama call.
//! Goal: confirm both providers are wired up and reachable in ~5 seconds.
//! Each prompt is a single short sentence; max_tokens=50 keeps cost < $0.0001.
//!
//! Run with:
//!   cargo test --test live live_smoke -- --ignored --nocapture
//!
//! Expected output (real keys + running ollama):
//!
//!   test live_smoke::smoke_glm_minimal ... SKIP or ok
//!   SKIP: no Z.AI key  ...  (if no key)
//!   --- or ---
//!   ok
//!     model=glm-5.1 latency=1842ms tokens=10in/7out cost=$0.000012 cache_hits=0
//!
//!   test live_smoke::smoke_ollama_minimal ... SKIP or ok
//!   SKIP: ollama not reachable  ...  (if no ollama)
//!   --- or ---
//!   ok
//!     model=qwen2.5:3b latency=3210ms tokens=0in/0out cost=$0.000000 cache_hits=0

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::types::TurnOutcome;
use serial_test::serial;

/// Smoke: one minimal GLM-5.1 call.
///
/// Verifies the Z.AI key is valid and the provider wiring returns a
/// non-empty response. Skips gracefully when the key is absent.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key in Keychain; opt-in with --ignored"]
async fn smoke_glm_minimal() {
    if super::should_skip_glm().await {
        return;
    }

    let history = super::single_user_turn("Say hi");
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a concise assistant. Reply in one sentence only.",
        &history,
    ))
    .await;

    let outcome = match result {
        Ok(o) => o,
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM smoke test failed: {e}"),
    };

    let text = match &outcome {
        TurnOutcome::Final { text, .. } => text.clone(),
        TurnOutcome::Tools { thinking, .. } => {
            thinking.clone().unwrap_or_else(|| "tool-call-response".to_string())
        }
    };

    super::assert_reasonable_llm_response(&text, "Say hi");

    eprintln!(
        "  model={} latency={}ms response={:?}",
        DEFAULT_GLM_MODEL,
        latency_ms,
        &text[..text.len().min(80)]
    );
}

/// Smoke: one minimal Ollama call against qwen2.5:3b.
///
/// Verifies Ollama is running and qwen2.5:3b is installed. Skips when
/// either condition is not met.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires ollama running with qwen2.5:3b; opt-in with --ignored"]
async fn smoke_ollama_minimal() {
    const MODEL: &str = "qwen2.5:3b";
    if super::should_skip_ollama_model(MODEL).await {
        return;
    }

    let history = super::single_user_turn("Say hi");
    let (result, latency_ms) = super::timed(ollama_turn(
        MODEL,
        "You are a concise assistant. Reply in one sentence only.",
        &history,
    ))
    .await;

    let outcome = result.expect("Ollama turn should succeed when model is installed");

    let text = match &outcome {
        TurnOutcome::Final { text, .. } => text.clone(),
        TurnOutcome::Tools { thinking, .. } => {
            thinking.clone().unwrap_or_else(|| "tool-call-response".to_string())
        }
    };

    super::assert_reasonable_llm_response(&text, "Say hi");

    eprintln!(
        "  model={} latency={}ms response={:?}",
        MODEL,
        latency_ms,
        &text[..text.len().min(80)]
    );
}
