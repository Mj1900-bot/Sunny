//! `reminders_add` — add a reminder. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.reminders.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string"},"due":{"type":"string"}},"required":["title"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "title")?;
        let due = optional_string_arg(&input, "due");
        let list = optional_string_arg(&input, "list");
        crate::tools_macos::reminders_add(title, due, list).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "reminders_add",
        description: "Add a reminder.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
