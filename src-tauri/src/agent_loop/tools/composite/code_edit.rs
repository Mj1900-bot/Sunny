//! Trait-registry adapter for `code_edit`.
//!
//! The composite implementation lives in
//! `agent_loop::code_edit`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or ~/ path to the source file to edit."},"instruction":{"type":"string","description":"What to change. Plain English — the coder sub-agent interprets it."}},"required":["file_path","instruction"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (file_path, instruction) = crate::agent_loop::code_edit::parse_input(&input)?;
        crate::agent_loop::code_edit::code_edit(
            ctx.app,
            &file_path,
            &instruction,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "code_edit",
        description: "Edit a source file on disk using a coder sub-agent. Reads the current contents, sends them plus the instruction to a coder sub-agent, and writes the sub-agent's rewritten version back to the same path. DANGEROUS — mutates user files; Sunny is asked to confirm before the edit runs. Emits `sunny://code.edit.diff` with before/after for a diff panel. Use when Sunny says 'rename X in nav.tsx', 'add a type annotation to this function', or 'refactor file Y to use async/await'. Refuses binary files, files larger than 256 KB, and paths outside the allowed sandbox.",
        input_schema: SCHEMA,
        required_capabilities: &["shell.sandbox"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
