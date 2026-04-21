//! `uuid_new` — generate a fresh UUID v4.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &[];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move { crate::tools_compute::uuid_new().await })
}

inventory::submit! {
    ToolSpec {
        name: "uuid_new",
        description: "Generate a fresh UUID v4. Prefer this over py_run for simple UUIDs.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
