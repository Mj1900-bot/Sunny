//! `battery_status` — battery charge percentage + state.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["system.metrics"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let info = crate::metrics::battery();
        serde_json::to_string(&info).map_err(|e| format!("battery encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "battery_status",
        description: "Battery charge percentage, plugged-in state, and time remaining.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
