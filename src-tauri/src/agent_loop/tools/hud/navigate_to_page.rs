//! `navigate_to_page` — switch the SUNNY HUD to a different page.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["hud.navigate"];

const SCHEMA: &str = r#"{"type":"object","properties":{"view":{"type":"string","description":"ViewKey to show, e.g. 'calendar', 'tasks', 'inbox'."}},"required":["view"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    let app = ctx.app.clone();
    Box::pin(async move {
        let view = string_arg(&input, "view")?;
        // ViewKey allowlist mirrors `src/store/view.ts`. Keep in sync.
        const VALID_VIEWS: &[&str] = &[
            "overview", "today", "timeline", "security", "tasks", "journal", "focus",
            "calendar", "inbox", "people", "contacts", "voice", "notify", "notes", "reading",
            "memory", "photos", "files", "auto", "skills", "apps", "web", "code", "console",
            "screen", "scan", "brainstorm", "world", "society", "brain", "persona",
            "inspector", "audit", "devices", "diagnostics", "vault", "settings", "cost",
        ];
        if !VALID_VIEWS.contains(&view.as_str()) {
            return Err(format!(
                "navigate_to_page: unknown view `{view}` — valid values: {}",
                VALID_VIEWS.join(", ")
            ));
        }
        crate::nav::emit_nav_goto(&app, &view);
        Ok(format!("navigated to `{view}`"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "navigate_to_page",
        description: "Switch the SUNNY HUD to a different page. Use when Sunny says 'show me the calendar', 'open my inbox', 'take me to the tasks page', 'go to security', or any other navigational request. After calling this you should still ANSWER Sunny's question verbally — the tool only flips the visible page, it doesn't read it. Valid views mirror the frontend's ViewKey union: overview, today, timeline, security, tasks, journal, focus, calendar, inbox, people, contacts, voice, notify, notes, reading, memory, photos, files, auto, skills, apps, web, code, console, screen, scan, world, society, brain, persona, inspector, audit, devices, vault, settings. Cheap, read-only, no confirm gate.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
