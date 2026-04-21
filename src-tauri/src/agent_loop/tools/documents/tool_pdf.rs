//! Tool registrations for PDF tools:
//!   - `pdf_extract_text`
//!   - `pdf_extract_tables`
//!   - `pdf_metadata`

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::optional_string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

// Shared capability: reading local user-owned files.
const CAPS_LOCAL: &[&str] = &["documents.read"];

// ---------------------------------------------------------------------------
// pdf_extract_text
// ---------------------------------------------------------------------------

const SCHEMA_EXTRACT_TEXT: &str = r#"{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Absolute or ~/ path to a PDF file."},
    "pages": {"type": "string", "description": "Page spec: 'all', '1-5', '3,7,9', or omit for all pages."}
  },
  "required": ["path"]
}"#;

fn invoke_extract_text<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = crate::agent_loop::helpers::string_arg(&input, "path")?;
        let pages = optional_string_arg(&input, "pages");
        crate::agent_loop::tools::documents::pdf_extract::extract_text(
            &path,
            pages.as_deref(),
        )
    })
}

inventory::submit! {
    ToolSpec {
        name: "pdf_extract_text",
        description: "Extract text from a PDF file, page by page. Returns JSON array of {page, text}. \
                       `pages` accepts 'all', '1-5', '3,7,9'. \
                       Password-protected PDFs return a clear error.",
        input_schema: SCHEMA_EXTRACT_TEXT,
        required_capabilities: CAPS_LOCAL,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: invoke_extract_text,
    }
}

// ---------------------------------------------------------------------------
// pdf_extract_tables
// ---------------------------------------------------------------------------

const SCHEMA_EXTRACT_TABLES: &str = r#"{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Absolute or ~/ path to a PDF file."},
    "page": {"type": "integer", "minimum": 1, "description": "1-based page number (default: 1)."}
  },
  "required": ["path"]
}"#;

fn invoke_extract_tables<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = crate::agent_loop::helpers::string_arg(&input, "path")?;
        let page = input.get("page").and_then(|v| v.as_u64()).map(|n| n as u32);
        crate::agent_loop::tools::documents::pdf_extract::extract_tables(&path, page)
    })
}

inventory::submit! {
    ToolSpec {
        name: "pdf_extract_tables",
        description: "Heuristic table extraction from a PDF page. Returns rows split by whitespace columns. \
                       Limitation: without a full rendering engine, complex multi-column layouts may be \
                       inaccurate — verify critical data manually. Scanned/image PDFs return empty rows.",
        input_schema: SCHEMA_EXTRACT_TABLES,
        required_capabilities: CAPS_LOCAL,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: invoke_extract_tables,
    }
}

// ---------------------------------------------------------------------------
// pdf_metadata
// ---------------------------------------------------------------------------

const SCHEMA_METADATA: &str = r#"{
  "type": "object",
  "properties": {
    "path": {"type": "string", "description": "Absolute or ~/ path to a PDF file."}
  },
  "required": ["path"]
}"#;

fn invoke_metadata<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = crate::agent_loop::helpers::string_arg(&input, "path")?;
        crate::agent_loop::tools::documents::pdf_extract::metadata(&path)
    })
}

inventory::submit! {
    ToolSpec {
        name: "pdf_metadata",
        description: "Return PDF metadata: title, author, creation_date, page_count from the Info dictionary.",
        input_schema: SCHEMA_METADATA,
        required_capabilities: CAPS_LOCAL,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: invoke_metadata,
    }
}
