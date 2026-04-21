//! `shortcut_list` — list all user Shortcuts with folder membership.
//! L0 (read-only metadata, no side effects).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["shortcut:run"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let entries = super::core::shortcut_list().await?;
        if entries.is_empty() {
            return Ok("No Shortcuts found.".to_string());
        }
        let lines: Vec<String> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| match &e.folder {
                Some(f) => format!("{}. {} [{}]", i + 1, e.name, f),
                None => format!("{}. {}", i + 1, e.name),
            })
            .collect();
        Ok(lines.join("\n"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "shortcut_list",
        description: "List all macOS Shortcuts the user has created, with folder grouping.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
