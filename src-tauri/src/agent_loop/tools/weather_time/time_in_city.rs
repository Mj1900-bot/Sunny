//! `time_in_city` — current local time in a named city.
//!
//! Second of the sprint-11 pilot trio. See `weather.rs` for the
//! pattern; this tool is structurally identical aside from its
//! description and the underlying call.

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
        crate::tools_weather::tool_time_in_city(city).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "time_in_city",
        description: "Current local time in a city. Use timezone_now instead when the user asks for just a time (no weather context).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
