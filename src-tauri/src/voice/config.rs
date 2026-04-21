//! Static voice configuration: the default voice name and the UI-facing
//! voice list surfaced on the Settings page.
//!
//! The strings here double as both display labels and the values stored in
//! `settings.voiceName`; they are resolved to Kokoro voice ids at synthesis
//! time via `normalize::resolve_voice`.

/// Default voice label used when no explicit voice is requested.
pub const DEFAULT_VOICE: &str = "George";

/// Voice labels surfaced in the Settings UI. The strings double as both
/// the display label and the value stored in `settings.voiceName`; they
/// flow through `resolve_voice` when synthesising.
pub fn list_british_voices() -> Vec<&'static str> {
    vec!["George", "Daniel", "Lewis", "Fable", "Oliver"]
}
