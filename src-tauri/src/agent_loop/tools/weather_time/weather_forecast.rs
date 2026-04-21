//! `weather_forecast` — N-day weather forecast for a city.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, u32_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["network.read"];

const SCHEMA: &str = r#"{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"integer"}},"required":["city","days"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let city = string_arg(&input, "city")?;
        let days = u32_arg(&input, "days").unwrap_or(3);
        crate::tools_weather::tool_weather_forecast(city, days).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "weather_forecast",
        description: "N-day weather forecast (1-7 days).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
