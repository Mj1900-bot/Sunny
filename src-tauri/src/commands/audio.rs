//! Audio recording and transcription commands.

use tauri::AppHandle;
use crate::app_state::AppState;
use crate::audio;

#[tauri::command]
pub async fn audio_record_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // `audio::start` needs an `AppHandle` so the native capture thread
    // can emit `sunny://voice.level` events for the frontend VAD.
    audio::start(&state.recorder, app).await
}

#[tauri::command]
pub async fn audio_record_stop(state: tauri::State<'_, AppState>) -> Result<String, String> {
    audio::stop(&state.recorder).await
}

#[tauri::command]
pub fn audio_record_status(state: tauri::State<'_, AppState>) -> audio::RecordStatus {
    state.recorder.status()
}

#[tauri::command]
pub async fn transcribe(path: String) -> Result<String, String> {
    audio::transcribe(path).await
}

#[tauri::command]
pub async fn openclaw_ping() -> Result<bool, String> {
    audio::openclaw_ping().await
}
