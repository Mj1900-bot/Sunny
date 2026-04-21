//! `mail_send` — send an email via Mail.app. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.mail.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"to":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"},"cc":{"type":"string"}},"required":["to","subject","body"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let to = string_arg(&input, "to")?;
        let subject = string_arg(&input, "subject")?;
        let body = string_arg(&input, "body")?;
        let cc = optional_string_arg(&input, "cc");
        crate::tools_macos::mail_send(to, subject, body, cc).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "mail_send",
        description: "Send an email via Mail.app. Use when Sunny says 'email X', 'reply to this email', or drafts outbound mail. Always confirms before sending. Pass the recipient's name directly; the tool resolves contacts internally. Do NOT call contacts_lookup first.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
