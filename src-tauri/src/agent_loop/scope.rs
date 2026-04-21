//! Sub-agent tool scope — runtime allowlist inherited via
//! `tokio::task_local`.
//!
//! When `enforcement::subagent_role_scoping` is enabled (default ON —
//! see `security::enforcement::EnforcementPolicy::default`), sub-agents
//! only get access to a role-appropriate subset of the tool catalog:
//!
//!   * `summarizer` / `critic` — read + compute + memory recall + web read
//!   * `writer`                — summarizer + write side-effects
//!                               (notes/mail/iMessage/reminders/calendar/
//!                               scheduler) + memory_remember
//!   * `researcher`            — reading + full web + spawn + memory I/O
//!   * `coder`                 — researcher + python + claude_code
//!   * `browser_driver`        — read + browser_* + web
//!   * `planner`               — reading + web + spawn + plan_execute +
//!                               scheduler_add + memory I/O
//!
//! The main agent runs without a scope (no `CURRENT_SCOPE` value set),
//! which `allowed_in_scope` returns true for.  Nested sub-agents
//! inherit their parent scope unless they're spawned with a different
//! role tag — cross-role nesting keeps the outer role's allowlist as
//! the hard ceiling.
//!
//! To globally disable role scoping (every sub-agent sees every tool),
//! toggle `subagent_role_scoping=false` via the POLICY tab or the
//! `patch_enforcement_policy` command.  Dispatch is gated in
//! `agent_loop::dispatch` on `snapshot().subagent_role_scoping`.

use std::collections::BTreeSet;

tokio::task_local! {
    pub static CURRENT_SCOPE: RoleScope;
}

#[derive(Clone, Debug)]
pub struct RoleScope {
    pub role: String,
    pub allowed: BTreeSet<String>,
}

/// Wrap a future with a role scope.  All tool dispatches inside `fut`
/// see `CURRENT_SCOPE` populated with the role's allowlist.
pub async fn with_role_scope<F, T>(role: String, allowed: BTreeSet<String>, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    CURRENT_SCOPE
        .scope(RoleScope { role, allowed }, fut)
        .await
}

/// Returns `None` if no scope is active (main agent), or
/// `Some(role, allowed_list)` when we're inside a sub-agent.
pub fn current_scope() -> Option<(String, BTreeSet<String>)> {
    CURRENT_SCOPE
        .try_with(|s| (s.role.clone(), s.allowed.clone()))
        .ok()
}

/// Check whether a tool is allowed under the active scope.  Returns
/// true for the main agent (no scope) + any tool explicitly listed.
pub fn allowed_in_scope(tool: &str) -> bool {
    match current_scope() {
        None => true,
        Some((_, set)) => set.contains(tool),
    }
}

/// Compute the effective tool allowlist for a skill execution on the Rust
/// side. The front-end skill executor is the primary gate — it validates the
/// recipe, enforces the `capabilities` field, and never dispatches a denied
/// tool. This helper covers any Rust-side skill execution path (background
/// daemons, consolidator tasks) so the same policy applies regardless of
/// where the dispatch lands.
///
/// Semantics mirror the TS side:
///   * `skill_caps = Some(list)` → the recipe declared an allowlist;
///     return that set (empty is valid — means "answer-only recipe").
///   * `skill_caps = None`       → legacy recipe without a scope; fall
///     back to `default_caps` (the caller picks: often the empty set to
///     fail closed, or the role allowlist to preserve compatibility).
///
/// The caller is responsible for pairing this with `allowed_in_scope`
/// or a direct `set.contains(tool)` check at dispatch time.
///
/// Test-only today — the live skill-capability gate runs in TS
/// (`skillExecutor.checkCapability`). Kept here so Rust-side tests
/// assert the shared contract stays in sync.
#[cfg(test)]
pub fn allowed_tools_for_skill(
    _skill_name: &str,
    skill_caps: Option<&[String]>,
    default_caps: &BTreeSet<String>,
) -> BTreeSet<String> {
    match skill_caps {
        Some(list) => list.iter().cloned().collect(),
        None => default_caps.clone(),
    }
}

pub fn allowed_tools_for_role(role: &str) -> BTreeSet<String> {
    let mut s = base_tools();
    match role {
        "summarizer" | "critic" | "skeptic" => {
            s.extend(reading_tools());
        }
        "synthesizer" | "arbiter" => {
            // Merge / judge roles — read-only. They reason over
            // inputs given to them, not against the world.
            s.extend(reading_tools());
        }
        "writer" => {
            // Writer composes outbound content: notes, emails,
            // messages, reminders, calendar events, scheduled jobs.
            // Needs the reading set to cite context + the memory
            // write side to persist what it produces.
            s.extend(reading_tools());
            s.extend(writer_write_tools());
            s.extend(memory_write_tools());
        }
        "researcher" => {
            s.extend(reading_tools());
            s.extend(web_tools());
            s.extend(memory_write_tools());
            s.insert("memory_compact".into());
            s.insert("spawn_subagent".into());
        }
        "coder" => {
            s.extend(reading_tools());
            s.extend(web_tools());
            s.insert("py_run".into());
            s.insert("claude_code_supervise".into());
            s.insert("spawn_subagent".into());
        }
        "browser_driver" => {
            s.extend(reading_tools());
            s.extend(browser_tools());
            s.extend(web_tools());
        }
        "planner" => {
            // Planner dispatches and sequences work: it must be able
            // to spawn sub-agents, run multi-step plans, schedule
            // follow-ups, and read/write memory to track progress.
            s.extend(reading_tools());
            s.extend(web_tools());
            s.extend(memory_write_tools());
            s.insert("spawn_subagent".into());
            s.insert("plan_execute".into());
            s.insert("scheduler_add".into());
        }
        _ => {
            // Unknown role — be conservative, read-only set.
            s.extend(reading_tools());
        }
    }
    s
}

fn base_tools() -> BTreeSet<String> {
    // Tools that are always safe: pure compute + memory read +
    // time/weather.  Every role has access to these.
    //
    // Dialogue tools (`agent_message` / `agent_wait`) are included in
    // the base set because they're both passive — they read/write the
    // agent-loop's in-process message registry, never side-effect
    // outside it — and they're the mechanism siblings use to
    // coordinate regardless of role. Locking them to specific roles
    // would silently break council / debate patterns from any role
    // that wasn't whitelisted.
    [
        "calc", "timezone_now", "unit_convert", "uuid_new",
        "weather_current", "weather_forecast", "sunrise_sunset",
        "time_in_city", "stock_quote",
        "memory_recall",
        "agent_message", "agent_wait",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

fn reading_tools() -> BTreeSet<String> {
    [
        "mail_list_unread", "mail_unread_count", "mail_search",
        "calendar_today", "calendar_upcoming",
        "reminders_list",
        "notes_search",
        "messaging_list_chats", "messaging_fetch_conversation",
        "contacts_lookup",
        "media_now_playing",
        "system_metrics", "battery_status",
        "focused_window", "screen_ocr", "screen_capture_full",
        "clipboard_history",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

fn web_tools() -> BTreeSet<String> {
    [
        "web_fetch", "web_search", "web_extract_links",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

fn browser_tools() -> BTreeSet<String> {
    [
        "browser_open", "browser_read_page_text",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Outbound-content tools the `writer` role needs: creating notes,
/// sending mail/iMessage/SMS, scheduling reminders/calendar entries,
/// queueing follow-up jobs.  Kept separate so future roles can
/// selectively re-use the set.
fn writer_write_tools() -> BTreeSet<String> {
    [
        "notes_create",
        "notes_append",
        "mail_send",
        "imessage_send",
        "messaging_send_sms",
        "reminders_add",
        "calendar_create_event",
        "scheduler_add",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Memory tools beyond `memory_recall` (which is in `base_tools`).
/// `memory_search` is included proactively for forward-compatibility
/// even though it is not yet wired into the catalog — unknown names
/// in an allowlist are harmless (they just never match a dispatch).
fn memory_write_tools() -> BTreeSet<String> {
    [
        "memory_remember",
        "memory_recall",
        "memory_search",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_agent_has_no_scope() {
        // Outside any scope.  Should always allow.
        assert!(allowed_in_scope("mail_send"));
        assert!(current_scope().is_none());
    }

    #[test]
    fn summariser_allowlist_excludes_dangerous() {
        let allowed = allowed_tools_for_role("summarizer");
        assert!(allowed.contains("memory_recall"));
        assert!(!allowed.contains("mail_send"));
        assert!(!allowed.contains("imessage_send"));
        assert!(!allowed.contains("py_run"));
    }

    #[test]
    fn coder_allowlist_includes_py_run() {
        let allowed = allowed_tools_for_role("coder");
        assert!(allowed.contains("py_run"));
        assert!(allowed.contains("claude_code_supervise"));
        assert!(!allowed.contains("mail_send"));
    }

    #[test]
    fn unknown_role_falls_back_to_reading_only() {
        let allowed = allowed_tools_for_role("who_knows");
        assert!(allowed.contains("memory_recall"));
        assert!(!allowed.contains("web_fetch"));
        assert!(!allowed.contains("mail_send"));
    }

    #[test]
    fn writer_allowlist_covers_outbound_tools() {
        let allowed = allowed_tools_for_role("writer");
        for tool in [
            "notes_create", "notes_append",
            "memory_remember",
            "mail_send", "imessage_send", "messaging_send_sms",
            "reminders_add", "calendar_create_event", "scheduler_add",
        ] {
            assert!(
                allowed.contains(tool),
                "writer role should permit `{tool}`"
            );
        }
    }

    #[test]
    fn planner_allowlist_covers_orchestration_tools() {
        let allowed = allowed_tools_for_role("planner");
        for tool in [
            "scheduler_add", "spawn_subagent", "plan_execute",
            "memory_remember", "memory_recall", "memory_search",
        ] {
            assert!(
                allowed.contains(tool),
                "planner role should permit `{tool}`"
            );
        }
    }

    #[test]
    fn researcher_allowlist_covers_memory_tools() {
        let allowed = allowed_tools_for_role("researcher");
        for tool in [
            "memory_remember", "memory_recall",
            "memory_search", "memory_compact",
        ] {
            assert!(
                allowed.contains(tool),
                "researcher role should permit `{tool}`"
            );
        }
    }

    #[test]
    fn skill_caps_override_default_when_present() {
        // Recipe declared its own allowlist — use it verbatim, ignore defaults.
        let declared = vec!["calc".to_string(), "weather_current".to_string()];
        let default: BTreeSet<String> = ["notes_create", "mail_send"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let effective = allowed_tools_for_skill("morning-brief", Some(&declared), &default);
        assert!(effective.contains("calc"));
        assert!(effective.contains("weather_current"));
        assert!(!effective.contains("notes_create"));
        assert!(!effective.contains("mail_send"));
    }

    #[test]
    fn skill_caps_none_falls_back_to_default() {
        let default: BTreeSet<String> = ["calc", "memory_recall"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let effective = allowed_tools_for_skill("legacy-skill", None, &default);
        assert!(effective.contains("calc"));
        assert!(effective.contains("memory_recall"));
        assert_eq!(effective.len(), 2);
    }

    #[test]
    fn skill_caps_empty_list_allows_nothing() {
        // An explicitly empty capability list = answer-only recipe.
        // Must NOT silently promote to the default set.
        let declared: Vec<String> = Vec::new();
        let default: BTreeSet<String> = ["calc"].iter().map(|s| s.to_string()).collect();
        let effective = allowed_tools_for_skill("answer-only", Some(&declared), &default);
        assert!(effective.is_empty());
        assert!(!effective.contains("calc"));
    }

    /// Exercises the end-to-end guard: spin up a `writer` role scope
    /// using the same `with_role_scope` wrapper `plan_execute` /
    /// `spawn_subagent` use, then verify `allowed_in_scope` permits
    /// `notes_create` (the R16-F regression case) while still
    /// rejecting tools that aren't on the writer allowlist.
    #[tokio::test]
    async fn plan_execute_can_use_writer_tools() {
        let allowed = allowed_tools_for_role("writer");
        with_role_scope("writer".into(), allowed, async {
            // Scope active — these are on the writer allowlist:
            assert!(allowed_in_scope("notes_create"));
            assert!(allowed_in_scope("notes_append"));
            assert!(allowed_in_scope("mail_send"));
            assert!(allowed_in_scope("imessage_send"));
            assert!(allowed_in_scope("scheduler_add"));
            assert!(allowed_in_scope("memory_remember"));
            // Still rejected — writer has no browser/python access:
            assert!(!allowed_in_scope("py_run"));
            assert!(!allowed_in_scope("browser_open"));
            // Sanity: scope is visible under this future.
            let scope = current_scope().expect("scope must be active");
            assert_eq!(scope.0, "writer");
        })
        .await;

        // Scope has dropped — main-agent behaviour restored.
        assert!(current_scope().is_none());
        assert!(allowed_in_scope("notes_create"));
    }
}
