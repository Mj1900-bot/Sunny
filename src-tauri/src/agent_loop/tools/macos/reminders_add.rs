//! `reminders_add` — add a reminder. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.reminders.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string","description":"What to be reminded of."},"due":{"type":"string","description":"Optional due date/time. Natural language ('tomorrow 9am', 'in 2 hours') or ISO-8601. Omit for no due date."},"list":{"type":"string","description":"Target list name, e.g. 'Groceries' or 'Work'. Omit to use the default list."}},"required":["title"]}"#;

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
        description: "Add a reminder to macOS Reminders.app. 'title' is required. 'due' accepts natural language ('tomorrow 9am', 'in 2 hours') or ISO-8601; omit for no due date. 'list' targets a named list (e.g. 'Groceries'); falls back to the default list if omitted or unknown.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
