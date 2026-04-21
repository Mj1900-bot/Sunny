//! longevity_24h_synthetic — 1000-turn synthetic stress test (no real LLM calls).
//!
//! Mix: 70% normal, 10% error, 10% loop-bait, 5% ctx-pressure, 5% cost-spike.
//! Run: cargo test --test live longevity_24h_synthetic --nocapture

use std::time::Instant;

use sunny_lib::agent_loop::context_window::truncate_history;
use sunny_lib::agent_loop::core::{
    next_state, AgentEvent, AgentState, DEFAULT_CONTEXT_BUDGET_TOKENS,
};
use sunny_lib::agent_loop::critic::trigger::{arg_hash, detect_loop, ToolRecord};
use sunny_lib::agent_loop::model_router::{route_model, RoutingContext, TaskClass, MODEL_HAIKU};
use sunny_lib::agent_loop::telemetry_cost::{CostAggregator, CostMetrics};
use sunny_lib::agent_loop::types::TurnOutcome;
use sunny_lib::continuity_store::{ContinuityStore, NodeKind};

use super::support::fake_provider::{FakeProvider, ScriptedToolCall, ScriptedTurn};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_TURNS: usize = 1_000;
const RNG_SEED: u64 = 0xDEAD_BEEF_1234_5678;
const CONTEXT_BUDGET: usize = DEFAULT_CONTEXT_BUDGET_TOKENS as usize;

// Cumulative turn-mix thresholds (out of 100)
const NORMAL_PCT: u32 = 70;
const ERROR_PCT: u32 = 80;  // 10% error   (70..80)
const LOOP_PCT: u32 = 90;   // 10% loop    (80..90)
const CTXP_PCT: u32 = 95;   // 5%  ctx-pressure (90..95)
                             // 5%  cost-spike   (95..100)

const LOOP_BAIT_TOOL: &str = "web_search";
const LOOP_BAIT_ARGS: &str = r#"{"q":"loop_bait_query"}"#;
const MAX_MEMORY_DELTA_BYTES: i64 = 50 * 1024 * 1024; // 50 MB
const MIN_LOOP_FIRES: usize = 30;

// ---------------------------------------------------------------------------
// Minimal seeded LCG PRNG (no external rand crate needed)
// ---------------------------------------------------------------------------

struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self { Self(seed) }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn next_pct(&mut self) -> u32 { (self.next_u64() % 100) as u32 }
    fn bool_pct(&mut self, p: u32) -> bool { self.next_pct() < p }
}

// ---------------------------------------------------------------------------
// Memory snapshot via libc getrusage (macOS: ru_maxrss in bytes)
// ---------------------------------------------------------------------------

fn rss_bytes() -> i64 {
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut ru);
        ru.ru_maxrss
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normal_provider(rng: &mut Lcg) -> FakeProvider {
    if rng.bool_pct(50) {
        FakeProvider::new(vec![ScriptedTurn::Final("Synthetic response.".to_string())])
    } else {
        FakeProvider::new(vec![
            ScriptedTurn::Tools(vec![ScriptedToolCall::new(
                "read_file",
                serde_json::json!({ "path": "/tmp/sunny_test.txt" }),
            )]),
            ScriptedTurn::Final("Tool result processed.".to_string()),
        ])
    }
}

fn run_mini_session(provider: &mut FakeProvider) -> (bool, bool) {
    let mut state = AgentState::Preparing;
    for _ in 0..50 {
        let event = match state {
            AgentState::Preparing => AgentEvent::PreparationDone,
            AgentState::CallingLLM { .. } => {
                if provider.is_exhausted() {
                    AgentEvent::BackendFailed { error: "exhausted".to_string(), partial: String::new() }
                } else {
                    match provider.next_turn() {
                        TurnOutcome::Final { text, .. } => AgentEvent::FinalAnswer { text, streamed: false },
                        TurnOutcome::Tools { .. } => AgentEvent::ToolsRequested,
                    }
                }
            }
            AgentState::DispatchingTools { .. } => AgentEvent::ToolsDispatched,
            AgentState::ToolsResolved { .. } => AgentEvent::PreparationDone,
            AgentState::Finalizing { ref draft, .. } => {
                AgentEvent::FinalizationDone { text: draft.clone() }
            }
            AgentState::Complete { .. } => return (true, false),
            AgentState::Aborted { .. } => return (false, true),
        };
        state = next_state(state, event);
    }
    (false, true)
}

fn run_error_session() -> (bool, bool) {
    // Simulates: first LLM call returns transient error (Aborted), then retry succeeds.
    let mut provider = FakeProvider::new(vec![
        ScriptedTurn::Final("Fallback after simulated error.".to_string()),
    ]);
    let mut state = AgentState::Preparing;
    let mut errored = false;
    for _ in 0..20 {
        let event = match state {
            AgentState::Preparing => AgentEvent::PreparationDone,
            AgentState::CallingLLM { .. } => {
                if !errored {
                    errored = true;
                    AgentEvent::BackendFailed {
                        error: "transient_glm_timeout".to_string(),
                        partial: String::new(),
                    }
                } else if !provider.is_exhausted() {
                    match provider.next_turn() {
                        TurnOutcome::Final { text, .. } => AgentEvent::FinalAnswer { text, streamed: false },
                        TurnOutcome::Tools { .. } => AgentEvent::ToolsRequested,
                    }
                } else {
                    AgentEvent::BackendFailed { error: "exhausted".to_string(), partial: String::new() }
                }
            }
            AgentState::DispatchingTools { .. } => AgentEvent::ToolsDispatched,
            AgentState::ToolsResolved { .. } => AgentEvent::PreparationDone,
            AgentState::Finalizing { ref draft, .. } => {
                AgentEvent::FinalizationDone { text: draft.clone() }
            }
            AgentState::Aborted { .. } => {
                // Retry: restart from Preparing
                state = AgentState::Preparing;
                AgentEvent::PreparationDone
            }
            AgentState::Complete { .. } => return (true, false),
        };
        state = next_state(state, event);
    }
    (false, true)
}

// ---------------------------------------------------------------------------
// Main longevity test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn longevity_24h_synthetic() {
    let wall_start = Instant::now();
    let mem_before = rss_bytes();
    let mut rng = Lcg::new(RNG_SEED);

    let mut agg = CostAggregator::new();
    let mut loop_fires: usize = 0;
    let mut tool_history: Vec<ToolRecord> = Vec::new();
    let mut conv_history: Vec<serde_json::Value> = Vec::new();
    let mut panic_count: usize = 0;

    let tmp_dir = tempfile::TempDir::new().expect("temp dir for continuity store");
    let store = ContinuityStore::open(tmp_dir.path()).expect("open continuity store");

    use sunny_lib::autopilot::Governor;
    let gov_dir = tempfile::TempDir::new().expect("temp dir for governor");
    let governor = Governor::new_for_test(gov_dir.path().to_path_buf());

    for turn in 0..TOTAL_TURNS {
        let pct = rng.next_pct();

        let result = if pct < NORMAL_PCT {
            // 70% normal
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut p = normal_provider(&mut rng);
                run_mini_session(&mut p)
            }))
        } else if pct < ERROR_PCT {
            // 10% error: transient failure → retry
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(run_error_session))
        } else if pct < LOOP_PCT {
            // 10% loop-bait: 3 identical tool calls → detect_loop fires
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let hash = arg_hash(LOOP_BAIT_ARGS);
                for _ in 0..3 {
                    tool_history.push(ToolRecord {
                        name: LOOP_BAIT_TOOL.to_string(),
                        arg_hash: hash,
                    });
                }
                let fired = detect_loop(&tool_history);
                tool_history.clear();
                (fired, false)
            }))
        } else if pct < CTXP_PCT {
            // 5% context-pressure: 5k-token tool output → truncation
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let fat = "x".repeat(20_000); // ~5k tokens
                conv_history.push(serde_json::json!({"role":"user","content":"process this"}));
                conv_history.push(serde_json::json!({"role":"assistant","content":[{
                    "type":"tool_use","id":"fat","name":"read_file","input":{"path":"/big.txt"}
                }]}));
                conv_history.push(serde_json::json!({"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"fat","content": fat
                }]}));
                let truncated = truncate_history(conv_history.clone(), 0, CONTEXT_BUDGET);
                let chars: usize = truncated
                    .iter()
                    .map(|m| serde_json::to_string(m).unwrap_or_default().len())
                    .sum();
                assert!(
                    chars <= 4 * CONTEXT_BUDGET,
                    "context overflow: {chars} chars > {} (budget={CONTEXT_BUDGET} tokens)",
                    4 * CONTEXT_BUDGET
                );
                conv_history.clear();
                (true, false)
            }))
        } else {
            // 5% cost-spike: high-cost turn stresses governor ledger
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let m = CostMetrics {
                    input_tokens: 10_000, output_tokens: 5_000,
                    cache_read_tokens: 0, cache_creation_tokens: 0,
                    timestamp: chrono::Utc::now().timestamp(),
                };
                agg = agg.clone().add_metric("claude-sonnet-4-6", m);
                let _ = governor.charge_glm(0.05); // may refuse — that's fine
                let snap = governor.snapshot();
                assert!(snap.daily_glm_cost_usd >= 0.0, "ledger negative: {}", snap.daily_glm_cost_usd);
                assert!(snap.daily_glm_cap_usd > 0.0, "cap <= 0: {}", snap.daily_glm_cap_usd);
                (true, false)
            }))
        };

        match result {
            Err(_) => panic_count += 1,
            Ok((fired, _)) => {
                if pct >= 80 && pct < LOOP_PCT && fired { loop_fires += 1; }
            }
        }

        // Per-turn cost accumulation for non-spike turns
        if pct < CTXP_PCT {
            let m = CostMetrics {
                input_tokens: 200 + rng.next_u64() % 800,
                output_tokens: 50 + rng.next_u64() % 200,
                cache_read_tokens: 0, cache_creation_tokens: 0,
                timestamp: chrono::Utc::now().timestamp(),
            };
            agg = agg.clone().add_metric("claude-haiku-4-5", m);
        }

        // Per-turn summary stability check
        let summary = agg.to_summary_string();
        assert!(!summary.contains("NaN") && !summary.contains("inf"),
            "unstable summary at turn {turn}: {summary}");

        // Every 100 turns: persist continuity node + print progress line
        if (turn + 1) % 100 == 0 {
            let cost = agg.total_cost_usd();
            let mem_mb = (rss_bytes() - mem_before) as f64 / (1024.0 * 1024.0);
            let _ = store.upsert_node(
                NodeKind::Session,
                &format!("longevity-{}", turn + 1),
                &format!("Longevity turn {}", turn + 1),
                &format!("cost=${cost:.4} loop_fires={loop_fires}"),
                &["#longevity"],
            );
            eprintln!(
                "turn={:<4} cost=${:.4} mem={:.1}MB loop_fires={} elapsed={:.1}s",
                turn + 1, cost, mem_mb, loop_fires, wall_start.elapsed().as_secs_f64(),
            );
        }
    }

    // -----------------------------------------------------------------------
    // Final assertions
    // -----------------------------------------------------------------------

    let mem_delta = rss_bytes() - mem_before;
    let elapsed = wall_start.elapsed().as_secs_f64();
    let total_cost = agg.total_cost_usd();
    let final_summary = agg.to_summary_string();

    eprintln!(
        "\n=== longevity_24h_synthetic FINAL REPORT ===\n\
         seed={RNG_SEED:#x} turns={TOTAL_TURNS} runtime={elapsed:.2}s \
         panics={panic_count} loop_fires={loop_fires} \
         mem_delta={:.1}MB cost=${total_cost:.6}\n{final_summary}",
        mem_delta as f64 / (1024.0 * 1024.0),
    );

    assert_eq!(panic_count, 0, "caught {panic_count} panics");
    assert!(mem_delta < MAX_MEMORY_DELTA_BYTES,
        "memory grew {:.1}MB, limit 50MB", mem_delta as f64 / (1024.0 * 1024.0));
    assert!(!final_summary.contains("NaN") && !final_summary.contains("inf"),
        "unstable final summary: {final_summary}");
    assert!(total_cost.is_finite() && total_cost >= 0.0,
        "total cost invalid: {total_cost}");
    assert!(loop_fires >= MIN_LOOP_FIRES,
        "loop-detection fired {loop_fires}×; expected >= {MIN_LOOP_FIRES}");
    let snap = governor.snapshot();
    assert!(snap.daily_glm_cost_usd.is_finite() && snap.daily_glm_cost_usd >= 0.0,
        "governor ledger invalid: {}", snap.daily_glm_cost_usd);

    let ctx = RoutingContext {
        message: "what time is it".to_string(),
        tool_calls_so_far: 0,
        task_class: Some(TaskClass::SimpleLookup),
        is_retry_after_tool_error: false,
        inside_plan_execute: false,
        inside_reflexion_critic: false,
        reflexion_iteration: 0,
        quality_mode: sunny_lib::agent_loop::model_router::QualityMode::Balanced,
        privacy_sensitive: false,
    };
    assert_eq!(route_model(&ctx).model_id, MODEL_HAIKU,
        "model router regressed after stress");
}
