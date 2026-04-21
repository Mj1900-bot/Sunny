//! `notes_create` — create a new Apple Note. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.notes.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"folder":{"type":"string"}},"required":["title","body"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "title")?;
        let body = string_arg(&input, "body")?;
        let folder = optional_string_arg(&input, "folder");
        let note = crate::notes_app::create_note(title, body, folder).await?;
        Ok(format!("Created note \"{}\" ({})", note.name, note.id))
    })
}

inventory::submit! {
    ToolSpec {
        name: "notes_create",
        description: "Create a new Apple Note with title and body.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
