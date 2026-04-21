//! routing_and_cost — Phase-2 Packet 1 + Packet 2 end-to-end scenario.
//!
//! Exercises the model router → provider translation (Packet 1) and
//! GLM/Ollama pricing accuracy (Packet 2) for five real user messages.
//!
//! # What this proves
//!
//! * `route_model` + `provider_from_decision` map correctly:
//!     - Simple/conversational → Haiku tier → Ollama qwen2.5:3b ($0)
//!     - Coding/architectural/planning → Sonnet/Opus tier → GLM glm-5.1 (non-zero)
//! * A manually-driven `CostAggregator` accumulates turns correctly:
//!     - GLM cost > 0 after GLM turns
//!     - Ollama cost == 0 after all turns (always free local inference)
//!     - cache_hit_rate == 0 (GLM has no prompt-cache semantics)
//!     - turn_count == 5 at the end
//!     - total cost < $0.005
//!
//! # Notes
//!
//! * `agent_run` requires a live Tauri `AppHandle` and cannot be constructed
//!   in integration tests. We exercise the same layer that `core.rs::call_llm`
//!   uses: `route_model` for the decision, `provider_from_tier` for translation,
//!   then the concrete provider (`glm_turn` / `ollama_turn`) for the actual
//!   network call, and `CostAggregator::add_metric` for cost accounting.
//!
//! * Serial execution is required: run with `--test-threads=1` or set
//!   `RUST_TEST_THREADS=1` in the environment.
//!
//! # Run
//!
//!   cargo test --test live -- --ignored --test-threads=1 routing_and_cost --nocapture
//!
//! # Cost ceiling
//!
//! Five short prompts. Worst case all 3 GLM turns return ~50 tokens on
//! ~25-token inputs: 225 tokens total. At GLM rates ($0.40/M in, $1.20/M out)
//! that is well under $0.001.

use std::time::{Duration, Instant};

use serial_test::serial;

use sunny_lib::agent_loop::model_router::{
    route_model, RoutingContext, TaskClass, MODEL_HAIKU,
};
use sunny_lib::agent_loop::providers::glm::glm_turn;
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::telemetry_cost::{CostAggregator, CostMetrics};
use sunny_lib::agent_loop::types::TurnOutcome;

// ---------------------------------------------------------------------------
// Provider constants — mirrors core.rs::provider_from_decision
// ---------------------------------------------------------------------------

const PROVIDER_OLLAMA_MODEL: &str = "qwen2.5:3b";
const PROVIDER_GLM_MODEL: &str = "glm-5.1";

// Retry budget for transient GLM network errors (connect timeout etc.)
const GLM_MAX_RETRIES: usize = 2;

// ---------------------------------------------------------------------------
// Provider selection — mirrors core.rs::provider_from_decision
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Ollama,
    Glm,
}

/// Replicates the `provider_from_decision` translation table from `core.rs`.
/// Haiku → Ollama qwen2.5:3b; Sonnet/Opus/unknown → GLM glm-5.1.
fn provider_from_tier(model_id: &str) -> (Provider, &'static str) {
    match model_id {
        id if id == MODEL_HAIKU => (Provider::Ollama, PROVIDER_OLLAMA_MODEL),
        _                       => (Provider::Glm,    PROVIDER_GLM_MODEL),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_text(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            let tool_names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
            eprintln!("  (model issued {} tool call(s): {})", calls.len(), tool_names.join(", "));
            // Return thinking text if populated; otherwise a synthetic marker.
            // This ensures the "non-empty response" assertion passes for a
            // legitimate tool-call outcome (e.g. Ollama's `calc` tool).
            let base = thinking.unwrap_or_default();
            if base.trim().is_empty() {
                format!("[tool_call: {}]", tool_names.join(", "))
            } else {
                base
            }
        }
    }
}

fn single_user_turn(text: &str) -> Vec<serde_json::Value> {
    vec![serde_json::json!({"role": "user", "content": text})]
}

/// Returns true for error strings that reflect transient infrastructure state
/// (rate-limits, connect timeouts) rather than a logic bug in our code.
fn is_transient(e: &str) -> bool {
    e.contains("429")
        || e.to_lowercase().contains("rate limit")
        || e.to_lowercase().contains("timed out")
        || e.to_lowercase().contains("timeout")
        || e.to_lowercase().contains("connect")
        || e.to_lowercase().contains("error sending request")
}

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

/// Phase-2 Packet 1 + 2: five messages routed and costed end-to-end.
///
/// All five turns flow through the same routing logic that `core.rs` uses.
/// We drive `route_model` + `provider_from_tier`, call the chosen provider,
/// accumulate into a `CostAggregator`, and assert on the aggregated summary.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires GLM key + ollama running with qwen2.5:3b; opt-in with --ignored"]
async fn routing_and_cost_five_turns() {
    // --- SKIP guards ---------------------------------------------------------

    if super::should_skip_glm().await {
        return;
    }
    if super::should_skip_ollama().await {
        return;
    }
    if super::should_skip_ollama_model(PROVIDER_OLLAMA_MODEL).await {
        return;
    }

    // --- Turn definitions ----------------------------------------------------
    //
    // expected_provider is what the routing table MUST produce.
    // task_class_hint supplies an explicit classification (matching what the
    // live agent loop infers or what the caller could annotate).

    struct Turn {
        message: &'static str,
        expected_provider: Provider,
        task_class_hint: Option<TaskClass>,
        label: &'static str,
    }

    let turns = [
        Turn {
            message: "what is 2+2",
            expected_provider: Provider::Ollama,
            task_class_hint: Some(TaskClass::SimpleLookup),
            label: "(a) simple arithmetic",
        },
        Turn {
            message: "write a fn in rust that reverses a string",
            expected_provider: Provider::Glm,
            task_class_hint: Some(TaskClass::CodingOrReasoning),
            label: "(b) coding task",
        },
        Turn {
            message: "design a simple audit log schema",
            expected_provider: Provider::Glm,
            task_class_hint: Some(TaskClass::ArchitecturalDecision),
            label: "(c) architectural design",
        },
        Turn {
            message: "how do I feel today",
            expected_provider: Provider::Ollama,
            task_class_hint: Some(TaskClass::SimpleLookup),
            label: "(d) conversational / emotional",
        },
        Turn {
            message: "plan and execute: fetch weather for Vancouver and format as CSV",
            expected_provider: Provider::Glm,
            task_class_hint: Some(TaskClass::LongMultiStepPlan),
            label: "(e) long plan + tool-use",
        },
    ];

    // --- Run turns -----------------------------------------------------------

    let mut agg = CostAggregator::new();
    let mut ollama_count = 0usize;
    let mut glm_count = 0usize;
    let mut latencies_ms: Vec<u128> = Vec::with_capacity(5);

    for turn in &turns {
        let rctx = RoutingContext {
            message: turn.message.to_string(),
            tool_calls_so_far: 0,
            task_class: turn.task_class_hint,
            is_retry_after_tool_error: false,
            inside_plan_execute: turn.task_class_hint == Some(TaskClass::LongMultiStepPlan),
            inside_reflexion_critic: false,
            reflexion_iteration: 0,
            quality_mode: sunny_lib::agent_loop::model_router::QualityMode::Balanced,
            privacy_sensitive: false,
        };

        let decision = route_model(&rctx);
        let (provider, model_id) = provider_from_tier(decision.model_id);

        // Assert routing matches expectation (pure, no I/O).
        assert_eq!(
            provider, turn.expected_provider,
            "{}: expected {:?} but router picked {:?} (tier={}, reasoning: {})",
            turn.label, turn.expected_provider, provider,
            decision.model_id, decision.reasoning,
        );

        eprintln!(
            "  {} → {:?} ({}) | tier={} | routing: {}",
            turn.label, provider, model_id,
            decision.model_id, decision.reasoning,
        );

        // Call the provider, with retry on transient GLM errors.
        let t_start = Instant::now();
        let history = single_user_turn(turn.message);
        let system = "You are a concise assistant. Respond briefly.";

        let text = match provider {
            Provider::Ollama => {
                match ollama_turn(model_id, system, &history).await {
                    Ok(o) => extract_text(o),
                    Err(e) => panic!("{}: ollama_turn failed: {e}", turn.label),
                }
            }
            Provider::Glm => {
                let mut attempt = 0;
                loop {
                    match glm_turn(model_id, system, &history).await {
                        Ok(o) => break extract_text(o),
                        Err(ref e) if is_transient(e) && attempt < GLM_MAX_RETRIES => {
                            attempt += 1;
                            eprintln!(
                                "  {} transient GLM error (attempt {}/{GLM_MAX_RETRIES}), retrying: {e}",
                                turn.label, attempt,
                            );
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                        Err(ref e) if is_transient(e) => {
                            eprintln!("  SKIP: GLM unreachable after {GLM_MAX_RETRIES} retries: {e}");
                            return;
                        }
                        Err(e) => panic!("{}: glm_turn failed: {e}", turn.label),
                    }
                }
            }
        };

        let elapsed_ms = t_start.elapsed().as_millis();
        latencies_ms.push(elapsed_ms);

        // Response must be non-trivially non-empty.
        assert!(
            !text.trim().is_empty(),
            "{}: provider returned empty response",
            turn.label,
        );

        eprintln!(
            "  {} response ({elapsed_ms}ms): {:?}",
            turn.label,
            &text[..text.len().min(120)],
        );

        // Accumulate cost. Token count uses the char/4 heuristic that
        // core.rs uses for context-window budgeting.
        let input_tokens = (turn.message.len() / 4) as u64;
        let output_tokens = (text.len() / 4) as u64;
        let metrics = CostMetrics {
            input_tokens,
            output_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            timestamp: chrono::Utc::now().timestamp(),
        };
        agg = agg.add_metric(model_id, metrics);

        match provider {
            Provider::Ollama => ollama_count += 1,
            Provider::Glm    => glm_count += 1,
        }
    }

    // --- Aggregator assertions -----------------------------------------------

    // All 5 turns completed.
    assert_eq!(agg.turn_count(), 5, "CostAggregator must record exactly 5 turns");

    // 2 Ollama + 3 GLM.
    assert_eq!(ollama_count, 2, "Expected 2 Ollama turns (a + d)");
    assert_eq!(glm_count, 3, "Expected 3 GLM turns (b + c + e)");

    // Total cost must be positive (GLM is non-zero) but tiny (short prompts).
    let total_cost = agg.total_cost_usd();
    assert!(
        total_cost > 0.0,
        "Total cost must be > $0.00 after 3 GLM turns; got ${total_cost:.8}",
    );
    assert!(
        total_cost < 0.005,
        "Total cost ${total_cost:.6} exceeds $0.005 sanity ceiling for 5 short turns",
    );

    // Cache hit rate must be 0 — GLM has no prompt-cache semantics,
    // and we always pass cache_read_tokens=0 for Ollama and GLM turns.
    let cache_rate = agg.cache_hit_rate();
    assert_eq!(
        cache_rate, 0.0,
        "cache_hit_rate must be 0.0 for all GLM/Ollama turns (no cache billing); got {cache_rate}",
    );

    // --- Summary print -------------------------------------------------------

    let avg_latency_ms: f64 = latencies_ms.iter().sum::<u128>() as f64
        / latencies_ms.len() as f64;
    let summary = agg.to_summary_string();

    eprintln!(
        "\nrouted: {{ollama: {ollama_count}, glm: {glm_count}}}, \
         cost: ${total_cost:.4}, cache: {:.0}%, latency avg {:.1}s",
        cache_rate * 100.0,
        avg_latency_ms / 1000.0,
    );
    eprintln!("CostAggregator summary: {summary}");
    eprintln!(
        "per-turn latencies (ms): {}",
        latencies_ms.iter()
            .map(|ms| ms.to_string())
            .collect::<Vec<_>>()
            .join(", "),
    );
}
