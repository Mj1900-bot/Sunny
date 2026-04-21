//! `agent_message` — post a message into another sub-agent's inbox.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::dialogue;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["agent.dialogue"];

const SCHEMA: &str = r#"{"type":"object","properties":{"to":{"type":"string","description":"Recipient agent id — a sub-agent uuid or the literal string 'main'."},"content":{"type":"string","description":"Body of the message (max 4000 chars). Plain text; the receiver sees it tagged with your agent id."}},"required":["to","content"]}"#;

/// Strip the `agent:` prefix from `ToolCtx::initiator` to recover the
/// raw sub-agent uuid / "main". The legacy dispatcher passed
/// `requesting_agent.as_deref().unwrap_or(MAIN_AGENT_ID)` — this
/// mirrors that behaviour from the trait's initiator naming scheme.
fn initiator_agent_id<'a>(initiator: &'a str) -> &'a str {
    initiator
        .strip_prefix("agent:")
        .unwrap_or(dialogue::MAIN_AGENT_ID)
}

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    let from = initiator_agent_id(ctx.initiator).to_string();
    Box::pin(async move {
        let to = string_arg(&input, "to")?;
        let content = string_arg(&input, "content")?;
        dialogue::post_message(&from, &to, &content)?;
        Ok(format!(
            "message queued for agent `{to}` ({} char body)",
            content.chars().count()
        ))
    })
}

inventory::submit! {
    ToolSpec {
        name: "agent_message",
        description: "Post a message into another running sub-agent's inbox. Unlike spawn_subagent (fire-and-forget), this lets siblings coordinate mid-task — e.g. ask a critic 'what do you think of this draft so far?' or feed a researcher a new constraint. The recipient sees your message on its next turn as a user-role history entry tagged `[dialogue: from agent <your-id>]`. Use when you've already spawned one or more sub-agents and want to nudge, question, or reroute them while they're still running. Recipient id is the uuid returned / emitted when the sub-agent started (or the literal string \"main\" to message the top-level agent). The content body is capped at 4000 chars; longer payloads are truncated with a marker. Returns a short ack string on success, or a structured error if the recipient isn't registered (finished / never spawned). Not dangerous — no side effects outside the agent-loop dialogue state.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
