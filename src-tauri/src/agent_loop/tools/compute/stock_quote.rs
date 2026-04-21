//! `stock_quote` — latest price + daily change for a ticker.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["network.read"];

const SCHEMA: &str = r#"{"type":"object","properties":{"ticker":{"type":"string"}},"required":["ticker"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ticker = string_arg(&input, "ticker")?;
        crate::worldinfo::stock_quote(ticker)
            .await
            .map(|q| format!("{:?}", q))
    })
}

inventory::submit! {
    ToolSpec {
        name: "stock_quote",
        description: "Latest price + daily change for a stock ticker.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
