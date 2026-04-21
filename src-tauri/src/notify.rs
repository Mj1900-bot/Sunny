//! Native macOS notifications.
//!
//! Two-tier strategy:
//!   1. `terminal-notifier` (Homebrew) — best UX: click handling, grouping,
//!      reply button, arbitrary `-execute` payload.
//!   2. `osascript` → `display notification` — always available on macOS,
//!      zero dependencies, but no click callback and no actions.
//!
//! Sound names match the macOS system sound set under
//! `/System/Library/Sounds/`. An unknown name is silently dropped rather
//! than rejected so caller code doesn't have to gate on version drift.
//!
//! All child processes receive `crate::paths::fat_path()` as PATH so the
//! GUI-bundle's stripped-down PATH can still find Homebrew tools.
//!
//! `notify_with_action` uses a sentinel file: we pass `-execute` a small
//! shell command that `touch`es a unique path, then we poll for that file
//! for up to 30 s. If it appears, the user clicked the action. If not,
//! we return `{ clicked: false, action_taken: "" }` without an error
//! (timeout is a normal outcome, not a failure).

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export)]
pub struct NotifyResult {
    pub clicked: bool,
    pub action_taken: String,
}

const ACTION_TIMEOUT_SECS: u64 = 30;
const POLL_INTERVAL_MS: u64 = 250;
const GROUP_ID: &str = "ai.kinglystudio.sunny";

/// Allowlist of sound names. Anything not here is ignored.
const ALLOWED_SOUNDS: &[&str] = &[
    "default", "Frog", "Glass", "Hero", "Submarine", "Tink", "Sosumi",
];

fn sanitize_sound(sound: Option<String>) -> Option<String> {
    sound.and_then(|s| {
        if ALLOWED_SOUNDS.iter().any(|a| *a == s.as_str()) {
            Some(s)
        } else {
            None
        }
    })
}

/// Escape a string for safe embedding inside an AppleScript double-quoted
/// literal. Order matters — backslashes first, then the double quote itself.
fn safe_quote(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn path_env() -> Option<OsString> {
    crate::paths::fat_path()
}

fn sentinel_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("sunny-notify-{nanos}.clicked"))
}

/// Fire a notification. Prefers `terminal-notifier`, falls back to `osascript`.
pub async fn notify(title: String, body: String, sound: Option<String>) -> Result<(), String> {
    let sound = sanitize_sound(sound);

    if let Some(tn) = crate::paths::which("terminal-notifier") {
        let mut cmd = Command::new(&tn);
        cmd.arg("-title")
            .arg(&title)
            .arg("-message")
            .arg(&body)
            .arg("-group")
            .arg(GROUP_ID);
        if let Some(s) = sound.as_deref() {
            cmd.arg("-sound").arg(s);
        }
        if let Some(p) = path_env() {
            cmd.env("PATH", p);
        }
        cmd.output()
            .await
            .map_err(|e| format!("terminal-notifier: {e}"))?;
        return Ok(());
    }

    // Fallback: AppleScript. Build a single-line script with escaped literals.
    let mut script = format!(
        "display notification \"{}\" with title \"{}\"",
        safe_quote(&body),
        safe_quote(&title),
    );
    if let Some(s) = sound.as_deref() {
        script.push_str(&format!(" sound name \"{}\"", safe_quote(s)));
    }

    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg(&script);
    if let Some(p) = path_env() {
        cmd.env("PATH", p);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

/// Fire a notification with an action button. If `terminal-notifier` is
/// installed, we wait up to 30s for the user to click; otherwise we fall
/// back to a plain notification and return immediately with defaults.
pub async fn notify_with_action(
    title: String,
    body: String,
    action_title: String,
) -> Result<NotifyResult, String> {
    let Some(tn) = crate::paths::which("terminal-notifier") else {
        // No action support on fallback path — fire-and-forget.
        notify(title, body, None).await?;
        return Ok(NotifyResult {
            clicked: false,
            action_taken: String::new(),
        });
    };

    let sentinel = sentinel_path();
    // Best-effort pre-clean; ignore errors (file usually won't exist yet).
    let _ = tokio::fs::remove_file(&sentinel).await;

    // `-execute` runs via /bin/sh -c. Quote the sentinel path defensively.
    let sentinel_str = sentinel.to_string_lossy().to_string();
    let execute = format!("/usr/bin/touch {}", shell_single_quote(&sentinel_str));

    let mut cmd = Command::new(&tn);
    cmd.arg("-title")
        .arg(&title)
        .arg("-message")
        .arg(&body)
        .arg("-group")
        .arg(GROUP_ID)
        .arg("-actions")
        .arg(&action_title)
        .arg("-execute")
        .arg(&execute);
    if let Some(p) = path_env() {
        cmd.env("PATH", p);
    }
    cmd.output()
        .await
        .map_err(|e| format!("terminal-notifier: {e}"))?;

    // Poll for the sentinel.
    let deadline = std::time::Instant::now() + Duration::from_secs(ACTION_TIMEOUT_SECS);
    while std::time::Instant::now() < deadline {
        if tokio::fs::metadata(&sentinel).await.is_ok() {
            let _ = tokio::fs::remove_file(&sentinel).await;
            return Ok(NotifyResult {
                clicked: true,
                action_taken: action_title,
            });
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }

    Ok(NotifyResult {
        clicked: false,
        action_taken: String::new(),
    })
}

/// Wrap `s` as a POSIX shell single-quoted literal so embedded quotes and
/// spaces can't break out of the `-execute` string.
fn shell_single_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_quote_escapes_double_quotes() {
        let input = r#"hello "world""#;
        let out = safe_quote(input);
        assert_eq!(out, r#"hello \"world\""#);
        // And the escape is idempotent-safe: no stray unescaped quote remains.
        // Every `"` in output must be preceded by `\`.
        let bytes = out.as_bytes();
        for (i, b) in bytes.iter().enumerate() {
            if *b == b'"' {
                assert!(i > 0 && bytes[i - 1] == b'\\', "unescaped quote at {i}");
            }
        }
    }

    #[test]
    fn safe_quote_escapes_backslashes() {
        let input = r"path\to\file";
        let out = safe_quote(input);
        assert_eq!(out, r"path\\to\\file");
        // Also verify backslash-then-quote is handled in correct order:
        // the backslash itself gets doubled BEFORE the quote escape runs,
        // so the resulting `\"` sequence in the output is a real escaped
        // quote, not a bare quote after an escaped backslash.
        let combined = safe_quote(r#"a\"b"#);
        assert_eq!(combined, r#"a\\\"b"#);
    }

    #[test]
    fn sanitize_sound_passes_allowed() {
        assert_eq!(sanitize_sound(Some("Glass".into())), Some("Glass".into()));
        assert_eq!(sanitize_sound(Some("default".into())), Some("default".into()));
    }

    #[test]
    fn sanitize_sound_rejects_unknown() {
        assert_eq!(sanitize_sound(Some("Bogus".into())), None);
        assert_eq!(sanitize_sound(Some("../etc/passwd".into())), None);
        assert_eq!(sanitize_sound(None), None);
    }
}

// === REGISTER IN lib.rs ===
// mod notify;
// #[tauri::command] async fn notify(title: String, body: String, sound: Option<String>) -> Result<(), String> { notify::notify(title, body, sound).await }
// #[tauri::command] async fn notify_with_action(title: String, body: String, action_title: String) -> Result<notify::NotifyResult, String> { notify::notify_with_action(title, body, action_title).await }
// Add to invoke_handler: notify, notify_with_action
// NOTE: lib.rs already has a `#[tauri::command] fn notify(...)` if Tauri's notification plugin is enabled — check first. If there's a naming conflict, rename our commands to `notify_send` and `notify_action`.
// No new Cargo deps required.
// === END REGISTER ===
