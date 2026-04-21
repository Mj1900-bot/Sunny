//! Scheduler and job template commands.

use crate::scheduler;
use crate::scheduler_templates;

#[tauri::command]
pub async fn scheduler_list() -> Result<Vec<scheduler::Job>, String> {
    scheduler::scheduler_list().await
}

#[tauri::command]
pub async fn scheduler_add(
    title: String,
    kind: String,
    at: Option<i64>,
    every_sec: Option<u64>,
    action: serde_json::Value,
) -> Result<scheduler::Job, String> {
    scheduler::scheduler_add(title, kind, at, every_sec, action).await
}

#[tauri::command]
pub async fn scheduler_update(id: String, patch: serde_json::Value) -> Result<scheduler::Job, String> {
    scheduler::scheduler_update(id, patch).await
}

#[tauri::command]
pub async fn scheduler_delete(id: String) -> Result<(), String> {
    scheduler::scheduler_delete(id).await
}

#[tauri::command]
pub async fn scheduler_set_enabled(id: String, enabled: bool) -> Result<scheduler::Job, String> {
    scheduler::scheduler_set_enabled(id, enabled).await
}

#[tauri::command]
pub async fn scheduler_run_once(
    app: tauri::AppHandle,
    id: String,
) -> Result<scheduler::Job, String> {
    scheduler::scheduler_run_once(app, id).await
}

/// List every curated 24/7 job template. The Auto page renders these as
/// one-click installs. Pure data — no side effects.
#[tauri::command]
pub fn scheduler_templates_list() -> Vec<scheduler_templates::JobTemplate> {
    scheduler_templates::all_templates()
}

/// Convert the named template into a real `Job`, persist it via the
/// scheduler, and return the created job so the UI can show it in the
/// installed-jobs list immediately.
///
/// The scheduler always recomputes `next_run` on add/update, so to honour a
/// template's wall-clock first-fire (e.g. "Monday 9 am"), we install the
/// job, then patch `last_run = desired_fire - every_sec`. The scheduler's
/// `compute_next_run` then yields exactly `desired_fire`.
#[tauri::command]
pub async fn scheduler_install_template(id: String) -> Result<scheduler::Job, String> {
    let template = scheduler_templates::template_by_id(&id)
        .ok_or_else(|| format!("unknown template '{id}'"))?;
    let action = serde_json::to_value(&template.action)
        .map_err(|e| format!("serialize template action: {e}"))?;
    let kind = match template.kind {
        scheduler::JobKind::Once => "once",
        scheduler::JobKind::Interval => "interval",
    };

    let created = scheduler::scheduler_add(
        template.title.to_string(),
        kind.to_string(),
        None,
        template.every_sec,
        action,
    )
    .await?;

    // Honour the template's wall-clock first-fire when one is specified.
    // Only meaningful for interval jobs with a cadence — short watchdogs
    // (no wall-clock anchor) keep the scheduler's default `now + every_sec`.
    match (template.kind, template.every_sec, template.next_hour, template.next_minute) {
        (scheduler::JobKind::Interval, Some(every), Some(h), Some(m)) => {
            let desired_first =
                scheduler_templates::next_local_at(h, m, template.next_weekday);
            let backdate = desired_first - every as i64;
            // Use the internal backdate helper — not scheduler_update — so the
            // UI-facing exclusion list (which blocks last_run writes) is not
            // bypassed via a public Tauri command.
            scheduler::scheduler_backdate_last_run(created.id.clone(), backdate).await
        }
        _ => Ok(created),
    }
}
