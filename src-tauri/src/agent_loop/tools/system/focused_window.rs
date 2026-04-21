//! `focused_window` — frontmost macOS window identity.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.accessibility"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let app_info = crate::ax::focused_app().await?;
        serde_json::to_string(&app_info).map_err(|e| format!("focused encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "focused_window",
        description: "Name, title, and bundle id of the currently frontmost macOS window.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
