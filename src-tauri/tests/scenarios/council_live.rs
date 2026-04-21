//! council_live — Phase-2 Packet 7 end-to-end test.
//!
//! Proves the backend drives 3 council members in parallel against real LLMs.
//! Wall time ≈ max(M1,M2,M3), not sum — true concurrency confirmed.
//!
//! # Run
//!   cargo test --test live -- --ignored council_live --nocapture

use std::time::Instant;

use sunny_lib::agent_loop::providers::glm::glm_turn;
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::types::TurnOutcome;
use sunny_lib::telemetry::cost_estimate;
use serial_test::serial;
use serde_json::json;

const M1_MODEL: &str = "glm-5.1";
const M2_MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
const M3_MODEL: &str = "qwen2.5:3b";

const COUNCIL_PROMPT: &str =
    "Review this Rust snippet for correctness and style: \
     `fn add(a: i32, b: i32) -> i32 { a - b }` Be concise — 2-4 sentences.";

/// Substrings indicating the member spotted the subtraction-not-addition bug.
const BUG_MARKERS: &[&str] = &[
    "subtraction", "minus", "wrong", "bug", "should be +", "a + b",
    "incorrect", "error", "a-b", "not add", "misnamed",
];

// ---------------------------------------------------------------------------
// Skip guards
// ---------------------------------------------------------------------------

async fn glm_key_present() -> bool {
    for var in &["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() { return true; }
        }
    }
    sunny_lib::secrets::zai_api_key().await.is_some()
}

async fn ollama_has(model: &str) -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build().unwrap_or_default();
    let resp = match client.get("http://127.0.0.1:11434/api/tags").send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return false,
    };
    body.get("models").and_then(|m| m.as_array())
        .map(|arr| arr.iter()
            .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
            .any(|n| n == model || n.starts_with(&format!("{model}:"))))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Per-member result
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Member {
    label: &'static str,
    model: &'static str,
    provider: &'static str,
    text: Option<String>,
    latency_ms: u128,
    est_in: u64,
    est_out: u64,
    delta_count: usize,
    error: Option<String>,
}

impl Member {
    fn cost(&self) -> f64 { cost_estimate(self.provider, self.est_in, self.est_out, 0, 0) }

    fn diagnoses_bug(&self) -> bool {
        self.text.as_ref().map(|t| {
            let lower = t.to_lowercase();
            BUG_MARKERS.iter().any(|m| lower.contains(m))
        }).unwrap_or(false)
    }

    fn preview(&self) -> String {
        match &self.text {
            None => "<no output>".into(),
            Some(t) => {
                let s = t.trim();
                if s.len() <= 80 { s.into() } else { format!("{}…", &s[..80]) }
            }
        }
    }
}

fn extract(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, .. } => thinking.unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Per-member runners
// ---------------------------------------------------------------------------

async fn run_glm() -> Member {
    let hist = vec![json!({"role":"user","content":COUNCIL_PROMPT})];
    let t0 = Instant::now();
    match glm_turn(M1_MODEL, "You are a Rust code reviewer. Be concise.", &hist).await {
        Ok(o) => {
            let t = extract(o); let ms = t0.elapsed().as_millis();
            let dct = t.split_whitespace().count();
            Member { label:"M1", model:M1_MODEL, provider:"glm",
                     text:Some(t), latency_ms:ms,
                     est_in:60, est_out:dct as u64, delta_count:dct, error:None }
        }
        Err(e) => Member { label:"M1", model:M1_MODEL, provider:"glm",
                           text:None, latency_ms:t0.elapsed().as_millis(),
                           est_in:0, est_out:0, delta_count:0, error:Some(e) },
    }
}

async fn run_ollama(label: &'static str, model: &'static str, present: bool) -> Member {
    if !present {
        return Member { label, model, provider:"ollama", text:None, latency_ms:0,
                        est_in:0, est_out:0, delta_count:0,
                        error:Some(format!("{model} not in ollama list")) };
    }
    let hist = vec![json!({"role":"user","content":COUNCIL_PROMPT})];
    let t0 = Instant::now();
    match ollama_turn(model, "You are a Rust code reviewer. Be concise.", &hist).await {
        Ok(o) => {
            let t = extract(o); let ms = t0.elapsed().as_millis();
            let dct = t.split_whitespace().count();
            Member { label, model, provider:"ollama",
                     text:Some(t), latency_ms:ms,
                     est_in:0, est_out:0, delta_count:dct, error:None }
        }
        Err(e) => Member { label, model, provider:"ollama", text:None,
                           latency_ms:t0.elapsed().as_millis(),
                           est_in:0, est_out:0, delta_count:0, error:Some(e) },
    }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key + ollama; opt-in with --ignored"]
async fn council_live_three_members_parallel() {
    let has_glm = glm_key_present().await;
    let has_m2  = ollama_has(M2_MODEL).await;
    let has_m3  = ollama_has(M3_MODEL).await;

    if !has_glm && !has_m2 && !has_m3 {
        eprintln!("SKIP: no GLM key AND no ollama models ({M2_MODEL}, {M3_MODEL})");
        return;
    }
    if !has_glm { eprintln!("NOTE: no GLM key — M1 will error (resilience path)"); }

    // Fan-out: all 3 fire at the same instant.
    let wall_start = Instant::now();
    let (m1, m2, m3) = tokio::join!(
        run_glm(),
        run_ollama("M2", M2_MODEL, has_m2),
        run_ollama("M3", M3_MODEL, has_m3),
    );
    let wall_ms = wall_start.elapsed().as_millis();

    let serial_est = m1.latency_ms + m2.latency_ms + m3.latency_ms;
    let total_cost = m1.cost() + m2.cost() + m3.cost();
    let speedup    = if wall_ms > 0 { serial_est as f64 / wall_ms as f64 } else { 1.0 };

    // --- Stats table --------------------------------------------------------
    eprintln!("\n┌──────────────────────────────────────────────────────────────────────┐");
    eprintln!("│  Council Live — 3-member parallel deliberation                       │");
    eprintln!("├──────┬─────────────────────────────────────┬──────┬───────┬──────────┤");
    eprintln!("│  Who │ Model                               │ Lat  │ Delta │  Cost    │");
    eprintln!("├──────┼─────────────────────────────────────┼──────┼───────┼──────────┤");
    for mr in &[&m1, &m2, &m3] {
        let s = if mr.text.is_some() { "OK " } else { "ERR" };
        eprintln!("│ {}/{s} │ {:35} │{:5} │{:6} │${:.6}│",
            mr.label, mr.model, mr.latency_ms, mr.delta_count, mr.cost());
    }
    eprintln!("└──────────────────────────────────────────────────────────────────────┘");
    eprintln!("  Wall:{wall_ms}ms  SerialEst:{serial_est}ms  Speedup:{speedup:.2}x  Cost:${total_cost:.6}");
    for mr in &[&m1, &m2, &m3] { eprintln!("  {} preview: {}", mr.label, mr.preview()); }
    for mr in &[&m1, &m2, &m3] {
        if let Some(ref e) = mr.error { eprintln!("  {} error: {e}", mr.label); }
    }

    // --- Assertions ---------------------------------------------------------

    let all = [&m1, &m2, &m3];
    let ok: Vec<_> = all.iter().filter(|r| r.text.is_some()).collect();

    // At least 2 members must succeed (council is resilient to 1 failure).
    assert!(ok.len() >= 2,
        "Need ≥2 successful members, got {}. M1={:?} M2={:?} M3={:?}",
        ok.len(), m1.error, m2.error, m3.error);

    // Each successful member: ≥5 deltas OR non-empty text.
    for mr in &all {
        if let Some(ref t) = mr.text {
            assert!(mr.delta_count >= 5 || !t.trim().is_empty(),
                "{} ({}): 0 deltas AND empty text", mr.label, mr.model);
        }
    }

    // Majority must diagnose the bug (allow 1 miss — small models can fail).
    let diagnosers: Vec<_> = ok.iter().filter(|r| r.diagnoses_bug()).collect();
    let threshold = ok.len().saturating_sub(1).max(2);
    assert!(diagnosers.len() >= threshold,
        "Expected ≥{threshold} of {} to diagnose bug; got {}.\n  M1:{}\n  M2:{}\n  M3:{}",
        ok.len(), diagnosers.len(), m1.preview(), m2.preview(), m3.preview());

    // Cost guard: only GLM bills; Ollama = $0.
    assert!(total_cost < 0.005, "Cost ${total_cost:.6} exceeds $0.005 ceiling");

    // Parallelism: wall < serial estimate when ≥2 members actually ran.
    let real = all.iter().filter(|r| r.latency_ms > 0).count();
    if real >= 2 {
        assert!(wall_ms < serial_est,
            "Wall({wall_ms}ms) ≥ serial-est({serial_est}ms) — not running in parallel");
        eprintln!("  Parallelism confirmed: {speedup:.2}x speedup");
    }

    eprintln!("Council live test PASSED");
}
