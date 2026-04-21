//! `mail_list_unread` — list unread messages in Sunny's Mail.app inbox.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::u32_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.mail"];

const SCHEMA: &str = r#"{"type":"object","properties":{"limit":{"type":"integer"}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let limit = u32_arg(&input, "limit");
        crate::tools_macos::mail_list_unread(limit).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "mail_list_unread",
        description: "USE THIS when Sunny says 'what's in my inbox', 'any new mail', 'check my email', 'read me my unreads'. Returns a list of unread messages from Sunny's Mail.app inbox (sender, subject, snippet).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
