//! Media control — play/pause/next/prev/volume + now-playing across Spotify,
//! Apple Music.app, and the macOS system now-playing stack.
//!
//! Source selection strategy
//! -------------------------
//! We prefer to target whichever media app is currently the most relevant:
//!   1. **Spotify** — if running AND playing (state == "playing").
//!   2. **Music.app** — if running AND playing.
//!   3. **Spotify** — if running (even paused).
//!   4. **Music.app** — if running (even paused).
//!   5. **System** — via `mediaremote-cli` if installed.
//!   6. **none** — nothing to target.
//!
//! Rationale: a running-but-paused player is still the user's intent; an app
//! that isn't running shouldn't be silently launched by a volume/skip press.
//!
//! Keyboard-shortcut fallback
//! --------------------------
//! When neither Spotify nor Music is running, we fall back to injecting the
//! system-wide media keys via `System Events`:
//!   * play/pause  — key code 16, using {command down, option down}
//!   * next        — key code 17
//!   * prev        — key code 18
//!
//! These are the same F7/F8/F9 function-key scan codes that the Apple keyboard
//! emits. macOS's media remote framework routes them to whichever process
//! holds the current now-playing slot (Safari, Chrome, VLC, QuickTime, etc.).
//!
//! All `osascript` invocations run with `fat_path()` in PATH and are wrapped
//! in a 3-second timeout.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(3);

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// `"spotify" | "music" | "system" | "none"`
    pub source: String,
    pub playing: bool,
    pub position_sec: Option<f64>,
    pub duration_sec: Option<f64>,
}

impl NowPlaying {
    fn none() -> Self {
        Self {
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            source: "none".to_string(),
            playing: false,
            position_sec: None,
            duration_sec: None,
        }
    }
}

// --------------------------------------------------------------------------
// Source selection
// --------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Spotify,
    Music,
    System,
    None,
}

impl Source {
    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            Source::Spotify => "spotify",
            Source::Music => "music",
            Source::System => "system",
            Source::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RunningApps {
    spotify_running: bool,
    spotify_playing: bool,
    music_running: bool,
    music_playing: bool,
}

/// Preferred source given which apps are running + whether they're playing.
fn select_source(apps: RunningApps, has_mediaremote: bool) -> Source {
    if apps.spotify_running && apps.spotify_playing {
        return Source::Spotify;
    }
    if apps.music_running && apps.music_playing {
        return Source::Music;
    }
    if apps.spotify_running {
        return Source::Spotify;
    }
    if apps.music_running {
        return Source::Music;
    }
    if has_mediaremote {
        return Source::System;
    }
    Source::None
}

/// Parse the 4-line output of `detect_running_media_apps_script()`:
///   line 1: "true"/"false"  — Spotify running
///   line 2: "true"/"false"  — Spotify player state == playing
///   line 3: "true"/"false"  — Music running
///   line 4: "true"/"false"  — Music player state == playing
fn parse_running_apps(out: &str) -> RunningApps {
    let mut lines = out.lines().map(|l| l.trim().to_ascii_lowercase());
    let s_run = lines.next().map(|l| l == "true").unwrap_or(false);
    let s_play = lines.next().map(|l| l == "true").unwrap_or(false);
    let m_run = lines.next().map(|l| l == "true").unwrap_or(false);
    let m_play = lines.next().map(|l| l == "true").unwrap_or(false);
    RunningApps {
        spotify_running: s_run,
        spotify_playing: s_run && s_play,
        music_running: m_run,
        music_playing: m_run && m_play,
    }
}

const DETECT_APPS_SCRIPT: &str = r#"
set sRun to false
set sPlay to false
set mRun to false
set mPlay to false
tell application "System Events"
    if (exists (processes where name is "Spotify")) then set sRun to true
    if (exists (processes where name is "Music")) then set mRun to true
end tell
if sRun then
    try
        tell application "Spotify"
            if player state is playing then set sPlay to true
        end tell
    end try
end if
if mRun then
    try
        tell application "Music"
            if player state is playing then set mPlay to true
        end tell
    end try
end if
return (sRun as string) & linefeed & (sPlay as string) & linefeed & (mRun as string) & linefeed & (mPlay as string)
"#;

async fn detect_apps() -> RunningApps {
    match run_osascript(DETECT_APPS_SCRIPT).await {
        Ok(out) => parse_running_apps(&out),
        Err(_) => RunningApps::default(),
    }
}

async fn current_source() -> Source {
    let apps = detect_apps().await;
    let has_mr = crate::paths::which("mediaremote-cli").is_some();
    select_source(apps, has_mr)
}

// --------------------------------------------------------------------------
// Public API — transport controls
// --------------------------------------------------------------------------

pub async fn media_toggle_play_pause() -> Result<(), String> {
    match current_source().await {
        Source::Spotify => run_osascript(r#"tell application "Spotify" to playpause"#)
            .await
            .map(|_| ()),
        Source::Music => run_osascript(r#"tell application "Music" to playpause"#)
            .await
            .map(|_| ()),
        Source::System => send_media_key(16).await,
        Source::None => send_media_key(16).await,
    }
}

pub async fn media_play() -> Result<(), String> {
    match current_source().await {
        Source::Spotify => run_osascript(r#"tell application "Spotify" to play"#)
            .await
            .map(|_| ()),
        Source::Music => run_osascript(r#"tell application "Music" to play"#)
            .await
            .map(|_| ()),
        Source::System => send_media_key(16).await,
        Source::None => send_media_key(16).await,
    }
}

pub async fn media_pause() -> Result<(), String> {
    match current_source().await {
        Source::Spotify => run_osascript(r#"tell application "Spotify" to pause"#)
            .await
            .map(|_| ()),
        Source::Music => run_osascript(r#"tell application "Music" to pause"#)
            .await
            .map(|_| ()),
        Source::System => send_media_key(16).await,
        Source::None => send_media_key(16).await,
    }
}

pub async fn media_next() -> Result<(), String> {
    match current_source().await {
        Source::Spotify => run_osascript(r#"tell application "Spotify" to next track"#)
            .await
            .map(|_| ()),
        Source::Music => run_osascript(r#"tell application "Music" to next track"#)
            .await
            .map(|_| ()),
        Source::System => send_media_key(17).await,
        Source::None => send_media_key(17).await,
    }
}

pub async fn media_prev() -> Result<(), String> {
    match current_source().await {
        Source::Spotify => run_osascript(r#"tell application "Spotify" to previous track"#)
            .await
            .map(|_| ()),
        Source::Music => run_osascript(r#"tell application "Music" to previous track"#)
            .await
            .map(|_| ()),
        Source::System => send_media_key(18).await,
        Source::None => send_media_key(18).await,
    }
}

// --------------------------------------------------------------------------
// Public API — volume
// --------------------------------------------------------------------------

pub async fn media_volume_set(percent: u32) -> Result<(), String> {
    let clamped = clamp_volume(percent);
    let script = format!("set volume output volume {clamped}");
    run_osascript(&script).await.map(|_| ())
}

pub async fn media_volume_get() -> Result<u32, String> {
    let out = run_osascript("output volume of (get volume settings)").await?;
    let trimmed = out.trim();
    trimmed
        .parse::<i64>()
        .map(|n| clamp_volume(n.max(0) as u32))
        .map_err(|e| format!("volume parse ({trimmed:?}): {e}"))
}

/// Clamp to the macOS-accepted 0..=100 range.
pub fn clamp_volume(percent: u32) -> u32 {
    percent.min(100)
}

// --------------------------------------------------------------------------
// Public API — now playing
// --------------------------------------------------------------------------

pub async fn media_now_playing() -> Result<NowPlaying, String> {
    let apps = detect_apps().await;
    let has_mr = crate::paths::which("mediaremote-cli").is_some();
    let source = select_source(apps, has_mr);

    match source {
        Source::Spotify => now_playing_app("Spotify", "spotify").await,
        Source::Music => now_playing_app("Music", "music").await,
        Source::System => now_playing_mediaremote().await,
        Source::None => Ok(NowPlaying::none()),
    }
}

/// Query Spotify.app or Music.app for the current track.
///
/// Output format (pipe-delimited, one record):
///   `title|artist|album|state|position|duration`
///
/// Any field may be empty (missing value → empty string). position/duration
/// may fail to retrieve if the app is between tracks — we return `None` then.
async fn now_playing_app(app: &str, source_label: &str) -> Result<NowPlaying, String> {
    let script = format!(
        r#"
set sep to "|"
tell application "{app}"
    try
        set t to name of current track
    on error
        set t to ""
    end try
    try
        set a to artist of current track
    on error
        set a to ""
    end try
    try
        set al to album of current track
    on error
        set al to ""
    end try
    try
        set st to player state as string
    on error
        set st to ""
    end try
    try
        set pp to (player position as string)
    on error
        set pp to ""
    end try
    try
        set dd to ((duration of current track) as string)
    on error
        set dd to ""
    end try
end tell
return t & sep & a & sep & al & sep & st & sep & pp & sep & dd
"#
    );

    let out = run_osascript(&script).await?;
    Ok(parse_now_playing_line(&out, source_label))
}

/// Parse the 6-field pipe-delimited record produced by `now_playing_app`.
/// Music.app reports `duration` in seconds; Spotify reports in **milliseconds**
/// (per Spotify's AppleScript dictionary), so we normalize below.
fn parse_now_playing_line(line: &str, source_label: &str) -> NowPlaying {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return NowPlaying {
            source: source_label.to_string(),
            ..NowPlaying::none()
        };
    }
    let parts: Vec<&str> = trimmed.split('|').collect();
    let title = parts.first().map(|s| s.trim().to_string()).unwrap_or_default();
    let artist = parts.get(1).map(|s| s.trim().to_string()).unwrap_or_default();
    let album = parts.get(2).map(|s| s.trim().to_string()).unwrap_or_default();
    let state = parts
        .get(3)
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let playing = state == "playing";

    let position_sec = parts.get(4).and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            t.parse::<f64>().ok()
        }
    });

    // Spotify returns duration in ms; Music in seconds. Detect by magnitude:
    // any value > 36_000 (10 h) is almost certainly ms.
    let duration_sec = parts.get(5).and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let raw: f64 = t.parse().ok()?;
        let secs = if source_label == "spotify" && raw > 1000.0 {
            raw / 1000.0
        } else {
            raw
        };
        Some(secs)
    });

    NowPlaying {
        title,
        artist,
        album,
        source: source_label.to_string(),
        playing,
        position_sec,
        duration_sec,
    }
}

/// Query the macOS system now-playing stack via `mediaremote-cli get`.
/// Output is expected as newline-separated `key=value` pairs; if the binary
/// produces something else, we return source="system" with empty fields.
async fn now_playing_mediaremote() -> Result<NowPlaying, String> {
    let bin = match crate::paths::which("mediaremote-cli") {
        Some(p) => p,
        None => {
            return Ok(NowPlaying {
                source: "none".to_string(),
                ..NowPlaying::none()
            })
        }
    };

    let fat = crate::paths::fat_path().unwrap_or_default();
    let fut = Command::new(&bin).arg("get").env("PATH", fat).kill_on_drop(true).output();
    let output = match timeout(OSASCRIPT_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        _ => {
            return Ok(NowPlaying {
                source: "system".to_string(),
                ..NowPlaying::none()
            })
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut np = NowPlaying {
        source: "system".to_string(),
        ..NowPlaying::none()
    };
    for raw in stdout.lines() {
        let line = raw.trim();
        let (k, v) = match line.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim().to_string();
        match key.as_str() {
            "title" | "name" => np.title = val,
            "artist" => np.artist = val,
            "album" => np.album = val,
            "playbackrate" => {
                if val.parse::<f64>().map(|n| n > 0.0).unwrap_or(false) {
                    np.playing = true;
                }
            }
            "elapsedtime" | "position" => np.position_sec = val.parse::<f64>().ok(),
            "duration" => np.duration_sec = val.parse::<f64>().ok(),
            _ => {}
        }
    }
    Ok(np)
}

// --------------------------------------------------------------------------
// Keyboard fallback
// --------------------------------------------------------------------------

/// Send F7/F8/F9-equivalent media keys via System Events.
/// `code` = 16 (play/pause), 17 (next), 18 (prev).
async fn send_media_key(code: u8) -> Result<(), String> {
    let script = format!(
        r#"tell application "System Events" to key code {code} using {{command down, option down}}"#
    );
    run_osascript(&script).await.map(|_| ())
}

// --------------------------------------------------------------------------
// osascript plumbing
// --------------------------------------------------------------------------

async fn run_osascript(script: &str) -> Result<String, String> {
    let fat = crate::paths::fat_path().unwrap_or_default();
    let fut = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .env("PATH", fat)
        .kill_on_drop(true)
        .output();

    let result = match timeout(OSASCRIPT_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => {
            return Err(format!(
                "osascript timed out after {}s",
                OSASCRIPT_TIMEOUT.as_secs()
            ))
        }
    };

    let output = result.map_err(|e| format!("osascript spawn failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("osascript error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// --------------------------------------------------------------------------
// Tests — pure helpers only (no subprocess / no AppleScript).
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_volume_bounds() {
        assert_eq!(clamp_volume(0), 0);
        assert_eq!(clamp_volume(50), 50);
        assert_eq!(clamp_volume(100), 100);
        assert_eq!(clamp_volume(101), 100);
        assert_eq!(clamp_volume(9999), 100);
    }

    #[test]
    fn parse_now_playing_line_spotify_full() {
        // Spotify reports duration in ms — must be normalized to seconds.
        let line = "Redshift|TWRP|Together Through Time|playing|42.5|210000";
        let np = parse_now_playing_line(line, "spotify");
        assert_eq!(np.title, "Redshift");
        assert_eq!(np.artist, "TWRP");
        assert_eq!(np.album, "Together Through Time");
        assert_eq!(np.source, "spotify");
        assert!(np.playing);
        assert_eq!(np.position_sec, Some(42.5));
        assert_eq!(np.duration_sec, Some(210.0));
    }

    #[test]
    fn parse_now_playing_line_music_paused_missing_fields() {
        // Music.app reports duration in seconds. Paused state. Missing position.
        let line = "Clair de Lune|Debussy|Suite Bergamasque|paused||301.2";
        let np = parse_now_playing_line(line, "music");
        assert_eq!(np.title, "Clair de Lune");
        assert_eq!(np.source, "music");
        assert!(!np.playing);
        assert_eq!(np.position_sec, None);
        assert_eq!(np.duration_sec, Some(301.2));
    }

    #[test]
    fn select_source_priority_order() {
        // Both apps running, Spotify playing -> Spotify wins.
        let apps = RunningApps {
            spotify_running: true,
            spotify_playing: true,
            music_running: true,
            music_playing: true,
        };
        assert_eq!(select_source(apps, false), Source::Spotify);

        // Only Music playing -> Music.
        let apps = RunningApps {
            spotify_running: false,
            spotify_playing: false,
            music_running: true,
            music_playing: true,
        };
        assert_eq!(select_source(apps, false), Source::Music);

        // Both running, both paused -> Spotify (running-preference).
        let apps = RunningApps {
            spotify_running: true,
            spotify_playing: false,
            music_running: true,
            music_playing: false,
        };
        assert_eq!(select_source(apps, false), Source::Spotify);

        // Neither running, mediaremote-cli present -> System.
        let apps = RunningApps::default();
        assert_eq!(select_source(apps, true), Source::System);

        // Neither running, no mediaremote -> None.
        assert_eq!(select_source(apps, false), Source::None);
    }

    #[test]
    fn detect_running_media_apps_parser() {
        let out = "true\nfalse\ntrue\ntrue\n";
        let apps = parse_running_apps(out);
        assert!(apps.spotify_running);
        assert!(!apps.spotify_playing);
        assert!(apps.music_running);
        assert!(apps.music_playing);

        // Case-insensitive + whitespace tolerant.
        let out = "  TRUE  \n  TRUE  \nfalse\nfalse";
        let apps = parse_running_apps(out);
        assert!(apps.spotify_running);
        assert!(apps.spotify_playing);
        assert!(!apps.music_running);
        assert!(!apps.music_playing);

        // playing=true but running=false should be suppressed.
        let out = "false\ntrue\nfalse\ntrue";
        let apps = parse_running_apps(out);
        assert!(!apps.spotify_running);
        assert!(!apps.spotify_playing);
        assert!(!apps.music_running);
        assert!(!apps.music_playing);

        // Short / malformed input → all false, no panic.
        let apps = parse_running_apps("");
        assert_eq!(apps, RunningApps::default());
    }
}

// === REGISTER IN lib.rs ===
// mod media;
// #[tauri::command]s: media_toggle_play_pause, media_play, media_pause, media_next, media_prev, media_volume_set, media_volume_get, media_now_playing
// invoke_handler: same names
// No new deps.
// === END REGISTER ===
