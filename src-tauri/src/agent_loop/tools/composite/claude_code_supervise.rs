//! Trait-registry adapter for `claude_code_supervise`.
//!
//! The composite implementation lives in
//! `agent_loop::claude_code`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"project_dir":{"type":"string","description":"Absolute path or ~/ path to the project directory"},"spec":{"type":"string","description":"What Claude should build or fix. Plain English."},"success_criteria":{"type":"array","items":{"type":"string"},"description":"Shell commands that must exit 0 for the job to be considered done, e.g. [\"pnpm test\",\"pnpm build\"]. Optional."},"max_iterations":{"type":"integer","description":"Stop after this many Claude calls even if criteria aren't met. Default 10, max 40."}},"required":["project_dir","spec"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        // claude_code_supervise drives the Claude CLI as a sub-process rather
        // than an in-process sub-agent, so depth/parent_session_id are not
        // threaded through to the impl.
        let project_dir = string_arg(&input, "project_dir")?;
        let spec = string_arg(&input, "spec")?;
        let success_criteria: Vec<String> = input
            .get("success_criteria")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let max_iterations = input
            .get("max_iterations")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(10);
        crate::agent_loop::claude_code::claude_code_supervise(
            _ctx.app,
            &project_dir,
            &spec,
            &success_criteria,
            max_iterations,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "claude_code_supervise",
        description: "Drive the Claude Code CLI on a build loop. Shells out to `claude -p <prompt>` inside the project dir, reads the output, optionally runs success-criteria shell checks (e.g. `pnpm test`, `pnpm build`), and either accepts the result or synthesises a follow-up instruction and runs claude again — up to `max_iterations` times. Use this when Sunny asks to \"build an app\", \"implement a feature\", \"fix this bug\", or any task that means letting Claude Code work autonomously while SUNNY supervises. Emits `sunny://claude-supervise.step` events per iteration so the HUD can show progress live. Returns a plain-text report.",
        input_schema: SCHEMA,
        required_capabilities: &["shell.sandbox"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
