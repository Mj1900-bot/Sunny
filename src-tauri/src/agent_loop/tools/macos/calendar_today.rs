//! `calendar_today` — today's events from Calendar.app.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.calendar"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move { crate::tools_macos::calendar_today().await })
}

inventory::submit! {
    ToolSpec {
        name: "calendar_today",
        description: "USE THIS when Sunny says 'what's on my calendar', 'what do I have today', 'am I free', 'what's my next meeting'. Returns today's events from Sunny's Calendar.app (title, start/end time, location).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
