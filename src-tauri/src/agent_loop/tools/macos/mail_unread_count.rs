//! `mail_unread_count` — count unread emails across all accounts.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.mail"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        crate::mail::unread_count()
            .await
            .map(|n| format!("{n} unread message(s)"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "mail_unread_count",
        description: "Return the count of unread emails across all accounts.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
