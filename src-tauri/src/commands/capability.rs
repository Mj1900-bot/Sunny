//! Capability grant policy commands.
//!
//! Sprint-13 β — capability grant policy.
//!
//! Backed by `crate::capability`. UI (SettingsPage, sprint-14 follow-up)
//! will use these to render the current policy and persist user edits.
//! Until the UI lands, the file at `~/.sunny/grants.json` is
//! hand-editable — changes are picked up on the next dispatch via
//! mtime-driven cache invalidation.

use crate::capability;

#[tauri::command]
pub fn capability_list_grants() -> Result<capability::GrantsFile, String> {
    capability::list_grants()
}

#[tauri::command]
pub fn capability_update_grants(value: capability::GrantsFile) -> Result<(), String> {
    capability::update_grants(value)
}

/// Tail the persisted capability-denial audit log. Surfaced on the
/// Security page so users can see which sub-agents hit grant-scope walls
/// without opening `~/.sunny/capability_denials.log` by hand.
#[tauri::command]
pub fn capability_tail_denials(limit: Option<usize>) -> Vec<capability::CapabilityDenialRow> {
    capability::tail_denials(limit.unwrap_or(200))
}
