//! UI-adjacent commands: accessibility/window info, notifications, app icons.

use crate::ax;
use crate::notify;
use crate::icons;

// ---------------- Accessibility / windows ----------------

#[tauri::command]
pub async fn window_focused_app() -> Result<ax::FocusedApp, String> {
    ax::focused_app().await
}

#[tauri::command]
pub async fn window_active_title() -> Result<String, String> {
    ax::active_window_title().await
}

#[tauri::command]
pub async fn window_list() -> Result<Vec<ax::WindowInfo>, String> {
    ax::list_windows().await
}

#[tauri::command]
pub async fn window_frontmost_bundle_id() -> Result<String, String> {
    ax::frontmost_bundle_id().await
}

// ---------------- Notifications ----------------

#[tauri::command]
pub async fn notify_send(title: String, body: String, sound: Option<String>) -> Result<(), String> {
    notify::notify(title, body, sound).await
}

#[tauri::command]
pub async fn notify_action(title: String, body: String, action_title: String) -> Result<notify::NotifyResult, String> {
    notify::notify_with_action(title, body, action_title).await
}

// ---------------- App icons ----------------

#[tauri::command]
pub async fn app_icon_png(app_path: String, size: u32) -> Result<String, String> {
    icons::app_icon_png(app_path, size).await
}
