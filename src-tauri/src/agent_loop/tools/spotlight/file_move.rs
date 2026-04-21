//! `file_move` — L3, moves a file/folder to a new location.
//!
//! Refuses to overwrite an existing destination (confirm-gated + clobber check).
//! Both src and dst are validated through `path_guard::resolve_for_mutation`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.mutate"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "src": { "type": "string", "description": "Source path." },
    "dst": { "type": "string", "description": "Destination path. Refused if it already exists." }
  },
  "required": ["src", "dst"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw_src = string_arg(&input, "src")?;
        let raw_dst = string_arg(&input, "dst")?;

        let src = super::path_guard::resolve_for_mutation(&raw_src)?;
        let dst = super::path_guard::resolve_for_mutation(&raw_dst)?;

        if !src.exists() {
            return Err(format!(
                "file_move: source `{}` does not exist",
                src.display()
            ));
        }
        if dst.exists() {
            return Err(format!(
                "file_move: destination `{}` already exists — refusing to overwrite",
                dst.display()
            ));
        }

        std::fs::rename(&src, &dst).map_err(|e| {
            format!(
                "file_move `{}` → `{}` failed: {e}",
                src.display(),
                dst.display()
            )
        })?;

        Ok(format!(
            "Moved `{}` → `{}`.",
            src.display(),
            dst.display()
        ))
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_move",
        description: "Move a file or folder to a new path. Refuses if the destination already exists. Both paths must be within $HOME.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
