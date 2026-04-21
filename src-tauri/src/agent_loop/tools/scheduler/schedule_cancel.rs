//! `schedule_cancel` — cancel a pending schedule by id.
//!
//! Disables the entry in `schedules.json` and deletes the corresponding
//! daemon from `daemons.json` so it doesn't fire.

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::store::{load_schedules, save_schedules};

const CAPS: &[&str] = &["scheduler.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "id": { "type": "string", "description": "The schedule_id returned by schedule_once or schedule_recurring" }
  },
  "required": ["id"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id = string_arg(&input, "id")?;

        let mut entries = load_schedules()?;
        let idx = entries
            .iter()
            .position(|e| e.id == id)
            .ok_or_else(|| format!("schedule_cancel: no schedule with id={id:?}"))?;

        let daemon_id = entries[idx].daemon_id.clone();
        let title = entries[idx].title.clone();

        // Remove from schedules.
        entries.remove(idx);
        save_schedules(&entries)?;

        // Remove the corresponding daemon.
        let daemon_result = crate::daemons::daemons_delete(daemon_id.clone()).await;
        if let Err(e) = daemon_result {
            // Daemon may already be gone — log but don't fail the user.
            log::warn!("[schedule_cancel] daemon {daemon_id} delete failed (already gone?): {e}");
        }

        Ok(json!({
            "cancelled": true,
            "id": id,
            "title": title,
        })
        .to_string())
    })
}

inventory::submit! {
    ToolSpec {
        name: "schedule_cancel",
        description: "Cancel a pending schedule by its schedule_id. Also removes the underlying daemon so it will not fire.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
