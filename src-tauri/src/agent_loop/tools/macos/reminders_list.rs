//! `reminders_list` — list open reminders.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.reminders"];

const SCHEMA: &str = r#"{"type":"object","properties":{"limit":{"type":"integer"}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move { crate::tools_macos::reminders_today().await })
}

inventory::submit! {
    ToolSpec {
        name: "reminders_list",
        description: "USE THIS when Sunny says 'what are my reminders', 'what's on my to-do list', 'anything outstanding', 'read me my reminders'. Returns open (uncompleted) reminders from Sunny's Reminders.app with titles and due dates.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
