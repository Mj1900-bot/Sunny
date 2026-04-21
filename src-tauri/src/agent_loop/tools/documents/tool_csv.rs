//! Tool registration for `csv_read`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["documents.read"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path":       {"type": "string",  "description": "Absolute or ~/ path to a CSV file."},
    "has_header": {"type": "boolean", "description": "Whether the first row is a header row. Default: true."}
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = crate::agent_loop::helpers::string_arg(&input, "path")?;
        let has_header = input
            .get("has_header")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        crate::agent_loop::tools::documents::csv_read::read(&path, has_header)
    })
}

inventory::submit! {
    ToolSpec {
        name: "csv_read",
        description: "Read a CSV file and return `{ headers, rows }` as JSON. \
                       `has_header` defaults to true. Pure-Rust RFC-4180 parser.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
