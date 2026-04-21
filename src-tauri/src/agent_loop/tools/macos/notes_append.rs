//! `notes_append` — append text to an existing Apple Note by title match.
//! DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.notes.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string"},"text":{"type":"string"}},"required":["title","text"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "title")?;
        let text = string_arg(&input, "text")?;
        let matches = crate::notes_app::search_notes(title.clone(), Some(1)).await?;
        let note = matches
            .into_iter()
            .next()
            .ok_or_else(|| format!("no note matching title: {title}"))?;
        crate::notes_app::append_to_note(note.id.clone(), text).await?;
        Ok(format!("Appended to note \"{}\"", note.name))
    })
}

inventory::submit! {
    ToolSpec {
        name: "notes_append",
        description: "Append text to an existing Apple Note by title match.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
