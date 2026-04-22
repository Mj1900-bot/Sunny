//! `agent_loop` — the Rust ReAct driver and all supporting machinery.
//!
//! The only public export is `agent_run` (re-exported from `core`), which
//! Tauri invokes as the `chat` command. Everything else — providers, dispatch,
//! memory wiring, sub-agents, constitution enforcement — is internal to this
//! module tree and intentionally not reachable from the rest of the crate
//! without going through `agent_run`.
//!
//! Sub-module responsibilities are documented in their own `//!` blocks;
//! see `dispatch.rs` for the tool-call ordering contract and `core.rs` for
//! the main ReAct loop constants (`MAX_ITERATIONS`, `TOTAL_TIMEOUT_SECS`).

pub mod analyze_messages;
pub mod catalog;
pub mod claude_code;
pub mod code_edit;
pub mod confirm;
pub mod context_window;
pub mod council;
pub mod critic;
pub mod core_helpers;
pub mod remember_screen;
pub mod summarize_pdf;
pub mod tools_vision;
pub mod core;
pub mod deep_research;
pub mod dialogue;
pub mod dispatch;
pub mod helpers;
pub mod memory_integration;
pub mod model_router;
pub mod persona;
pub mod plan_execute;
pub mod prompts;
pub mod providers;
pub mod reflect;
pub mod reflexion;
pub mod scope;
pub mod session_cache;
pub mod session_lock;
pub mod subagents;
pub mod tool_output_wrap;
pub mod tool_trait;
pub mod tools;
pub mod types;
pub mod task_classifier;
pub mod cost_guard;
pub mod privacy_detect;
pub mod telemetry_cost;
pub mod web_browse;

pub use core::agent_run;
