//! `agent_wait` — block until every listed sub-agent finishes or the
//! timeout elapses.
//!
//! Note: `dispatch_tool` treats `agent_wait` as long-running (the
//! 30 s per-tool timeout is skipped for it). That logic stays in
//! `dispatch.rs::is_long_running` and keys off the tool's name —
//! migration here doesn't change it.

use std::time::Duration;

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::dialogue;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["agent.dialogue"];

const SCHEMA: &str = r#"{"type":"object","properties":{"ids":{"type":"array","items":{"type":"string"},"description":"Sub-agent ids to wait on. Empty array returns immediately."},"timeout_secs":{"type":"integer","minimum":1,"maximum":600,"description":"Maximum seconds to wait. Default 120, hard cap 600."}},"required":["ids"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ids: Vec<String> = input
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if ids.is_empty() {
            return Ok("{}".to_string());
        }
        let requested = input
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(120);
        // Clamp to 1..=MAX_WAIT_SECS. `0` → 1 s floor so callers
        // still snapshot the current state.
        let clamped = requested.max(1).min(dialogue::MAX_WAIT_SECS);
        let timeout = Duration::from_secs(clamped);
        let map = dialogue::wait_for_results(&ids, timeout).await;
        let as_value: serde_json::Map<String, Value> = ids
            .iter()
            .map(|id| {
                let v = map
                    .get(id)
                    .cloned()
                    .flatten()
                    .map(Value::String)
                    .unwrap_or(Value::Null);
                (id.clone(), v)
            })
            .collect();
        serde_json::to_string(&Value::Object(as_value))
            .map_err(|e| format!("agent_wait encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "agent_wait",
        description: "Block the caller until every listed sub-agent has produced a final answer, or until `timeout_secs` elapses. Returns a JSON object mapping each id to its final answer (null when that id timed out). Use this together with `agent_message` to build council / debate patterns: spawn_subagent three perspectives, agent_message them a question, agent_wait for all three to reply, then synthesise. Timeout defaults to 120 s and is hard-capped at 600 s. Not dangerous — waiting is passive.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
