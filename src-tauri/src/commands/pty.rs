//! PTY (pseudo-terminal) commands.

use tauri::AppHandle;
use crate::app_state::AppState;
use crate::pty;

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
    pty::open(&state.ptys, app, id, cols, rows, shell)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    pty::write(&state.ptys, &id, data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&state.ptys, &id, cols, rows)
}

#[tauri::command]
pub fn pty_close(state: tauri::State<'_, AppState>, id: String) {
    pty::close(&state.ptys, &id);
}
