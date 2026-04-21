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

const SCHEMA: &str = r#"{"type":"object","properties":{"name":{"type":"string"},"cron":{"type":"string"},"action":{"type":"string"},"payload":{"type":"object"}},"required":["name","cron","action"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "name")?;
        let cron = string_arg(&input, "cron").unwrap_or_default();
        let action_kind = string_arg(&input, "action")?;
        let payload = input
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let (kind_str, at, every_sec) = if let Ok(secs) = cron.parse::<u64>() {
            ("interval".to_string(), None, Some(secs))
        } else {
            return Err(format!(
                "scheduler_add: cron `{cron}` not supported (expected interval seconds as a number); not implemented"
            ));
        };

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
        description: "Schedule a recurring or one-shot task.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
