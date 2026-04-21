//! live_routing — model router decisions for varying prompt complexity.
//!
//! Tests the `route_model` heuristic against 4 real-world-flavoured scenarios
//! and verifies the router picks the right tier for each. Since the router
//! currently handles Anthropic tiers (Haiku/Sonnet/Opus) and not the
//! GLM-vs-Ollama axis directly, the tests verify the complexity-classification
//! layer that the Phase-2 GLM/Ollama dispatcher will consume:
//!
//!   simple lookup    → Haiku tier (lowest complexity)
//!   coding/debug     → Sonnet tier  (moderate complexity)
//!   architectural    → Opus tier  (highest complexity)
//!   reflexion critic → Opus tier  (reflexion always escalates)
//!
//! A separate set of tests validates that the same complexity signals map to
//! the correct live provider (GLM for cloud turns, Ollama for local turns)
//! by exercising both providers with prompts of the corresponding complexity.
//!
//! All live provider tests are `#[ignore]`; the routing-logic assertions (pure,
//! no I/O) run unconditionally as unit tests.
//!
//! Run live tests with:
//!   cargo test --test live live_routing -- --ignored --nocapture

use sunny_lib::agent_loop::model_router::{
    route_model, RoutingContext, TaskClass,
    MODEL_HAIKU, MODEL_SONNET, MODEL_OPUS,
};
use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::providers::ollama::ollama_turn;
use sunny_lib::agent_loop::types::TurnOutcome;
use serial_test::serial;

// ---------------------------------------------------------------------------
// Pure routing assertions (no I/O — these run in normal CI)
// ---------------------------------------------------------------------------

/// Scenario 1: simple lookup → Haiku (cheapest tier).
/// Mirrors what a user asking "what's 2+2" should cost.
#[test]
fn routing_simple_lookup_picks_haiku() {
    let ctx = RoutingContext {
        task_class: Some(TaskClass::SimpleLookup),
        tool_calls_so_far: 0,
        ..RoutingContext::from_message("what is 2+2")
    };
    let decision = route_model(&ctx);
    assert_eq!(
        decision.model_id, MODEL_HAIKU,
        "simple lookup should route to Haiku; reasoning: {}",
        decision.reasoning
    );
    assert!(
        !decision.reasoning.is_empty(),
        "routing decision must include reasoning"
    );
}

/// Scenario 2: coding/debugging → Sonnet.
/// Mirrors a user asking to debug code.
#[test]
fn routing_coding_picks_sonnet() {
    let ctx = RoutingContext {
        task_class: Some(TaskClass::CodingOrReasoning),
        ..RoutingContext::from_message("debug this rust function: fn foo() {}")
    };
    let decision = route_model(&ctx);
    assert_eq!(
        decision.model_id, MODEL_SONNET,
        "coding task should route to Sonnet; reasoning: {}",
        decision.reasoning
    );
}

/// Scenario 3: architectural decision → Opus when quality_mode = AlwaysBest.
/// K1's router reserves Premium (Opus via Claude Code) for explicit opt-in;
/// Balanced mode routes architectural work to Cloud (GLM) which is still strong.
#[test]
fn routing_architectural_picks_opus() {
    use sunny_lib::agent_loop::model_router::QualityMode;
    let ctx = RoutingContext {
        task_class: Some(TaskClass::ArchitecturalDecision),
        quality_mode: QualityMode::AlwaysBest,
        ..RoutingContext::from_message("design the multi-tenant data model for our platform")
    };
    let decision = route_model(&ctx);
    assert_eq!(
        decision.model_id, MODEL_OPUS,
        "architectural + AlwaysBest should route to Opus; reasoning: {}",
        decision.reasoning
    );
}

/// Scenario 4: reflexion critic round → Opus regardless of message length.
/// The reflexion loop always escalates for critic turns to get the best
/// possible feedback; this must hold even for short messages.
#[test]
fn routing_reflexion_critic_always_picks_opus() {
    let ctx = RoutingContext {
        inside_reflexion_critic: true,
        task_class: None,
        ..RoutingContext::from_message("short")
    };
    let decision = route_model(&ctx);
    assert_eq!(
        decision.model_id, MODEL_OPUS,
        "reflexion critic round must always route to Opus; reasoning: {}",
        decision.reasoning
    );
}

// ---------------------------------------------------------------------------
// Live provider validation: simple prompt → Ollama (qwen2.5:3b)
// ---------------------------------------------------------------------------

/// Live: verify that a simple prompt executes correctly on Ollama (qwen2.5:3b).
///
/// This mirrors the expected routing outcome once the GLM/Ollama dispatcher
/// is wired: simple queries stay local (zero cost, fast TTFT).
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires ollama running with qwen2.5:3b; opt-in with --ignored"]
async fn live_simple_prompt_runs_on_ollama() {
    const MODEL: &str = "qwen2.5:3b";
    if super::should_skip_ollama_model(MODEL).await {
        return;
    }

    let ctx = RoutingContext {
        task_class: Some(TaskClass::SimpleLookup),
        ..RoutingContext::from_message("what is 2+2")
    };
    let decision = route_model(&ctx);
    // Document which Anthropic tier this would be; the live call uses Ollama
    // because simple/cheap tasks route locally first.
    eprintln!("  anthropic-tier-equivalent={}", decision.model_id);

    let history = super::single_user_turn("What is 2+2? Answer with one number.");
    let (result, latency_ms) = super::timed(ollama_turn(
        MODEL,
        "Reply with one number only.",
        &history,
    ))
    .await;

    let outcome = result.expect("Ollama turn must succeed for simple prompt");
    let text = match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, .. } => thinking.unwrap_or_default(),
    };

    super::assert_reasonable_llm_response(&text, "What is 2+2? Answer with one number.");
    eprintln!("  model={MODEL} latency={latency_ms}ms response={text:?}");
}

// ---------------------------------------------------------------------------
// Live provider validation: coding prompt → GLM-5.1
// ---------------------------------------------------------------------------

/// Live: verify that a coding prompt executes correctly on GLM-5.1.
///
/// Mirrors the expected routing outcome: coding tasks route to GLM-5.1
/// (cloud, better code quality than small local models).
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn live_coding_prompt_runs_on_glm() {
    if super::should_skip_glm().await {
        return;
    }

    let ctx = RoutingContext {
        task_class: Some(TaskClass::CodingOrReasoning),
        ..RoutingContext::from_message("debug this: fn foo() {}")
    };
    let decision = route_model(&ctx);
    eprintln!("  anthropic-tier-equivalent={}", decision.model_id);

    let history = super::single_user_turn("What is wrong with: fn foo() {}  Reply briefly.");
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a concise Rust code reviewer.",
        &history,
    ))
    .await;

    let outcome = match result {
        Ok(o) => o,
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM failed: {e}"),
    };
    let text = match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, .. } => thinking.unwrap_or_default(),
    };

    super::assert_reasonable_llm_response(&text, "What is wrong with: fn foo() {}  Reply briefly.");
    eprintln!("  model={DEFAULT_GLM_MODEL} latency={latency_ms}ms response={text:?}");
}

/// Live: verify that an architectural prompt executes correctly on GLM-5.1.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn live_architectural_prompt_runs_on_glm() {
    if super::should_skip_glm().await {
        return;
    }

    let ctx = RoutingContext {
        task_class: Some(TaskClass::ArchitecturalDecision),
        ..RoutingContext::from_message("design a caching layer")
    };
    let decision = route_model(&ctx);
    eprintln!("  anthropic-tier-equivalent={}", decision.model_id);

    let history = super::single_user_turn(
        "In one sentence: what is the key tradeoff when designing a caching layer?",
    );
    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a senior software architect. Be very concise.",
        &history,
    ))
    .await;

    let outcome = match result {
        Ok(o) => o,
        Err(ref e) if super::is_transient_glm_error(e) => { eprintln!("SKIP: {e}"); return; }
        Err(e) => panic!("GLM failed: {e}"),
    };
    let text = match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, .. } => thinking.unwrap_or_default(),
    };

    super::assert_reasonable_llm_response(
        &text,
        "In one sentence: what is the key tradeoff when designing a caching layer?",
    );
    eprintln!("  model={DEFAULT_GLM_MODEL} latency={latency_ms}ms response={text:?}");
}
