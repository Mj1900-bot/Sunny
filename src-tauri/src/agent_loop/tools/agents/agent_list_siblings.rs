//! `agent_list_siblings` — list peer sub-agent ids spawned by the
//! same parent.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::dialogue;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["agent.dialogue"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    let me = ctx
        .initiator
        .strip_prefix("agent:")
        .unwrap_or(dialogue::MAIN_AGENT_ID)
        .to_string();
    Box::pin(async move {
        let siblings = dialogue::list_siblings(&me).await;
        serde_json::to_string(&siblings)
            .map_err(|e| format!("agent_list_siblings encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "agent_list_siblings",
        description: "List the ids of every other sub-agent spawned by the same parent as you. Returns a JSON array of uuids (empty when you have no peers). Pair with `agent_broadcast` to coordinate mid-task without the parent having to hand-hold every message.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
