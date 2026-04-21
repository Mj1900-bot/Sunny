//! Voice / TTS commands.

use crate::voice;

#[tauri::command]
pub async fn speak(text: String, voice: Option<String>, rate: Option<u32>) -> Result<(), String> {
    voice::speak(text, voice, rate).await
}

#[tauri::command]
pub async fn speak_stop() {
    voice::stop().await;
}

/// User-initiated interrupt during an Sunny utterance (push-to-talk while
/// she's speaking). Cuts audio immediately, respawns the Kokoro daemon
/// in the background so the next turn starts from a clean state, and
/// stamps `voice::INTERRUPTED_AT` so the agent loop can tag an in-flight
/// turn as "user interrupted". See `voice::interrupt` for the full
/// escalation path.
#[tauri::command]
pub async fn speak_interrupt() -> Result<(), String> {
    voice::interrupt().await
}

#[tauri::command]
pub fn list_voices() -> Vec<&'static str> {
    voice::list_british_voices()
}
