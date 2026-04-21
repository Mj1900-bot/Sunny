//! `py_run` — execute a short Python3 script in a sandboxed subprocess.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["compute.run"];

const SCHEMA: &str = r#"{"type":"object","properties":{"code":{"type":"string"},"stdin":{"type":"string"},"timeout_sec":{"type":"integer"}},"required":["code"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let code = string_arg(&input, "code")?;
        let stdin = optional_string_arg(&input, "stdin");
        let timeout_sec = input.get("timeout_sec").and_then(|v| v.as_u64());
        let result = crate::pysandbox::py_run(code, stdin, timeout_sec).await?;
        serde_json::to_string(&result).map_err(|e| format!("py_run encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "py_run",
        description: "Execute a short Python3 script in a sandboxed subprocess and return stdout + stderr. Use for ad-hoc data analysis, CSV crunching, regex work, PDF text extraction, math beyond `calc`, any scripting the user asks for inline. 30s default timeout, 10MB output cap. The sandbox has stdlib only — no network, no file writes outside /tmp.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        // `py_run`'s output is subprocess-controlled text — treat as
        // external-read so `<untrusted_source>` wrapping applies.
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
