//! `unit_convert` — convert a value between units.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{f64_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &[];

const SCHEMA: &str = r#"{"type":"object","properties":{"value":{"type":"number"},"from":{"type":"string"},"to":{"type":"string"}},"required":["value","from","to"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let value = f64_arg(&input, "value")?;
        let from = string_arg(&input, "from")?;
        let to = string_arg(&input, "to")?;
        crate::tools_compute::convert_units(value, from, to).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "unit_convert",
        description: "Convert a value between units (e.g. km to mi, C to F).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
