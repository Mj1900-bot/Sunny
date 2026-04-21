//! Miscellaneous commands: web, vault, settings, Python sandbox, daemons.

use crate::web;
use crate::vault;
use crate::settings;
use crate::pysandbox;
use crate::daemons;

// ---------------- Web ----------------

#[tauri::command]
pub async fn web_fetch_readable(url: String) -> Result<web::FetchResult, String> {
    web::fetch_readable(url).await
}

#[tauri::command]
pub async fn web_fetch_title(url: String) -> Result<String, String> {
    web::fetch_title(url).await
}

#[tauri::command]
pub async fn web_search(query: String, limit: Option<usize>) -> Result<Vec<web::SearchResult>, String> {
    web::search(query, limit).await
}

// ---------------- Vault (macOS Keychain) ----------------

#[tauri::command]
pub fn vault_list() -> Result<Vec<vault::VaultItem>, String> {
    vault::list_items()
}

#[tauri::command]
pub fn vault_add(kind: String, label: String, value: String) -> Result<vault::VaultItem, String> {
    vault::add_item(kind, label, value)
}

#[tauri::command]
pub fn vault_reveal(id: String) -> Result<String, String> {
    vault::reveal(id)
}

#[tauri::command]
pub fn vault_delete(id: String) -> Result<(), String> {
    vault::delete_item(id)
}

#[tauri::command]
pub fn vault_rename(id: String, label: String) -> Result<vault::VaultItem, String> {
    vault::rename_item(id, label)
}

#[tauri::command]
pub fn vault_update_value(id: String, value: String) -> Result<vault::VaultItem, String> {
    vault::update_value(id, value)
}

// ---------------- Settings (filesystem-backed, ~/.sunny/settings.json) ----------------

#[tauri::command]
pub fn settings_load() -> Result<serde_json::Value, String> {
    settings::load()
}

#[tauri::command]
pub fn settings_save(value: serde_json::Value) -> Result<(), String> {
    settings::save(&value)
}

// ---------------- Python sandbox ----------------

#[tauri::command]
pub async fn py_run(code: String, stdin: Option<String>, timeout_sec: Option<u64>) -> Result<pysandbox::PyResult, String> {
    pysandbox::py_run(code, stdin, timeout_sec).await
}

#[tauri::command]
pub async fn py_version() -> Result<String, String> {
    pysandbox::py_version().await
}

// ---------------- Daemons (~/.sunny/daemons.json) ----------------

#[tauri::command]
pub async fn daemons_list() -> Result<Vec<daemons::Daemon>, String> {
    daemons::daemons_list().await
}

#[tauri::command]
pub async fn daemons_add(spec: daemons::DaemonSpec) -> Result<daemons::Daemon, String> {
    daemons::daemons_add(spec).await
}

#[tauri::command]
pub async fn daemons_update(id: String, patch: serde_json::Value) -> Result<daemons::Daemon, String> {
    daemons::daemons_update(id, patch).await
}

#[tauri::command]
pub async fn daemons_delete(id: String) -> Result<(), String> {
    daemons::daemons_delete(id).await
}

#[tauri::command]
pub async fn daemons_set_enabled(id: String, enabled: bool) -> Result<daemons::Daemon, String> {
    daemons::daemons_set_enabled(id, enabled).await
}

#[tauri::command]
pub async fn daemons_ready_to_fire(now_secs: i64) -> Result<Vec<daemons::Daemon>, String> {
    daemons::daemons_ready_to_fire(now_secs).await
}

#[tauri::command]
pub async fn daemons_mark_fired(
    id: String,
    now_secs: i64,
    status: String,
    output: String,
) -> Result<daemons::Daemon, String> {
    daemons::daemons_mark_fired(id, now_secs, status, output).await
}
