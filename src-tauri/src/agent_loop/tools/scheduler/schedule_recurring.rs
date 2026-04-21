//! `schedule_recurring` — schedule a repeating agent run.
//!
//! `cron` accepts standard 5-field cron ("0 9 * * *") or NL phrases:
//!   "every day at 9am", "every morning", "every weekday morning",
//!   "every Monday 10am", "every Friday 8:30pm", "every hour",
//!   "every 30 minutes", "every 2 hours", "every weekend at 10am".

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::settings_store;

use super::parse_time::{parse_natural_cron, CronSchedule};
use super::store::{
    new_id, now_unix, save_schedules, load_schedules, ScheduleEntry, ScheduleKind,
};
use super::schedule_once::log_to_continuity;

const CAPS: &[&str] = &["scheduler.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "cron": { "type": "string", "description": "Cron expression or NL: 'every day at 9am', 'every weekday morning', '0 9 * * *'" },
    "prompt": { "type": "string", "description": "The agent prompt to run on each fire" },
    "title": { "type": "string", "description": "Optional short label" }
  },
  "required": ["cron", "prompt"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let cron_str = string_arg(&input, "cron")?;
        let prompt = string_arg(&input, "prompt")?;
        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| prompt.chars().take(50).collect());

        let schedule = parse_natural_cron(&cron_str)
            .map_err(|e| format!("schedule_recurring: cannot parse cron: {e}"))?;

        let now = now_unix();
        let next_fire = schedule.next_after(now);
        let cron_wire = schedule.to_wire();

        // Consult trust level.
        let settings = settings_store::get();
        let requires_confirm = matches!(settings.trust_level, settings_store::TrustLevel::ConfirmAll);

        // Create underlying daemon.  We encode the schedule as an interval
        // when the cron resolves to IntervalSecs; otherwise we store it as
        // an `on_event` daemon (frontend polls `schedule_list` to fire it).
        // The `every_sec` field drives daemons.rs's own next_run computation.
        let (daemon_kind, every_sec, at): (&str, Option<u64>, Option<i64>) = match &schedule {
            CronSchedule::IntervalSecs(s) => ("interval", Some(*s), None),
            _ => {
                // Non-interval: store as interval with a synthetic every_sec
                // derived from the next two fire times so the daemon layer also
                // advances roughly correctly.  The definitive next_fire lives in
                // the schedule entry.
                let approx = schedule
                    .next_after(next_fire.unwrap_or(now))
                    .and_then(|t2| Some(t2 - next_fire.unwrap_or(now)))
                    .map(|d| d.max(60) as u64)
                    .unwrap_or(86400);
                ("interval", Some(approx), next_fire)
            }
        };

        let daemon_spec = crate::daemons::DaemonSpec {
            title: title.clone(),
            kind: daemon_kind.to_string(),
            at,
            every_sec,
            on_event: None,
            goal: prompt.clone(),
            max_runs: None,
        };
        let daemon = crate::daemons::daemons_add(daemon_spec).await?;

        let entry = ScheduleEntry {
            id: new_id(),
            title: title.clone(),
            prompt,
            kind: ScheduleKind::Recurring,
            cron_wire: Some(cron_wire),
            fire_at: None,
            next_fire,
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

        log_to_continuity(&entry, "recurring");

        Ok(json!({
            "schedule_id": entry.id,
            "daemon_id": daemon.id,
            "next_fire": next_fire,
            "cron_wire": entry.cron_wire,
            "title": title,
            "requires_confirm": requires_confirm,
        })
        .to_string())
    })
}

inventory::submit! {
    ToolSpec {
        name: "schedule_recurring",
        description: "Schedule a repeating agent run. 'cron' accepts '0 9 * * *' OR NL like 'every day at 9am', 'every weekday morning', 'every Monday 10am', 'every hour'. Returns schedule_id.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
