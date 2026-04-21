//! `weather_current` — current weather for a city.
//!
//! Migrated off `dispatch.rs`'s god-match in sprint-11 as one of
//! three pilot tools. The underlying implementation still lives in
//! `crate::tools_weather`; this file just owns the spec + arg
//! parsing.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

/// Capability strings mirror the TS-side `skillExecutor.checkCapability`
/// contract. `network.read` covers the Open-Meteo API call; no
/// side-effects on the user's machine, so nothing stronger is needed.
const CAPS: &[&str] = &["network.read"];

const SCHEMA: &str =
    r#"{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let city = string_arg(&input, "city")?;
        crate::tools_weather::tool_weather_current(city).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "weather_current",
        description: "Current weather for a city (temp, condition, wind, humidity).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
