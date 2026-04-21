//! `page_action` — ask the currently-visible HUD page to run an action.

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["hud.navigate"];

const SCHEMA: &str = r#"{"type":"object","properties":{"view":{"type":"string","description":"Target page (must match a ViewKey, e.g. 'calendar')."},"action":{"type":"string","description":"Action name recognised by that page."},"args":{"type":"object","description":"Optional per-action argument bag."}},"required":["view","action"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    let app = ctx.app.clone();
    Box::pin(async move {
        let view = string_arg(&input, "view")?;
        let action = string_arg(&input, "action")?;
        if !crate::nav::view_supports_actions(&view) {
            return Err(format!(
                "page_action: not implemented for view `{view}` (currently only calendar, tasks, inbox subscribe to nav.action)"
            ));
        }
        let args = input.get("args").cloned().unwrap_or(json!({}));
        crate::nav::emit_nav_action(&app, &view, &action, &args);
        Ok(format!("dispatched `{action}` to `{view}`"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_action",
        description: "Ask the currently-visible HUD page to run an imperative action on itself. Each page subscribes to a narrow set of actions; unsupported view/action pairs return a structured 'not implemented' error so you can fall back to speech. Currently wired: calendar (jump_to_date {iso}, create_event {title?,start?,end?}, filter_by_calendar {name,hidden?}), tasks (create_task {title,list?}, complete_task {id}, filter_tab {tab: today|next7|someday|overdue|done}), inbox (filter {tab?: all|unread|mail|chat, triage?: all|urgent|important|later|ignore, starsOnly?: boolean}, triage_all {}). Always prefer this over a spoken instruction when Sunny asks the HUD to do something it can do itself.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
