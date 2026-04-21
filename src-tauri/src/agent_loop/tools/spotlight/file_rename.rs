//! `file_rename` — L3, renames a file/folder in place.
//!
//! `new_name` must be a bare filename (no path separators) to prevent
//! accidental relocation.  The renamed path must not already exist.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.mutate"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path":     { "type": "string", "description": "File or folder to rename." },
    "new_name": { "type": "string", "description": "New bare filename (no slashes)." }
  },
  "required": ["path", "new_name"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;
        let new_name = string_arg(&input, "new_name")?;

        // new_name must not contain path separators or null bytes.
        if new_name.contains('/') || new_name.contains('\0') {
            return Err(format!(
                "file_rename: new_name `{new_name}` must be a bare filename with no path separators"
            ));
        }
        if new_name == "." || new_name == ".." {
            return Err("file_rename: new_name cannot be `.` or `..`".to_string());
        }

        let src = super::path_guard::resolve_for_mutation(&raw)?;

        if !src.exists() {
            return Err(format!(
                "file_rename: `{}` does not exist",
                src.display()
            ));
        }

        let parent = src.parent().ok_or_else(|| {
            format!("file_rename: cannot determine parent of `{}`", src.display())
        })?;
        let dst = parent.join(&new_name);

        // Validate dst is also safe (re-uses the same parent, but we verify).
        super::path_guard::resolve_for_mutation(&dst.to_string_lossy())?;

        if dst.exists() {
            return Err(format!(
                "file_rename: `{}` already exists — refusing to overwrite",
                dst.display()
            ));
        }

        std::fs::rename(&src, &dst).map_err(|e| {
            format!(
                "file_rename `{}` → `{}` failed: {e}",
                src.display(),
                dst.display()
            )
        })?;

        Ok(format!(
            "Renamed `{}` → `{}`.",
            src.display(),
            dst.display()
        ))
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_rename",
        description: "Rename a file or folder in place. `new_name` must be a bare filename (no slashes). Refuses if the new name already exists.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
