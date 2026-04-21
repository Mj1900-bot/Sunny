//! `sunrise_sunset` — today's sunrise and sunset times for a city.
//!
//! Third of the sprint-11 pilot trio. See `weather.rs` for the
//! pattern.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["network.read"];

const SCHEMA: &str =
    r#"{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let city = string_arg(&input, "city")?;
        crate::tools_weather::tool_sunrise_sunset(city).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "sunrise_sunset",
        description: "Today's sunrise and sunset times for a city.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
