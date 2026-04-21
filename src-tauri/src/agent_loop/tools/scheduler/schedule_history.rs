//! `schedule_history` — return the last N completed run records across all schedules.
//!
//! Pulls from the `history` ring-buffer inside each `ScheduleEntry` and
//! merges them into one descending-order list so the agent can answer
//! "what did the 9am email check find this morning?" or audit why a
//! schedule hit the dead-letter queue.

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::store::load_schedules;

const CAPS: &[&str] = &["scheduler.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "description": "Max run records to return (default 20)"
    }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n.min(200) as usize)
            .unwrap_or(20);

        let entries = load_schedules()?;

        // Flatten all run records with schedule metadata.
        let mut records: Vec<Value> = entries
            .iter()
            .flat_map(|e| {
                e.history.iter().map(move |r| {
                    json!({
                        "schedule_id": e.id,
                        "schedule_title": e.title,
                        "fired_at": r.fired_at,
                        "status": r.status,
                        "summary": r.summary,
                    })
                })
            })
            .collect();

        // Sort descending by fired_at.
        records.sort_by(|a, b| {
            let ta = a.get("fired_at").and_then(|v| v.as_i64()).unwrap_or(0);
            let tb = b.get("fired_at").and_then(|v| v.as_i64()).unwrap_or(0);
            tb.cmp(&ta)
        });

        records.truncate(limit);

        Ok(json!({
            "count": records.len(),
            "runs": records,
        })
        .to_string())
    })
}

inventory::submit! {
    ToolSpec {
        name: "schedule_history",
        description: "Return the last N completed scheduled run records (default 20). Includes status ('ok'/'error'), fired_at timestamp, and agent summary for each run.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
