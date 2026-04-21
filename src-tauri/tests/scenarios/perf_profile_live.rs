//! perf_profile_live — event-bus wiring validation for [`PerfProfiler`].
//!
//! Proves PerfProfiler::new() actually receives events from the broadcast bus
//! by bracketing 5 real LLM turns (2 Ollama + 3 GLM) with the AgentStep /
//! ChatChunk envelope the real agent loop emits, then asserting per-model
//! latency stats are non-trivial.  Zero turns after 5 fired → HARD FAIL.
//!
//!   cargo test --test live -- --ignored perf_profile_live --nocapture

use std::time::Duration;

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::event_bus::{publish, SunnyEvent};
use sunny_lib::perf_profile::PerfProfiler;
use serial_test::serial;
use serde_json::json;

const OLLAMA_MODEL: &str = "qwen2.5:3b";
const GLM_MODEL: &str = DEFAULT_GLM_MODEL;
const SYSTEM: &str = "You are a concise assistant. One sentence only.";

async fn has_glm_key() -> bool {
    for v in &["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY"] {
        if std::env::var(v).map(|s| !s.trim().is_empty()).unwrap_or(false) {
            return true;
        }
    }
    sunny_lib::secrets::zai_api_key().await.is_some()
}

async fn has_ollama(model: &str) -> bool {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2))
        .build().unwrap_or_default();
    let body: serde_json::Value = match client
        .get("http://127.0.0.1:11434/api/tags").send().await {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        _ => return false,
    };
    body["models"].as_array().map(|a| a.iter()
        .filter_map(|e| e["name"].as_str())
        .any(|n| n == model || n.starts_with(&format!("{model}:")))).unwrap_or(false)
}

/// Publish AgentStep{iteration:0} to seed the profiler's InFlight before LLM.
fn begin_turn(turn_id: &str, at: i64) {
    publish(SunnyEvent::AgentStep {
        seq: 0, boot_epoch: 0,
        turn_id: turn_id.to_string(), iteration: 0,
        text: String::new(), tool: None, at,
    });
}

/// Publish delta + done ChatChunk frames.  Yields between them so the
/// subscriber records first_token_at before seeing the done frame.
async fn end_turn(turn_id: &str, delta: &str) {
    let at = chrono::Utc::now().timestamp_millis();
    publish(SunnyEvent::ChatChunk {
        seq: 0, boot_epoch: 0, turn_id: turn_id.to_string(),
        delta: delta.to_string(), done: false, at,
    });
    tokio::time::sleep(Duration::from_millis(5)).await;
    publish(SunnyEvent::ChatChunk {
        seq: 0, boot_epoch: 0, turn_id: turn_id.to_string(),
        delta: String::new(), done: true, at: chrono::Utc::now().timestamp_millis(),
    });
}

fn assert_profile(p: &sunny_lib::perf_profile::LatencyProfile, label: &str) {
    assert!(p.turns_observed >= 1, "{label} turns_observed < 1");
    assert!(p.ttft_p50 > 0.0,  "{label} ttft_p50={} must be > 0", p.ttft_p50);
    assert!(p.total_p50 >= p.ttft_p50,
        "{label} total_p50({}) must be >= ttft_p50({})", p.total_p50, p.ttft_p50);
    assert!(p.ttft_p95 >= p.ttft_p50,
        "{label} ttft_p95({}) must be >= ttft_p50({})", p.ttft_p95, p.ttft_p50);
    assert!(p.total_p95 >= p.total_p50,
        "{label} total_p95({}) must be >= total_p50({})", p.total_p95, p.total_p50);
}

#[tokio::test]
#[ignore = "live — requires ollama qwen2.5:3b + Z.AI key; opt-in with --ignored"]
#[serial(live_llm)]
async fn perf_profile_live_event_bus_wiring() {
    let skip_ollama = !has_ollama(OLLAMA_MODEL).await;
    let skip_glm    = !has_glm_key().await;
    if skip_ollama && skip_glm {
        eprintln!("SKIP: neither ollama({OLLAMA_MODEL}) nor GLM key available"); return;
    }

    // Init event bus in a tempdir (ignore Err if already inited by another test).
    let tmp = std::env::temp_dir()
        .join(format!("sunny-perf-live-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&tmp).expect("tempdir");
    let _ = sunny_lib::event_bus::init_in(&tmp);

    let profiler = PerfProfiler::new();
    // Give the subscriber loop time to subscribe (it polls at 100 ms intervals).
    tokio::time::sleep(Duration::from_millis(150)).await;

    let sys = SYSTEM;
    let mut ollama_ok = 0u32;
    let mut glm_ok    = 0u32;

    macro_rules! fire {
        ($skip:expr, $model:expr, $provider:expr, $hist:expr, $delta:expr, $counter:expr) => {
            if !$skip {
                let at = chrono::Utc::now().timestamp_millis();
                let tid = format!("perf-{}-{at}", $provider);
                begin_turn(&tid, at);
                match { $hist } {
                    Ok(_) => { end_turn(&tid, $delta).await; $counter += 1; }
                    Err(ref e) if e.contains("429") || e.to_lowercase().contains("rate limit") =>
                        eprintln!("  {} rate-limited", $provider),
                    Err(e) => eprintln!("  {} failed: {e}", $provider),
                }
            }
        };
    }

    fire!(skip_ollama, OLLAMA_MODEL, "ollama-1",
        ollama_turn(OLLAMA_MODEL, sys, &[json!({"role":"user","content":"hi"})]).await,
        "hi", ollama_ok);
    fire!(skip_ollama, OLLAMA_MODEL, "ollama-2",
        ollama_turn(OLLAMA_MODEL, sys, &[json!({"role":"user","content":"2+2?"})]).await,
        "4", ollama_ok);
    fire!(skip_glm, GLM_MODEL, "glm-1",
        glm_turn(GLM_MODEL, sys, &[json!({"role":"user","content":"Write a haiku about Rust."})]).await,
        "haiku", glm_ok);
    fire!(skip_glm, GLM_MODEL, "glm-2",
        glm_turn(GLM_MODEL, sys, &[json!({"role":"user","content":"Explain TCP briefly."})]).await,
        "tcp", glm_ok);
    fire!(skip_glm, GLM_MODEL, "glm-3",
        glm_turn(GLM_MODEL, sys, &[json!({"role":"user","content":"Refactor: fn foo(){}"})]).await,
        "refactor", glm_ok);

    // Allow the subscriber task to process the final events.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let snap = profiler.snapshot();
    let total_turns: usize = snap.values().map(|p| p.turns_observed).sum();

    if total_turns == 0 {
        panic!(
            "perf_profile not receiving events — event_bus wiring broken\n\
             (ollama_ok={ollama_ok} glm_ok={glm_ok} but snapshot is empty)"
        );
    }

    let find = |frag: &str| snap.values().find(|p| p.model_id.contains(frag)).cloned();

    if ollama_ok > 0 {
        if let Some(p) = find("qwen2.5").or_else(|| find("ollama")).or_else(|| find("unknown")) {
            assert_profile(&p, "ollama");
        } else {
            eprintln!("  NOTE: ollama turns fired but no matching profile (attribution miss)");
        }
    }
    if glm_ok > 0 {
        if let Some(p) = find("glm").or_else(|| find("unknown")) {
            assert_profile(&p, "glm");
        } else {
            eprintln!("  NOTE: glm turns fired but no matching profile (attribution miss)");
        }
    }

    // Print snapshot table.
    eprintln!("\n=== PerfProfiler live snapshot ===");
    eprintln!("{:<30}  {:>5}  {:>10}  {:>10}  {:>11}  {:>11}",
        "model", "turns", "ttft_p50", "ttft_p95", "total_p50", "total_p95");
    eprintln!("{}", "-".repeat(85));
    let mut profiles: Vec<_> = snap.values().cloned().collect();
    profiles.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    for p in &profiles {
        eprintln!("{:<30}  {:>5}  {:>10.0}ms {:>10.0}ms {:>11.0}ms {:>11.0}ms",
            p.model_id, p.turns_observed,
            p.ttft_p50, p.ttft_p95, p.total_p50, p.total_p95);
    }
    eprintln!("{}", "-".repeat(85));
    eprintln!("wiring=VERIFIED ollama_ok={ollama_ok} glm_ok={glm_ok} total_turns={total_turns}");
}
