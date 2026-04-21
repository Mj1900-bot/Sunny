//! `schedule_once` — schedule a one-shot agent run at an absolute or relative time.
//!
//! Trust level L2 for L0-L2 prompt-only schedules; the tool itself is L3
//! (dangerous=true) because the act of scheduling may commit to future L3+
//! tool invocations.  Execution-time gating is enforced by
//! `requires_confirm` in the `ScheduleEntry` and by the trust-level check
//! inside `schedule_recurring` / `schedule_once` that reads `SunnySettings`.
//!
//! Input schema:
//! ```json
//! { "when": "in 2 hours", "prompt": "call mom", "title": "Call reminder" }
//! ```
//! `when` accepts NL time ("in 30 min", "tomorrow 9am", "monday 10am") or
//! a unix epoch integer as a string ("1745003600").

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::settings_store;

use super::parse_time::parse_natural_time;
use super::store::{
    new_id, now_unix, save_schedules, load_schedules, ScheduleEntry, ScheduleKind,
};

const CAPS: &[&str] = &["scheduler.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "when": { "type": "string", "description": "NL time: 'in 30 min', 'tomorrow 9am', 'monday 10am', or unix epoch" },
    "prompt": { "type": "string", "description": "The agent prompt to run at that time" },
    "title": { "type": "string", "description": "Optional short label shown in schedule list" }
  },
  "required": ["when", "prompt"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let when_str = string_arg(&input, "when")?;
        let prompt = string_arg(&input, "prompt")?;
        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| prompt.chars().take(50).collect());

        let now = now_unix();

        // Parse `when` — try unix-epoch string first, then NL.
        let fire_at: i64 = if let Ok(ts) = when_str.parse::<i64>() {
            ts
        } else {
            parse_natural_time(&when_str, now)
                .map_err(|e| format!("schedule_once: cannot parse `when`: {e}"))?
        };

        if fire_at <= now {
            return Err(format!(
                "schedule_once: fire time {fire_at} is in the past (now={now})"
            ));
        }

        // Consult trust level — ConfirmAll schedules get requires_confirm=true.
        let settings = settings_store::get();
        let requires_confirm = matches!(settings.trust_level, settings_store::TrustLevel::ConfirmAll);

        // Create the underlying daemon (once, fire_at absolute time).
        let daemon_spec = crate::daemons::DaemonSpec {
            title: title.clone(),
            kind: "once".to_string(),
            at: Some(fire_at),
            every_sec: None,
            on_event: None,
            goal: prompt.clone(),
            max_runs: Some(1),
        };
        let daemon = crate::daemons::daemons_add(daemon_spec).await?;

        // Record in schedules store.
        let entry = ScheduleEntry {
            id: new_id(),
            title: title.clone(),
            prompt,
            kind: ScheduleKind::Once,
            cron_wire: None,
            fire_at: Some(fire_at),
            next_fire: Some(fire_at),
            enabled: true,
            fail_count: 0,
            dead_letter: false,
            daemon_id: daemon.id.clone(),
            requires_confirm,
            history: vec![],
            created_at: now,
        };

        let mut entries = load_schedules()?;
        entries.push(entry.clone());
        save_schedules(&entries)?;

        // Log to continuity graph.
        log_to_continuity(&entry, "once");

        Ok(json!({
            "schedule_id": entry.id,
            "daemon_id": daemon.id,
            "fire_at": fire_at,
            "title": title,
            "requires_confirm": requires_confirm,
        })
        .to_string())
    })
}

pub(super) fn log_to_continuity(entry: &ScheduleEntry, kind: &str) {
    if let Some(store) = crate::memory::continuity_store::global() {
        if let Ok(s) = store.lock() {
            let slug = format!("scheduled-{}", entry.id);
            let summary = format!(
                "Scheduled {kind} agent run: \"{}\". Prompt: {}. #scheduled",
                entry.title, entry.prompt
            );
            let _ = s.upsert_node(
                crate::memory::continuity_store::NodeKind::Session,
                &slug,
                &entry.title,
                &summary,
                &["scheduled"],
            );
        }
    }
}



inventory::submit! {
    ToolSpec {
        name: "schedule_once",
        description: "Schedule a one-shot agent run at a future time. 'when' accepts NL ('in 2 hours', 'tomorrow 9am', 'monday 10am') or a unix epoch. Returns schedule_id.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
