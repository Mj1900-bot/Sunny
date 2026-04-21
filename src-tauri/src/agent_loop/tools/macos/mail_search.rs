//! `mail_search` — search Mail.app messages.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.mail"];

const SCHEMA: &str = r#"{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = string_arg(&input, "query")?;
        let limit = usize_arg(&input, "limit");
        let msgs = crate::mail::search_messages(query, limit).await?;
        serde_json::to_string(&msgs).map_err(|e| format!("mail search encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "mail_search",
        description: "USE THIS when Sunny says 'find the email from X', 'search my mail for Y', 'did anyone email me about Z', 'where's that receipt from last month'. Returns matching Mail.app messages (sender, subject, date, snippet) from Sunny's mailboxes.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
