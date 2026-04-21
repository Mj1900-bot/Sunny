//! AI agent / chat commands.

use tauri::AppHandle;
use crate::ai;

#[tauri::command]
pub async fn chat(app: AppHandle, req: ai::ChatRequest) -> Result<String, String> {
    ai::stream_chat(app, req).await
}
