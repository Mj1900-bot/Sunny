//! Tool registration for `xlsx_read`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::optional_string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["documents.read"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path":  {"type": "string",  "description": "Absolute or ~/ path to an XLSX/XLS/ODS file."},
    "sheet": {"type": "string",  "description": "Sheet name or 0-based index. Default: first sheet."},
    "range": {"type": "string",  "description": "A1-notation range, e.g. 'A1:D20'. Default: entire sheet."}
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path  = crate::agent_loop::helpers::string_arg(&input, "path")?;
        let sheet = optional_string_arg(&input, "sheet");
        let range = optional_string_arg(&input, "range");
        crate::agent_loop::tools::documents::xlsx_read::read(
            &path,
            sheet.as_deref(),
            range.as_deref(),
        )
    })
}

inventory::submit! {
    ToolSpec {
        name: "xlsx_read",
        description: "Read rows from an XLSX, XLS, or ODS spreadsheet via calamine. \
                       Returns `{ sheet, sheets, rows }`. \
                       `sheet` is a name or 0-based index. `range` is A1:B5 notation.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
