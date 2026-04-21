//! Voice / TTS commands.
//!
//! # Dedup invariant
//!
//! Several frontend hooks subscribe to the same chat-done / speak events
//! (`useChatMessages`, `useVoiceChat`, `streamSpeak`, `CommandBar`,
//! `BriefHeader`, `voiceAgent`, builtin tools). When a race puts two of
//! them in flight, the user hears the same utterance twice — often with
//! Kokoro on one path and the macOS `say` fallback on the other, which is
//! the "British + American voice at once" symptom.
//!
//! Solution: the `speak` command rejects identical text arriving within a
//! short window. The first caller wins, duplicates are dropped silently.
//! Callers don't need coordination — the guard is the single source of
//! truth for "did this utterance already play".

use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::voice;

/// How long a recent utterance is considered "still playing" for dedup
/// purposes. Most Kokoro renders finish under 3s; at 4s we reliably
/// catch the same-response-twice races but allow a user to legitimately
/// re-ask the same thing after a beat.
const DEDUP_WINDOW: Duration = Duration::from_secs(4);

struct LastSpoken {
    text: String,
    at: Instant,
}

fn dedup_slot() -> &'static Mutex<Option<LastSpoken>> {
    static SLOT: OnceLock<Mutex<Option<LastSpoken>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Returns true if `text` is a duplicate of a recent utterance and should
/// be skipped; false if it's a new utterance (and records it as such).
/// The lock is held only for the compare + assignment, never across the
/// TTS playback — we don't want to serialise distinct utterances.
fn is_recent_duplicate(text: &str) -> bool {
    let mut slot = match dedup_slot().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(prev) = slot.as_ref() {
        if prev.text == text && prev.at.elapsed() < DEDUP_WINDOW {
            return true;
        }
    }
    *slot = Some(LastSpoken { text: text.to_string(), at: Instant::now() });
    false
}

#[tauri::command]
pub async fn speak(text: String, voice: Option<String>, rate: Option<u32>) -> Result<(), String> {
    if is_recent_duplicate(&text) {
        log::debug!(
            "speak: dropped duplicate within {:?}: {:.80}",
            DEDUP_WINDOW,
            text,
        );
        return Ok(());
    }
    voice::speak(text, voice, rate).await
}

#[tauri::command]
pub async fn speak_stop() {
    // Clearing the dedup slot lets the next caller speak a previously-
    // dropped-as-dupe utterance without waiting out the window. Matches
    // the intent of speak_stop: discard pending audio state.
    if let Ok(mut slot) = dedup_slot().lock() {
        *slot = None;
    }
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
    if let Ok(mut slot) = dedup_slot().lock() {
        *slot = None;
    }
    voice::interrupt().await
}

#[tauri::command]
pub fn list_voices() -> Vec<&'static str> {
    voice::list_british_voices()
}
