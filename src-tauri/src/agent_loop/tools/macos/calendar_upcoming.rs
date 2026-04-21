//! `calendar_upcoming` — upcoming events across the next N days.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::u32_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.calendar"];

const SCHEMA: &str = r#"{"type":"object","properties":{"days":{"type":"integer"}},"required":["days"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let days = Some(u32_arg(&input, "days").unwrap_or(7));
        crate::tools_macos::calendar_upcoming(days).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "calendar_upcoming",
        description: "USE THIS when Sunny says 'what's this week look like', 'coming up', 'anything tomorrow', 'what's on my calendar next week'. Returns upcoming events across the next N days (1-30) from Sunny's Calendar.app.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
