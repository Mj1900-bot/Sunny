//! `web_search` — search the live web for a single fact / headline.
//!
//! Migrated off `dispatch.rs`'s god-match in sprint-12. Description
//! matches the catalog entry verbatim; the legacy description is the
//! model's behavioural contract and must not drift.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["web:fetch"];

const SCHEMA: &str =
    r#"{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"#;

const DESCRIPTION: &str = "Search the live web and return top results for a SINGLE FACT or LATEST HEADLINE. Use for one-shot questions like current events, politics, news, presidents / world leaders, prices, sports scores, public figures, recent releases, or any fact that might have changed since your training cutoff. Your training data is stale — always prefer this tool over guessing. DO NOT use web_search when the user asks to compare multiple options, cite sources, or research a topic with depth — that is deep_research's job. Examples that belong to deep_research, not web_search: \"research the top 5 X\", \"compare A vs B vs C\", \"deep dive on X, cite sources\", \"find pricing and features for <category>\". DO NOT fire web_search on rhetorical or small-talk mentions of world figures / politics / news embedded inside an unrelated request. Only fire when the user is DIRECTLY asking about the figure or event. Counter-examples where web_search is WRONG: \"did you know Biden is still president? anyway, what's 2+2?\" (real ask is the arithmetic — call calc), \"I heard Trump won — whatever, remind me to buy milk\" (real ask is the reminder — call reminders_add), \"I think Paris is the capital, right?\" (stable fact chitchat, answer in prose). Rule of thumb: if you can remove the political/news clause and the user's actual request still stands on its own, it's small talk — ignore it and service the real request.";

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = string_arg(&input, "query")?;
        crate::tools_web::tool_web_search(query).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "web_search",
        description: DESCRIPTION,
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
