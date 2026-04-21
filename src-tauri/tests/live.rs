//! Live integration test harness — real providers, no mocks.
//!
//! All tests in this harness hit real external services (Z.AI API key
//! and/or local Ollama) and are gated behind `#[ignore]`. They NEVER run
//! in CI unless explicitly opted in.
//!
//! # Running live tests
//!
//!   # Full suite — all live tests
//!   cargo test --test live -- --ignored
//!
//!   # With output (recommended — prints latency, tokens, cost):
//!   cargo test --test live -- --ignored --nocapture
//!
//!   # Single module:
//!   cargo test --test live live_smoke -- --ignored --nocapture
//!   cargo test --test live live_glm_turn -- --ignored --nocapture
//!   cargo test --test live live_ollama_turn -- --ignored --nocapture
//!   cargo test --test live live_routing -- --ignored --nocapture
//!   cargo test --test live live_tool_wrap -- --ignored --nocapture
//!   cargo test --test live live_eval_scenarios -- --ignored --nocapture
//!
//! # Cost ceiling
//!
//! $0.01 per full `-- --ignored` run. All prompts use max_tokens=50 and
//! short inputs. GLM-5.1 rates: $0.40/M input, $1.20/M output.
//! Ollama is always free.
//!
//! # Submodule map
//!
//! | Module               | Tests | Purpose |
//! |----------------------|-------|---------|
//! | live_smoke           |  2    | 5-second sanity: 1 GLM + 1 Ollama call |
//! | live_glm_turn        |  2    | GLM-5.1 end-to-end: response + token accounting |
//! | live_ollama_turn     |  2    | Ollama end-to-end: response + zero-cost assertion |
//! | live_routing         |  7    | Model-router decisions + provider validation |
//! | live_tool_wrap       |  4    | Prompt-injection hardening (pure + live) |
//! | live_eval_scenarios  |  5    | Real-world scenarios (a)–(e) |

// Shared fixtures, skip helpers, and assertion utilities.
// Declared with #[path] so the shared helpers live in live/mod.rs while
// this file (live.rs) remains the integration-test binary entry point.
#[path = "live/mod.rs"]
mod live_helpers;

// Synthetic test support (FakeProvider etc.) — used by longevity_24h_synthetic
// and any future pure-synthetic scenario.
#[path = "support/mod.rs"]
mod support;

use live_helpers::*;

// Test submodules — each file in live/ is one test group. The #[path]
// attributes tell rustc to find the source in the live/ subdirectory.

#[path = "live/live_smoke.rs"]
mod live_smoke;

#[path = "live/live_glm_turn.rs"]
mod live_glm_turn;

#[path = "live/live_ollama_turn.rs"]
mod live_ollama_turn;

#[path = "live/live_routing.rs"]
mod live_routing;

#[path = "live/live_tool_wrap.rs"]
mod live_tool_wrap;

#[path = "live/live_eval_scenarios.rs"]
mod live_eval_scenarios;

#[path = "scenarios/debug_failing_test.rs"]
mod debug_failing_test;

#[path = "scenarios/calendar_prep.rs"]
mod calendar_prep;

#[path = "scenarios/brainstorm_mode.rs"]
mod brainstorm_mode;

#[path = "scenarios/continuity_recall.rs"]
mod continuity_recall;

#[path = "scenarios/dev_tool_launch.rs"]
mod dev_tool_launch;

#[path = "scenarios/voice_wake_word.rs"]
mod voice_wake_word;

#[path = "scenarios/routing_and_cost.rs"]
mod routing_and_cost;

#[path = "scenarios/autopilot_signal.rs"]
mod autopilot_signal;

#[path = "scenarios/email_triage.rs"]
mod email_triage;

#[path = "scenarios/openclaw_bridge_live.rs"]
mod openclaw_bridge_live;

#[path = "scenarios/longevity_24h_synthetic.rs"]
mod longevity_24h_synthetic;

#[path = "scenarios/claude_code_live.rs"]
mod claude_code_live;

#[path = "scenarios/council_live.rs"]
mod council_live;

#[path = "scenarios/prompt_injection_redteam.rs"]
mod prompt_injection_redteam;

#[path = "scenarios/prompt_injection_redteam_2.rs"]
mod prompt_injection_redteam_2;

#[cfg(feature = "test-sink")]
#[path = "scenarios/unattended_consent_live.rs"]
mod unattended_consent_live;

#[path = "scenarios/perf_profile_live.rs"]
mod perf_profile_live;

#[path = "scenarios/grand_integration.rs"]
mod grand_integration;

#[path = "scenarios/continuity_warm_context.rs"]
mod continuity_warm_context;

#[path = "scenarios/tier_routing_live.rs"]
mod tier_routing_live;

#[path = "scenarios/user_reminder_30min.rs"]
mod user_reminder_30min;

#[path = "scenarios/user_pdf_summarize.rs"]
mod user_pdf_summarize;

#[path = "scenarios/user_calendar_prep.rs"]
mod user_calendar_prep;

#[path = "scenarios/user_brainstorm_naming.rs"]
mod user_brainstorm_naming;
