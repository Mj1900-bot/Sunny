//! tier_routing_live — 20-prompt live verification of the 4-tier router.
//!
//! Exercises K1 (model router), K3 (privacy detection), K4 (task classifier),
//! and K5 (provider wiring) against real providers.
//!
//! Run:
//!   cargo test --test live -- --ignored tier_routing_live --test-threads=1 --nocapture

use std::process::Command as StdCommand;
use std::time::{Duration, Instant};

use serial_test::serial;

use sunny_lib::agent_loop::model_router::{route_model, RoutingContext, TaskClass, Tier, QualityMode};
use sunny_lib::agent_loop::privacy_detect::is_privacy_sensitive;
use sunny_lib::agent_loop::providers::glm::glm_turn;
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::task_classifier::classify_task_heuristic;
use sunny_lib::agent_loop::telemetry_cost::pricing;
use sunny_lib::agent_loop::types::TurnOutcome;

const MODEL_QUICK: &str = "qwen2.5:3b";
const MODEL_CLOUD: &str = "glm-5.1";
const MODEL_DEEP:  &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
const CLAUDE_BIN:  &str = "/Users/sunny/.local/bin/claude";

struct Row { id: u8, expected: Tier, actual: Tier, model: String, ms: u128, cost: f64 }

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

fn extract(o: TurnOutcome) -> String {
    match o {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => thinking.unwrap_or_else(|| {
            format!("[tool_call:{}]", calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(","))
        }),
    }
}

fn est_cost(model: &str, inp: &str, out: &str) -> f64 {
    let hint = if model.contains("glm") { Some("glm") }
        else if model.contains("qwen") { Some("ollama") } else { None };
    let r = pricing::rates_for(model, hint);
    (inp.len() / 4) as f64 / 1_000.0 * r.input_per_1k
        + (out.len() / 4) as f64 / 1_000.0 * r.output_per_1k
}

fn transient(e: &str) -> bool {
    let l = e.to_lowercase();
    l.contains("429") || l.contains("rate limit") || l.contains("timeout")
        || l.contains("timed out") || l.contains("connect")
}

async fn call_ollama(model: &str, prompt: &str) -> Result<String, String> {
    let hist = vec![serde_json::json!({"role":"user","content":prompt})];
    let sys  = "You are a concise assistant. Respond briefly.";
    for attempt in 0..3usize {
        match ollama_turn(model, sys, &hist).await {
            Ok(o) => return Ok(extract(o)),
            Err(e) if transient(&e) && attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

async fn call_glm(prompt: &str) -> Result<String, String> {
    let hist = vec![serde_json::json!({"role":"user","content":prompt})];
    let sys  = "You are a concise assistant. Respond briefly.";
    for attempt in 0..3usize {
        match glm_turn(MODEL_CLOUD, sys, &hist).await {
            Ok(o) => return Ok(extract(o)),
            Err(e) if transient(&e) && attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

async fn call_claude(prompt: &str) -> Result<String, String> {
    let bin = if std::path::Path::new(CLAUDE_BIN).exists() { CLAUDE_BIN } else { "claude" };
    let out = tokio::time::timeout(Duration::from_secs(90),
        tokio::process::Command::new(bin)
            .args(["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"])
            .output(),
    ).await
    .map_err(|_| "claude_code_timeout: 90s".to_string())?
    .map_err(|e| format!("claude_code_unavailable: {e}"))?;

    let err = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
    if err.contains("not logged in") || err.contains("unauthorized") || err.contains("api key") {
        return Err("claude_code_auth_expired".to_string());
    }
    if !out.status.success() {
        return Err(format!("claude exit {}: {}", out.status, err.lines().next().unwrap_or("")));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    #[derive(serde::Deserialize, Default)] struct R { #[serde(default)] result: String }
    let parsed: R = serde_json::from_str(raw.trim()).unwrap_or_default();
    Ok(if parsed.result.trim().is_empty() { raw.trim().to_string() } else { parsed.result })
}

// ---------------------------------------------------------------------------
// Routing decision: K3 + K4 + K1
// ---------------------------------------------------------------------------

fn decide(prompt: &str) -> (Tier, String) {
    let (priv_flag, _) = is_privacy_sensitive(prompt);
    let task = classify_task_heuristic(prompt);
    let qm = if priv_flag { QualityMode::Balanced } else {
        match task {
            TaskClass::ArchitecturalDecision | TaskClass::LongMultiStepPlan => QualityMode::AlwaysBest,
            _ => QualityMode::Balanced,
        }
    };
    let ctx = RoutingContext {
        message: prompt.to_string(), tool_calls_so_far: 0, task_class: Some(task),
        is_retry_after_tool_error: false, inside_plan_execute: false,
        inside_reflexion_critic: false, reflexion_iteration: 0,
        quality_mode: qm, privacy_sensitive: priv_flag,
    };
    let d = route_model(&ctx);
    (d.tier, d.model_id.to_string())
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "live — requires GLM key + ollama qwen2.5:3b; opt-in with --ignored"]
#[serial(live_llm)]
async fn tier_routing_live() {
    let glm_missing   = super::should_skip_glm().await;
    let no_ollama     = super::should_skip_ollama().await;
    let quick_missing = if no_ollama { true } else { super::should_skip_ollama_model(MODEL_QUICK).await };
    let deep_missing  = if no_ollama { true } else { super::should_skip_ollama_model(MODEL_DEEP).await };
    let claude_missing = !std::path::Path::new(CLAUDE_BIN).exists()
        && !StdCommand::new("which").arg("claude").output()
            .map(|o| o.status.success()).unwrap_or(false);

    if glm_missing || quick_missing {
        eprintln!("SKIP: GLM key or qwen2.5:3b missing — aborting");
        return;
    }
    if deep_missing  { eprintln!("NOTE: qwen3:30b absent — DeepLocal prompts individually skipped"); }
    if claude_missing { eprintln!("NOTE: claude CLI absent — Premium prompts individually skipped"); }

    // (id, prompt, expected_tier)
    let scenarios: &[(u8, &str, Tier)] = &[
        ( 1, "what's 2+2",                                                                                             Tier::QuickThink),
        ( 2, "what day is today?",                                                                                     Tier::QuickThink),
        ( 3, "hi",                                                                                                     Tier::QuickThink),
        ( 4, "is python a language?",                                                                                  Tier::QuickThink),
        ( 5, "ping",                                                                                                   Tier::QuickThink),
        ( 6, "write a Rust function that reverses a string",                                                           Tier::Cloud),
        ( 7, "explain how TCP handshake works",                                                                        Tier::Cloud),
        ( 8, "refactor this function to be more idiomatic",                                                            Tier::Cloud),
        ( 9, "what's the difference between a Box and an Rc",                                                          Tier::Cloud),
        (10, "debug this error: thread panicked",                                                                       Tier::Cloud),
        (11, "My SSN is 123-45-6789, help me format a dispute letter",                                                 Tier::DeepLocal),
        (12, "Here's my OpenAI API key sk-proj-abc123xyz — check if it's valid format",                               Tier::DeepLocal),
        (13, "This is private — don't send to cloud. Review my medical notes below...",                               Tier::DeepLocal),
        (14, "offline only: summarize this [confidential under NDA] contract",                                         Tier::DeepLocal),
        (15, "keep local: my password manager export needs cleaning",                                                  Tier::DeepLocal),
        (16, "Design a multi-tenant audit log with tamper evidence, cross-region replication, and GDPR right-to-forget", Tier::Premium),
        (17, "Architect a system for real-time fraud detection with <100ms latency at 100k TPS",                       Tier::Premium),
        (18, "Plan a step-by-step 6-month migration from Postgres to distributed SQL including rollback strategy",     Tier::Premium),
        (19, "I need the very best reasoning: analyze the tradeoffs of event-sourcing vs CRUD for a financial ledger", Tier::Premium),
        (20, "Architectural decision: microservices vs modular monolith for a 10-engineer startup — walk me through both choices", Tier::Premium),
    ];

    let mut rows: Vec<Row> = Vec::with_capacity(20);
    let mut total_cost = 0.0f64;
    let mut premium_hits = 0usize;
    let (mut qt_ms, mut cl_ms, mut dl_ms, mut pr_ms) = (vec![], vec![], vec![], vec![]);

    for &(id, prompt, expected) in scenarios {
        let (actual, model_id) = decide(prompt);

        // Individual skips for absent tiers
        if actual == Tier::DeepLocal && deep_missing {
            eprintln!("  [{id}] SKIP: DeepLocal — qwen3:30b not installed");
            rows.push(Row { id, expected, actual, model: model_id, ms: 0, cost: 0.0 });
            continue;
        }
        if actual == Tier::Premium && claude_missing {
            eprintln!("  [{id}] SKIP: Premium — claude CLI absent");
            rows.push(Row { id, expected, actual, model: model_id, ms: 0, cost: 0.0 });
            continue;
        }

        let t0 = Instant::now();
        let resp = match actual {
            Tier::QuickThink => call_ollama(MODEL_QUICK, prompt).await,
            Tier::Cloud       => call_glm(prompt).await,
            Tier::DeepLocal   => call_ollama(MODEL_DEEP, prompt).await,
            Tier::Premium     => call_claude(prompt).await,
        };
        let ms = t0.elapsed().as_millis();

        let text = match resp {
            Ok(t) => t,
            Err(e) if transient(&e) => {
                eprintln!("  [{id}] SKIP — transient: {}", &e[..e.len().min(80)]);
                rows.push(Row { id, expected, actual, model: model_id, ms, cost: 0.0 });
                continue;
            }
            Err(e) => panic!("[{id}] hard provider failure: {e}"),
        };

        let cost = est_cost(&model_id, prompt, &text);
        total_cost += cost;

        match actual {
            Tier::QuickThink => qt_ms.push(ms),
            Tier::Cloud       => cl_ms.push(ms),
            Tier::DeepLocal   => dl_ms.push(ms),
            Tier::Premium     => { premium_hits += 1; pr_ms.push(ms); }
        }
        rows.push(Row { id, expected, actual, model: model_id, ms, cost });
    }

    // --- Print table ---------------------------------------------------------
    eprintln!("\n{:<4} {:<14} {:<14} {:<42} {:>8} {:>9}  MATCH",
              "ID", "EXPECTED", "ACTUAL", "MODEL", "LAT(ms)", "COST($)");
    eprintln!("{}", "-".repeat(100));
    let tl = |t| match t { Tier::QuickThink=>"QuickThink", Tier::Cloud=>"Cloud",
                            Tier::DeepLocal=>"DeepLocal", Tier::Premium=>"Premium" };
    for r in &rows {
        eprintln!("{:<4} {:<14} {:<14} {:<42} {:>8} {:>9.6}  {}",
            r.id, tl(r.expected), tl(r.actual),
            &r.model[..r.model.len().min(42)], r.ms, r.cost,
            if r.actual == r.expected { "OK" } else { "MISS" });
    }

    let avg = |v: &[u128]| if v.is_empty() { 0.0 } else { v.iter().sum::<u128>() as f64 / v.len() as f64 };
    let acc = |tier: Tier| { let g: Vec<_> = rows.iter().filter(|r| r.expected==tier && r.ms>0).collect();
        (g.iter().filter(|r| r.actual==tier).count(), g.len()) };
    let (qh,qn) = acc(Tier::QuickThink); let (ch,cn) = acc(Tier::Cloud);
    let (dh,dn) = acc(Tier::DeepLocal);  let (ph,pn) = acc(Tier::Premium);

    eprintln!("\nTotal cost: ${total_cost:.6}");
    eprintln!("Accuracy — QT:{qh}/{qn}  CL:{ch}/{cn}  DL:{dh}/{dn}  PR:{ph}/{pn}");
    eprintln!("Avg lat   — QT:{:.0}ms  CL:{:.0}ms  DL:{:.0}ms  PR:{:.0}ms",
              avg(&qt_ms), avg(&cl_ms), avg(&dl_ms), avg(&pr_ms));

    // --- Assertions ----------------------------------------------------------

    assert!(total_cost < 0.02, "Total cost ${total_cost:.6} > $0.02 ceiling");
    assert_eq!(rows.len(), 20, "Expected 20 results");

    for (hits, n, label) in [(qh,qn,"QuickThink"),(ch,cn,"Cloud"),(dh,dn,"DeepLocal"),(ph,pn,"Premium")] {
        if n > 0 { assert!(n - hits <= 1, "{label}: {} misses (max 1 allowed)", n - hits); }
    }
    if !qt_ms.is_empty() { assert!(avg(&qt_ms) < 2_000.0,  "QuickThink avg {:.0}ms > 2s",  avg(&qt_ms)); }
    if !cl_ms.is_empty() { assert!(avg(&cl_ms) < 15_000.0, "Cloud avg {:.0}ms > 15s",      avg(&cl_ms)); }
    if !dl_ms.is_empty() { assert!(avg(&dl_ms) < 30_000.0, "DeepLocal avg {:.0}ms > 30s",  avg(&dl_ms)); }
    if !pr_ms.is_empty() { assert!(avg(&pr_ms) < 60_000.0, "Premium avg {:.0}ms > 60s",    avg(&pr_ms)); }
    if !claude_missing && pn >= 3 {
        assert!(premium_hits >= 3, "Premium: only {premium_hits}/{pn} claude turns");
    }
}
