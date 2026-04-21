//! `shortcut_run` — run a named macOS Shortcut. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["shortcut:run"];

const SCHEMA: &str = r#"{"type":"object","properties":{"name":{"type":"string"},"input":{"type":"string"}},"required":["name"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let sc_name = string_arg(&input, "name")?;
        let sc_input = optional_string_arg(&input, "input");
        crate::tools_macos::shortcut_run(sc_name, sc_input).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "shortcut_run",
        description: "Run a named macOS Shortcut, optionally with input text.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
