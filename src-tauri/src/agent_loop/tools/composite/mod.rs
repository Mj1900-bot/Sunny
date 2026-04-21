//! Composite tools — multi-step orchestration tools that compose
//! simpler primitives internally.
//!
//! Each module is a thin `inventory::submit!` adapter that delegates to
//! the corresponding implementation module in `agent_loop::*`. The
//! registry wiring lets `dispatch.rs` resolve every tool via the trait
//! table with no per-tool match arms.
//!
//! `remember_screen` composes screen_capture + OCR + memory write
//! without spawning a sub-agent.
//!
//! `spawn_subagent` drives a recursive `agent_run_inner` loop; the
//! `ToolFuture<'a> = Pin<Box<dyn Future>>` erasure provides the value-
//! level sizing needed to break the recursive-async chain.
pub mod agent_reflect;
pub mod analyze_messages;
pub mod claude_code_supervise;
pub mod code_edit;
pub mod council_decide;
pub mod deep_research;
pub mod plan_execute;
pub mod reflexion_answer;
pub mod remember_screen;
pub mod spawn_subagent;
pub mod summarize_pdf;
pub mod web_browse;
