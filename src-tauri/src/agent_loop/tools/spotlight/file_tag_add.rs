//! `file_tag_add` — L2, adds Finder colored tags to a file.
//!
//! Tags are appended to any existing tags (deduped). Uses
//! `com.apple.metadata:_kMDItemUserTags` xattr with binary plist encoding.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.tags"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File or folder path." },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Tag names to add (e.g. [\"Red\", \"Work\"])."
    }
  },
  "required": ["path", "tags"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;

        let tags_val = input
            .get("tags")
            .and_then(|v| v.as_array())
            .ok_or("missing array arg `tags`")?;

        let new_tags: Vec<String> = tags_val
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.to_string())
            .collect();

        if new_tags.is_empty() {
            return Err("tags array must not be empty".to_string());
        }

        // Path must be safe to read (tags are a metadata write, not a content write).
        let resolved = super::path_guard::resolve(&raw)?;
        let path_str = resolved.to_string_lossy().to_string();

        if !resolved.exists() {
            return Err(format!("file_tag_add: `{path_str}` does not exist"));
        }

        let all_tags = super::tags::add_tags(&path_str, &new_tags).await?;
        Ok(format!(
            "Tags on `{path_str}`: {:?}",
            all_tags
        ))
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_tag_add",
        description: "Add one or more Finder colored tags to a file or folder. Tags are appended to existing tags (no duplicates).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
