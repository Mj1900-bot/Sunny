//! `file_compress` — L3, creates a zip archive from one or more files/folders.
//!
//! Wraps `zip -r`. Both the input paths and the output zip must be within
//! `$HOME` (or allowed sandbox roots).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.mutate"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "paths":      {
      "type": "array",
      "items": { "type": "string" },
      "description": "Files or folders to include in the archive."
    },
    "output_zip": { "type": "string", "description": "Output .zip path. Refused if it already exists." }
  },
  "required": ["paths", "output_zip"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let paths_val = input
            .get("paths")
            .and_then(|v| v.as_array())
            .ok_or("missing array arg `paths`")?;

        let raw_paths: Vec<String> = paths_val
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.to_string())
            .collect();

        if raw_paths.is_empty() {
            return Err("paths array must not be empty".to_string());
        }

        let raw_output = string_arg(&input, "output_zip")?;
        let output = super::path_guard::resolve_for_mutation(&raw_output)?;

        if output.exists() {
            return Err(format!(
                "file_compress: `{}` already exists — refusing to overwrite",
                output.display()
            ));
        }

        // Validate and resolve each source path.
        let mut resolved_paths: Vec<String> = Vec::with_capacity(raw_paths.len());
        for raw in &raw_paths {
            let p = super::path_guard::resolve(raw)?;
            if !p.exists() {
                return Err(format!("file_compress: source `{}` does not exist", p.display()));
            }
            resolved_paths.push(p.to_string_lossy().to_string());
        }

        let output_str = output.to_string_lossy().to_string();

        // Budget-gate: archive ops can be chained by agents cleaning up
        // directories in a loop.
        let _guard = crate::process_budget::SpawnGuard::acquire().await?;

        let mut cmd = tokio::process::Command::new("zip");
        cmd.arg("-r").arg(&output_str);
        for p in &resolved_paths {
            cmd.arg(p);
        }

        let status = cmd
            .status()
            .await
            .map_err(|e| format!("zip spawn failed: {e}"))?;

        if status.success() {
            Ok(format!("Created archive `{output_str}` from {} item(s).", resolved_paths.len()))
        } else {
            Err(format!("zip exited non-zero creating `{output_str}`"))
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_compress",
        description: "Compress files or folders into a .zip archive (`zip -r`). The output path must not already exist.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
