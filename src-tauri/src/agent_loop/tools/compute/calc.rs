//! `calc` — evaluate an arithmetic expression.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &[];

const SCHEMA: &str = r#"{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let expr = string_arg(&input, "expr")?;
        crate::tools_compute::calc(expr).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "calc",
        description: "Evaluate an arithmetic expression.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
