//! `imessage_send` — send an iMessage/SMS via Messages.app. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.messaging.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"recipient":{"type":"string","description":"Phone number, email, or contact name — pass the user's exact phrasing, do not resolve or look up first"},"body":{"type":"string"}},"required":["recipient","body"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let recipient = string_arg(&input, "recipient")?;
        let body = string_arg(&input, "body")?;
        crate::tools_macos::imessage_send(recipient, body).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "imessage_send",
        description: "Send an iMessage/SMS to a contact via Messages.app. Use when Sunny says 'text X', 'message Y', 'let Z know' — call this IMMEDIATELY on the first turn, do not plan, do not look up the person first. Trust the user's phrasing; pass their exact words verbatim as the recipient (e.g. \"Sunny's daughter\", \"Matt\", \"the dentist\") — the tool resolves contacts internally. Do NOT call contacts_lookup OR memory_recall first to find out who the recipient IS; that is the tool's job, not yours. Always confirms before sending.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
