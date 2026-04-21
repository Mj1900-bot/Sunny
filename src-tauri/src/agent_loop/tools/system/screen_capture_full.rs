//! `screen_capture_full` — full-screen PNG capture, returned as base64.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let img = crate::vision::capture_full_screen(None).await?;
        serde_json::to_string(&img).map_err(|e| format!("capture encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "screen_capture_full",
        description: "Capture the full screen and return a base64 PNG.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
