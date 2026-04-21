//! `trash_file` — L3, moves a file to `~/.Trash` (reversible).
//!
//! Unlike `file_delete` (L4, permanent), this is reversible from Finder.
//! Refuses to trash top-level user directories (`$HOME`, Documents, Desktop,
//! Downloads).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.mutate"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File or folder to move to Trash." }
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;
        let src = super::path_guard::resolve_for_mutation(&raw)?;

        if !src.exists() {
            return Err(format!("trash_file: `{}` does not exist", src.display()));
        }

        // Guard against trashing top-level user directories.
        let home = dirs::home_dir()
            .ok_or("trash_file: could not resolve $HOME")?;

        let protected: [std::path::PathBuf; 4] = [
            home.clone(),
            home.join("Documents"),
            home.join("Desktop"),
            home.join("Downloads"),
        ];
        for guarded in &protected {
            if &src == guarded {
                return Err(format!(
                    "trash_file: refusing to trash top-level user directory `{}`",
                    src.display()
                ));
            }
        }

        let trash_dir = home.join(".Trash");
        let file_name = src
            .file_name()
            .ok_or_else(|| format!("trash_file: cannot determine filename of `{}`", src.display()))?;
        let mut dst = trash_dir.join(file_name);

        // If a file with the same name already exists in Trash, disambiguate.
        if dst.exists() {
            let stem = dst
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let ext = dst
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let ts = chrono::Utc::now().timestamp();
            dst = trash_dir.join(format!("{stem}_{ts}{ext}"));
        }

        std::fs::rename(&src, &dst).map_err(|e| {
            format!(
                "trash_file `{}` → Trash failed: {e}",
                src.display()
            )
        })?;

        Ok(format!(
            "Moved `{}` to Trash as `{}`.",
            src.display(),
            dst.display()
        ))
    })
}

inventory::submit! {
    ToolSpec {
        name: "trash_file",
        description: "Move a file or folder to ~/.Trash (reversible). Refuses to trash $HOME or top-level user directories. Use this instead of permanent deletion.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
