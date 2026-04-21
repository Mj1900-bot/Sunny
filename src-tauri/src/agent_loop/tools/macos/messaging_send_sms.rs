//! `messaging_send_sms` — send an SMS via Messages.app. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.messaging.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"to":{"type":"string"},"body":{"type":"string"}},"required":["to","body"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let to = string_arg(&input, "to")?;
        let body = string_arg(&input, "body")?;
        crate::messaging::send_sms(to, body)
            .await
            .map(|_| "SMS sent.".to_string())
    })
}

inventory::submit! {
    ToolSpec {
        name: "messaging_send_sms",
        description: "Send an SMS via Messages.app. Pass the recipient's name directly; the tool resolves contacts internally. Do NOT call contacts_lookup first.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
