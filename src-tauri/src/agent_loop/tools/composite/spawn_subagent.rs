//! Trait-registry adapter for `spawn_subagent`.
//!
//! The implementation in `agent_loop::subagents::spawn_subagent` drives a
//! nested `agent_run_inner` loop. This adapter wires it into the
//! `inventory::submit!` registry so `dispatch.rs` resolves it via the
//! trait table. `ToolFuture<'a> = Pin<Box<dyn Future>>` provides the
//! value-level type erasure required to break the recursive-async chain.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::subagents::spawn_subagent;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"role":{"type":"string","enum":["researcher","coder","writer","browser_driver","planner","summarizer","critic"]},"task":{"type":"string","description":"The specific task for this sub-agent"},"model":{"type":"string","description":"Optional: specific model to use (e.g. qwen3:30b-a3b-instruct-2507, glm-5.1). Defaults based on role."}},"required":["role","task"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let role = string_arg(&input, "role")?;
        let task = string_arg(&input, "task")?;
        let model_override = input
            .get("model")
            .and_then(|v| v.as_str())
            .map(String::from);
        let parent_session_id = ctx.session_id.map(String::from);
        spawn_subagent(
            ctx.app,
            &role,
            &task,
            model_override,
            parent_session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "spawn_subagent",
        description: "Delegate work to a specialised sub-agent with its own reasoning loop. PREFER this tool over doing everything yourself whenever the user asks for research, a multi-step investigation, a draft, a summary, a plan, code, or browser-driven work — spawn one sub-agent per distinct sub-task and you may call this tool several times in parallel. Returns the sub-agent's final answer as a string. Roles: researcher (gather + compare sources), coder (write/modify code), writer (draft prose), browser_driver (click through sites), planner (break a goal into steps), summarizer (condense material), critic (review + find flaws). If in doubt between doing it yourself and delegating, delegate.",
        input_schema: SCHEMA,
        required_capabilities: &[],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
