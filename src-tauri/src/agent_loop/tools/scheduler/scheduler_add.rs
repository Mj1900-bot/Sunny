//! `scheduler_add` — schedule a recurring or one-shot task. DANGEROUS.
//!
//! Maps the public/tooling schema `{name, cron, action, payload}` onto
//! the Rust scheduler API `{title, kind, at, every_sec, action}`. Only
//! interval-seconds "cron" is supported today; richer crontab syntax
//! returns a structured error.

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["scheduler.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"name":{"type":"string","description":"Short label for the scheduled job."},"interval_seconds":{"type":"integer","minimum":1,"description":"Fire every N seconds. Preferred over the legacy `cron` field."},"cron":{"type":"string","description":"DEPRECATED — legacy field. Accepts only an integer-as-string (seconds). Use interval_seconds instead."},"action":{"type":"string","description":"What to run: 'shell' or 'notify'."},"payload":{"type":"object","description":"Action-specific args. shell: {cmd: string}. notify: {title?: string, body?: string}."}},"required":["name","action"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "name")?;
        let action_kind = string_arg(&input, "action")?;
        let payload = input
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        // Prefer the modern `interval_seconds` integer. Fall back to
        // the legacy `cron` field which historically only accepted an
        // integer-as-string (real crontab syntax was never implemented).
        let every_sec: u64 = match input.get("interval_seconds").and_then(|v| v.as_u64()) {
            Some(n) if n > 0 => n,
            Some(_) => return Err("scheduler_add: interval_seconds must be >= 1".to_string()),
            None => {
                let cron = string_arg(&input, "cron").map_err(|_| {
                    "scheduler_add: provide `interval_seconds` (preferred) or the legacy `cron` field".to_string()
                })?;
                cron.parse::<u64>().map_err(|_| {
                    format!(
                        "scheduler_add: cron `{cron}` not supported — real cron syntax is not implemented; pass interval_seconds instead"
                    )
                })?
            }
        };
        let (kind_str, at, every_sec) = ("interval".to_string(), None, Some(every_sec));

        let action_value = match action_kind.as_str() {
            "shell" => {
                let cmd = payload
                    .get("cmd")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "shell action requires payload.cmd".to_string())?;
                json!({"type":"Shell","data":{"cmd":cmd}})
            }
            "notify" => {
                let t = payload
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("SUNNY");
                let b = payload
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                json!({"type":"Notify","data":{"title":t,"body":b}})
            }
            other => {
                return Err(format!("scheduler_add: action `{other}` not implemented"))
            }
        };

        let job = crate::scheduler::scheduler_add(title, kind_str, at, every_sec, action_value)
            .await?;
        Ok(format!("Scheduled job {} ({})", job.title, job.id))
    })
}

inventory::submit! {
    ToolSpec {
        name: "scheduler_add",
        description: "Schedule a recurring task. Pass `interval_seconds` (integer >= 1) for the fire cadence. The legacy `cron` field is kept for back-compat but only accepts an integer-as-string — real crontab syntax is NOT supported and returns an error. Actions: `shell` (runs payload.cmd in the sandbox) or `notify` (posts a macOS notification with payload.title/body). Use schedule_once for one-shot future runs at a specific time; use schedule_recurring for agent prompts on a cadence. Use scheduler_add only for low-level shell/notify jobs.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
