//! `app_launch` — launch a macOS app by name.
//!
//! Dangerous — launches arbitrary GUI apps on the user's Mac, so the
//! spec flags `dangerous: true` and ConfirmGate intercepts before
//! dispatch lands here.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["app:launch"];

const SCHEMA: &str =
    r#"{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let app_name = string_arg(&input, "name")?;
        crate::tools_macos::app_launch(app_name).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "app_launch",
        description: "Launch a macOS app by name.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
