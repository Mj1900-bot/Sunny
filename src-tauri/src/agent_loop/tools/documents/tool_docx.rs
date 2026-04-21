//! Tool registration for `docx_extract_text`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["documents.read"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Absolute or ~/ path to a DOCX file."}
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = crate::agent_loop::helpers::string_arg(&input, "path")?;
        crate::agent_loop::tools::documents::docx_extract::extract_text(&path)
    })
}

inventory::submit! {
    ToolSpec {
        name: "docx_extract_text",
        description: "Extract plain text from a DOCX file. Returns JSON with `paragraphs` array and \
                       `text` (joined). Pure-Rust ZIP+XML parser — no LibreOffice or Pandoc required.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
