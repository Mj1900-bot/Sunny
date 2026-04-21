//! Tool registration for `document_summarize`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

// Requires both local file read + network to GLM.
const CAPS: &[&str] = &["documents.read", "network.read"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path":       {"type": "string",  "description": "Absolute or ~/ path to a PDF, DOCX, XLSX, XLS, ODS, or CSV file."},
    "max_length": {"type": "integer", "minimum": 50, "maximum": 2000,
                   "description": "Target summary length in words (default: 500)."}
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = crate::agent_loop::helpers::string_arg(&input, "path")?;
        let max_length = input
            .get("max_length")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(500);
        crate::agent_loop::tools::documents::doc_summarize::summarize(&path, max_length).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "document_summarize",
        description: "Summarize a document (PDF, DOCX, XLSX, CSV) via GLM-5.1. \
                       Extracts text then returns a concise summary of ≤ `max_length` words (default 500). \
                       Requires ZAI_API_KEY. Use when the user says 'summarize this file' or 'what's in this document'.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
