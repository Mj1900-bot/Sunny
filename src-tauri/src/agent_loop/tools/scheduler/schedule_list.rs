//! `schedule_list` — list pending and recently-fired schedules.
//!
//! Input schema:
//! ```json
//! { "include_past": false }
//! ```
//! Returns a JSON array of schedule entries with `next_fire_human` for display.

use chrono::{DateTime, Utc, TimeZone};
use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::store::{load_schedules, now_unix};

const CAPS: &[&str] = &["scheduler.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "include_past": {
      "type": "boolean",
      "description": "When true, also include once-schedules that have already fired"
    }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let include_past = input
            .get("include_past")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let entries = load_schedules()?;
        let now = now_unix();

        let items: Vec<Value> = entries
            .iter()
            .filter(|e| include_past || e.enabled || e.next_fire.is_some())
            .map(|e| {
                let next_fire_human = e
                    .next_fire
                    .and_then(|ts| Utc.timestamp_opt(ts, 0).single())
                    .map(|dt: DateTime<Utc>| dt.format("%Y-%m-%d %H:%M UTC").to_string())
                    .unwrap_or_else(|| "—".to_string());

                let last_run = e
                    .history
                    .last()
                    .map(|r| {
                        json!({
                            "fired_at": r.fired_at,
                            "status": r.status,
                            "summary": r.summary,
                        })
                    })
                    .unwrap_or(Value::Null);

                json!({
                    "id": e.id,
                    "title": e.title,
                    "kind": e.kind,
                    "prompt_preview": e.prompt.chars().take(80).collect::<String>(),
                    "enabled": e.enabled,
                    "dead_letter": e.dead_letter,
                    "fail_count": e.fail_count,
                    "next_fire": e.next_fire,
                    "next_fire_human": next_fire_human,
                    "requires_confirm": e.requires_confirm,
                    "last_run": last_run,
                    "daemon_id": e.daemon_id,
                    "overdue": e.next_fire.map(|t| t < now).unwrap_or(false),
                })
            })
            .collect();

        Ok(json!({
            "count": items.len(),
            "schedules": items,
        })
        .to_string())
    })
}

inventory::submit! {
    ToolSpec {
        name: "schedule_list",
        description: "List pending and recent schedules. Returns each entry with next_fire_human timestamp and dead-letter flag. Pass include_past=true to see already-fired once-schedules.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
