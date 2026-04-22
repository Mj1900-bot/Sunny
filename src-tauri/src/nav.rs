//! Navigation bridge between the agent loop and the React HUD.
//!
//! Three surface areas:
//!
//! * `nav_set_current` — the frontend writes the currently-visible page
//!   name + title here every time the user (or the agent) flips
//!   `setView`. Backed by a `Mutex<Option<CurrentView>>` on `AppState`.
//! * `page_peek` — reads back the last-seen `CurrentView` so the agent
//!   tool `current_page_state` can answer "what page am I on".
//! * `nav_goto` / `nav_action` events — emitted to the webview when the
//!   agent calls `navigate_to_page` or `page_action`. Frontend
//!   listeners (`useNavBridge`, per-page effects) pick these up and run
//!   the appropriate imperative handler.
//!
//! Nothing here mutates user data — it's purely a view-routing channel
//! so the LLM can drive the UI alongside its speech output. All three
//! tools classify as `ExternalRead` (no side effects outside the HUD).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use ts_rs::TS;

use crate::app_state::AppState;

/// Snapshot of what the frontend is currently showing. The `view` field
/// mirrors the `ViewKey` union in `src/store/view.ts`; `title` /
/// `subtitle` are free-form strings the page writes so the agent can
/// speak them back verbatim if asked.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CurrentView {
    pub view: String,
    pub title: String,
    #[serde(default)]
    #[ts(optional)]
    pub subtitle: Option<String>,
}

/// Write the currently-visible page into Tauri-managed state. Called
/// from the frontend inside `useNavBridge` on every `setView`. Idempotent
/// — overwrites the previous snapshot.
#[tauri::command]
pub fn nav_set_current(
    state: tauri::State<'_, AppState>,
    view: String,
    title: String,
    subtitle: Option<String>,
) -> Result<(), String> {
    let next = CurrentView { view, title, subtitle };
    let mut guard = state
        .current_view
        .lock()
        .map_err(|_| "nav_set_current: mutex poisoned".to_string())?;
    *guard = Some(next);
    Ok(())
}

/// Read back the last snapshot the frontend wrote. Returns `None`
/// before the first `nav_set_current` call (e.g. during early boot).
#[tauri::command]
pub fn page_peek(state: tauri::State<'_, AppState>) -> Option<CurrentView> {
    state
        .current_view
        .lock()
        .ok()
        .and_then(|g| g.clone())
}

/// Fire `sunny://nav.goto` so the frontend's `useNavBridge` hook calls
/// `setView(view)`. This is the emission path for the agent tool
/// `navigate_to_page`.
pub fn emit_nav_goto(app: &AppHandle, view: &str) {
    let _ = app.emit("sunny://nav.goto", view);
}

/// Fire `sunny://nav.action` with `{view, action, args}` so the target
/// page's effect listener runs its imperative handler. Emission path
/// for the agent tool `page_action`.
pub fn emit_nav_action(
    app: &AppHandle,
    view: &str,
    action: &str,
    args: &serde_json::Value,
) {
    let payload = serde_json::json!({
        "view": view,
        "action": action,
        "args": args,
    });
    let _ = app.emit("sunny://nav.action", payload);
}

/// Pages that currently wire up `sunny://nav.action` listeners. Any
/// other view returns a structured "not implemented" error so the
/// agent knows to fall back to speech instead of silently failing.
pub fn view_supports_actions(view: &str) -> bool {
    matches!(view, "calendar" | "tasks" | "inbox")
}
