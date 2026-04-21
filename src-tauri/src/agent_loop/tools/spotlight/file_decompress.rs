//! `file_decompress` — L3, extracts a .zip archive.
//!
//! Wraps `unzip`. The output directory defaults to the zip's parent dir.
//! Both the zip path and the output directory must be within `$HOME`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.mutate"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "zip_path":   { "type": "string", "description": "Path to the .zip archive." },
    "output_dir": { "type": "string", "description": "Directory to extract into. Defaults to the zip's parent directory." }
  },
  "required": ["zip_path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw_zip = string_arg(&input, "zip_path")?;
        let zip_path = super::path_guard::resolve(&raw_zip)?;

        if !zip_path.exists() {
            return Err(format!(
                "file_decompress: `{}` does not exist",
                zip_path.display()
            ));
        }

        let output_dir = match optional_string_arg(&input, "output_dir") {
            Some(raw_out) => super::path_guard::resolve_for_mutation(&raw_out)?,
            None => {
                // Default: parent of the zip file.
                let parent = zip_path.parent().ok_or_else(|| {
                    format!(
                        "file_decompress: cannot determine parent of `{}`",
                        zip_path.display()
                    )
                })?;
                super::path_guard::resolve_for_mutation(&parent.to_string_lossy())?
            }
        };

        let zip_str = zip_path.to_string_lossy().to_string();
        let out_str = output_dir.to_string_lossy().to_string();

        let status = tokio::process::Command::new("unzip")
            .args(["-q", &zip_str, "-d", &out_str])
            .status()
            .await
            .map_err(|e| format!("unzip spawn failed: {e}"))?;

        if status.success() {
            Ok(format!("Extracted `{zip_str}` into `{out_str}`."))
        } else {
            Err(format!("unzip exited non-zero for `{zip_str}`"))
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_decompress",
        description: "Extract a .zip archive (`unzip`). Output directory defaults to the zip's parent folder.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
