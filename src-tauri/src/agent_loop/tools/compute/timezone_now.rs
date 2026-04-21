//! `timezone_now` — current time in a timezone (IANA name or city alias).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &[];

const SCHEMA: &str = r#"{"type":"object","properties":{"tz":{"type":"string","description":"IANA timezone name or a common city alias. Optional — omit for local time."}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        // `tz` is optional — empty/missing resolves to the system timezone.
        let tz = input
            .get("tz")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        crate::tools_compute::timezone_now(tz).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "timezone_now",
        description: "Current time. Omit `tz` for the user's local time. Pass an IANA name (Europe/London, Asia/Tokyo, America/Vancouver) or a city alias (London, NYC, Tokyo). The shortcut \"local\" also works.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
