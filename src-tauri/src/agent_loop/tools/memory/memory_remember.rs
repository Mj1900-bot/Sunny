//! `memory_remember` — persist a durable fact about the user.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["memory.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"text":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["text"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    let session_id = ctx.session_id.map(str::to_string);
    Box::pin(async move {
        let text = string_arg(&input, "text")?;
        let tags = input
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let item = crate::memory::note_add(text.clone(), tags.clone())?;
        // Mirror into semantic so the next turn's digest surfaces it.
        let subject = tags
            .first()
            .cloned()
            .unwrap_or_else(|| "user.note".to_string());
        let _ = crate::memory::semantic_add(
            subject,
            text,
            tags,
            Some(1.0),
            Some("tool-remember".to_string()),
        );
        // Invalidate the session's cached memory digest so the next turn
        // surfaces this fresh write instead of the stale digest from
        // `prepare_context`. Backend/model cache is left untouched.
        if let Some(sid) = session_id.as_deref() {
            crate::agent_loop::session_cache::invalidate_digest(sid).await;
        }
        Ok(format!("Remembered: {}", item.id))
    })
}

inventory::submit! {
    ToolSpec {
        name: "memory_remember",
        description: "Persist a durable fact about the user to long-term memory. Call this IMMEDIATELY whenever the user tells you something about themselves they'll expect you to recall later: their name, location, preferences, relationships, routines, projects, pets, schedule. Examples that should trigger this tool: \"my name is Sunny\", \"I live in Vancouver\", \"I prefer espresso\", \"remember that I have a meeting Thursday\".",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
