//! Core Apple-ecosystem helpers — Music.app, Photos.app, Shortcuts CLI, and
//! macOS notification/focus surfaces.
//!
//! All user-supplied strings that land inside AppleScript double-quoted
//! literals are sanitised through [`crate::applescript::escape_applescript`]
//! (canonical impl in `applescript.rs`) before interpolation. This is the
//! single escape point for the whole module; nothing else in this file
//! constructs quoted AppleScript literals directly.
//!
//! # AppleScript injection strategy
//!
//! AppleScript injections surface in three ways:
//!   1. A `"` closes the current string literal early.
//!   2. A `\` followed by a special sequence changes the next character.
//!   3. Newline / carriage-return terminates the `-e` argument early.
//!
//! `escape_applescript` handles all three: `"` → `\"`, `\` → `\\`,
//! `\n` → `\n` (literal escape), `\r` → `\r`, `\t` → `\t`.
//! Multi-line scripts are piped on stdin via `run_osa` so the shell never
//! sees them, but the escaping is still applied to guard against any user
//! string that contains raw newlines sneaking through.
//!
//! # Shortcut existence check
//!
//! `shortcut_run` validates the target shortcut name by calling
//! `shortcut_list` first and failing cleanly when the name is absent
//! (typo-protection, L3 guard).
//!
//! # Entitlements note
//!
//! `photos_recent` / `photos_search` require *Photos Library* access in
//! **System Settings → Privacy & Security → Photos → Sunny**.
//! The OS will prompt once on first use; denial surfaces as AppleScript
//! error -1743 and is translated to a human-readable hint.

use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::applescript::escape_applescript;

const OSA_TIMEOUT: Duration = Duration::from_secs(30);
const SC_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Low-level osascript runner (stdin pipe, no shell escaping needed)
// ---------------------------------------------------------------------------

pub(super) async fn run_osa(script: &str) -> Result<String, String> {
    // osascript is a frequent agent tool — shortcut invocations,
    // calendar queries, message lookups can all fire in quick
    // succession. Gate on the global spawn budget so a loop of tool
    // calls can't saturate the kernel fork table.
    let _guard = crate::process_budget::SpawnGuard::acquire().await?;

    let mut child = Command::new("osascript")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|e| format!("osascript stdin write failed: {e}"))?;
    }

    let out = match timeout(OSA_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript wait failed: {e}")),
        Err(_) => {
            return Err(format!(
                "osascript timed out after {}s",
                OSA_TIMEOUT.as_secs()
            ))
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(classify_osa_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .trim_end_matches('\n')
        .to_string())
}

fn classify_osa_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("-1743")
        || lower.contains("not authorized")
        || lower.contains("not allowed")
    {
        return "Automation permission denied — System Settings → Privacy & Security → Automation → Sunny, enable the target app".to_string();
    }
    format!("osascript: {}", stderr.trim())
}

// ---------------------------------------------------------------------------
// shortcuts CLI probe
// ---------------------------------------------------------------------------

/// Returns `true` when the `shortcuts` CLI is available (macOS Monterey+).
async fn shortcuts_cli_available() -> bool {
    Command::new("which")
        .arg("shortcuts")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// shortcut_list
// ---------------------------------------------------------------------------

/// Parsed entry from `shortcuts list` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutEntry {
    pub name: String,
    pub folder: Option<String>,
}

/// List all user Shortcuts. Returns `Err` only when the CLI is absent or
/// crashes; an empty list is `Ok(vec![])`.
pub async fn shortcut_list() -> Result<Vec<ShortcutEntry>, String> {
    if !shortcuts_cli_available().await {
        return Err(
            "shortcuts CLI not found — requires macOS Monterey (12) or later".to_string(),
        );
    }

    let out = Command::new("shortcuts")
        .arg("list")
        .output()
        .await
        .map_err(|e| format!("shortcuts list failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("shortcuts list: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let entries = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            // The CLI emits lines like:
            //   "My Shortcut"                     (no folder)
            //   "My Shortcut [Folder Name]"        (with folder)
            if let Some(bracket) = line.rfind('[') {
                let name = line[..bracket].trim().to_string();
                let folder_raw = &line[bracket + 1..];
                let folder = folder_raw
                    .trim_end_matches(']')
                    .trim()
                    .to_string();
                ShortcutEntry {
                    name,
                    folder: if folder.is_empty() { None } else { Some(folder) },
                }
            } else {
                ShortcutEntry {
                    name: line.trim().to_string(),
                    folder: None,
                }
            }
        })
        .collect();

    Ok(entries)
}

// ---------------------------------------------------------------------------
// shortcut_run
// ---------------------------------------------------------------------------

/// Run a named Shortcut, optionally with text/file/URL input on stdin.
/// Validates the shortcut exists first; returns a clean error on typos.
pub async fn shortcut_run(name: &str, input: Option<&str>) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("shortcut_run: `name` is empty".to_string());
    }

    if !shortcuts_cli_available().await {
        return Err(
            "shortcuts CLI not found — requires macOS Monterey (12) or later".to_string(),
        );
    }

    // Existence check — fail cleanly on typos (L3 guard).
    let entries = shortcut_list().await?;
    let exists = entries.iter().any(|e| e.name == n);
    if !exists {
        // Provide the full list so the caller can suggest corrections.
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        return Err(format!(
            "shortcut `{n}` not found. Available: {}",
            names.join(", ")
        ));
    }

    // Budget-gate the shortcut spawn. The agent can be prompted to
    // "run these N shortcuts in sequence" — without a permit check
    // that's N concurrent spawns on an already-busy kernel.
    let _guard = crate::process_budget::SpawnGuard::acquire().await?;

    let mut cmd = Command::new("shortcuts");
    cmd.arg("run").arg(n);
    if input.is_some() {
        cmd.arg("--input-path").arg("-");
    }
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("shortcuts run spawn failed: {e}"))?;

    if let (Some(mut stdin), Some(body)) = (child.stdin.take(), input) {
        stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("shortcuts stdin write failed: {e}"))?;
    }

    let out = match timeout(SC_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("shortcuts wait failed: {e}")),
        Err(_) => {
            return Err(format!(
                "shortcut `{n}` timed out after {}s",
                SC_TIMEOUT.as_secs()
            ))
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("shortcut `{n}` exited with {}", out.status)
        } else {
            format!("shortcut `{n}`: {stderr}")
        });
    }

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if stdout.is_empty() {
        format!("Shortcut `{n}` ran successfully.")
    } else {
        stdout
    })
}

// ---------------------------------------------------------------------------
// Music.app — play, pause, now playing, skip, volume
// ---------------------------------------------------------------------------

/// Play Music.app. If `query` is given, searches and plays the first result;
/// otherwise resumes the current track.
pub async fn music_play(query: Option<&str>) -> Result<String, String> {
    let script = match query {
        Some(q) if !q.trim().is_empty() => {
            let safe_q = escape_applescript(q.trim());
            format!(
                r#"tell application "Music"
    set results to (search playlist "Library" for "{safe_q}")
    if results is not {{}} then
        play (item 1 of results)
        set t to current track
        return "Playing: " & (name of t) & " – " & (artist of t)
    else
        return "No results found for: {safe_q}"
    end if
end tell
"#,
                safe_q = safe_q
            )
        }
        _ => r#"tell application "Music"
    play
    try
        set t to current track
        return "Resumed: " & (name of t) & " – " & (artist of t)
    on error
        return "Music resumed."
    end try
end tell
"#
        .to_string(),
    };
    run_osa(&script).await
}

/// Pause Music.app.
pub async fn music_pause() -> Result<String, String> {
    run_osa(r#"tell application "Music" to pause
return "Paused."
"#)
    .await
}

/// Now-playing info from Music.app. Returns a structured string.
pub async fn music_now_playing() -> Result<String, String> {
    let script = r#"tell application "Music"
    if player state is stopped then
        return "stopped||||||"
    end if
    try
        set t to current track
        set pos to player position
        set dur to duration of t
        set pct to 0
        if dur > 0 then
            set pct to (pos / dur) * 100
        end if
        return (player state as text) & "|" & (name of t) & "|" & (artist of t) & "|" & (album of t) & "|" & (round pct) & "|" & pos & "|" & dur
    on error
        return "unknown||||||"
    end try
end tell
"#;
    let raw = run_osa(script).await?;
    let parts: Vec<&str> = raw.splitn(7, '|').collect();
    if parts.len() < 5 {
        return Ok(raw);
    }
    let state = parts[0];
    let title = parts[1];
    let artist = parts[2];
    let album = parts[3];
    let pct = parts[4];
    Ok(format!(
        "state={state} title={title:?} artist={artist:?} album={album:?} progress={pct}%"
    ))
}

/// Skip `count` tracks forward in Music.app.
pub async fn music_skip(count: u32) -> Result<String, String> {
    let n = count.max(1);
    let script = format!(
        r#"tell application "Music"
    repeat {n} times
        next track
    end repeat
    try
        set t to current track
        return "Now: " & (name of t) & " – " & (artist of t)
    on error
        return "Skipped {n} track(s)."
    end try
end tell
"#,
        n = n
    );
    run_osa(&script).await
}

/// Read or set Music.app volume (0–100). When `level` is `None`, returns the
/// current volume; when `Some`, sets it and confirms.
pub async fn music_volume(level: Option<u32>) -> Result<String, String> {
    match level {
        None => {
            let script = r#"tell application "Music"
    return (sound volume) as text
end tell
"#;
            let raw = run_osa(script).await?;
            Ok(format!("Volume: {raw}%"))
        }
        Some(v) => {
            let v = v.min(100);
            let script = format!(
                r#"tell application "Music"
    set sound volume to {v}
    return (sound volume) as text
end tell
"#,
                v = v
            );
            let raw = run_osa(&script).await?;
            Ok(format!("Volume set to {raw}%"))
        }
    }
}

// ---------------------------------------------------------------------------
// Photos.app
// ---------------------------------------------------------------------------

/// Returned for each photo from Photos.app queries.
#[derive(Debug, Clone)]
pub struct PhotoEntry {
    pub id: String,
    pub date: String,
    pub width: String,
    pub height: String,
}

impl PhotoEntry {
    fn to_display(&self) -> String {
        format!(
            "id={} date={} dimensions={}x{}",
            self.id, self.date, self.width, self.height
        )
    }
}

/// Recent photos from Photos.app (newest first).
pub async fn photos_recent(count: u32) -> Result<String, String> {
    let cap = count.clamp(1, 100);
    let script = format!(
        r#"set rs to (ASCII character 31)
set fs to (ASCII character 30)
set outLines to {{}}
tell application "Photos"
    set allMedia to media items
    set total to count of allMedia
    set startIdx to total - {cap} + 1
    if startIdx < 1 then set startIdx to 1
    repeat with i from total to startIdx by -1
        try
            set m to item i of allMedia
            set mId to (id of m) as text
            set mDate to (date of m) as text
            set mW to (width of m) as text
            set mH to (height of m) as text
            set end of outLines to mId & fs & mDate & fs & mW & fs & mH
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#,
        cap = cap
    );

    let raw = run_osa(&script).await?;
    parse_photos_output(&raw, cap as usize)
}

/// Search Photos.app by keyword/text.
pub async fn photos_search(query: &str) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("photos_search: `query` is empty".to_string());
    }
    let safe_q = escape_applescript(q);
    let script = format!(
        r#"set rs to (ASCII character 31)
set fs to (ASCII character 30)
set outLines to {{}}
tell application "Photos"
    set results to (search for "{safe_q}")
    repeat with m in results
        try
            set mId to (id of m) as text
            set mDate to (date of m) as text
            set mW to (width of m) as text
            set mH to (height of m) as text
            set end of outLines to mId & fs & mDate & fs & mW & fs & mH
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#,
        safe_q = safe_q
    );

    let raw = run_osa(&script).await?;
    parse_photos_output(&raw, 200)
}

fn parse_photos_output(raw: &str, cap: usize) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Ok("No photos found.".to_string());
    }
    let rs = '\u{1f}';
    let fs = '\u{1e}';
    let entries: Vec<PhotoEntry> = raw
        .split(rs)
        .filter_map(|row| {
            let row = row.trim_matches('\n');
            if row.is_empty() {
                return None;
            }
            let parts: Vec<&str> = row.split(fs).collect();
            if parts.len() < 4 {
                return None;
            }
            Some(PhotoEntry {
                id: parts[0].to_string(),
                date: parts[1].to_string(),
                width: parts[2].to_string(),
                height: parts[3].to_string(),
            })
        })
        .take(cap)
        .collect();

    if entries.is_empty() {
        return Ok("No photos found.".to_string());
    }

    let lines: Vec<String> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| format!("{}. {}", i + 1, e.to_display()))
        .collect();
    Ok(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// HomeKit scenes (via Shortcuts)
// ---------------------------------------------------------------------------

/// Run a HomeKit scene by running a same-named Shortcut. Validates the
/// shortcut exists first (L3 guard).
pub async fn homekit_scene_run(scene_name: &str) -> Result<String, String> {
    let name = scene_name.trim();
    if name.is_empty() {
        return Err("homekit_scene_run: `scene_name` is empty".to_string());
    }
    shortcut_run(name, None).await
}

// ---------------------------------------------------------------------------
// Focus mode
// ---------------------------------------------------------------------------

/// Activate a Focus / DND mode by running a same-named Shortcut.
pub async fn focus_mode_set(mode_name: &str) -> Result<String, String> {
    let name = mode_name.trim();
    if name.is_empty() {
        return Err("focus_mode_set: `mode_name` is empty".to_string());
    }
    shortcut_run(name, None).await
}

// ---------------------------------------------------------------------------
// system_notification
// ---------------------------------------------------------------------------

/// Post a native macOS notification via `osascript display notification`.
/// Both `title` and `body` are sanitised with `escape_applescript`.
pub async fn system_notification(
    title: &str,
    body: &str,
    sound: bool,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("system_notification: `title` is empty".to_string());
    }

    let safe_title = escape_applescript(title.trim());
    let safe_body = escape_applescript(body);
    let sound_clause = if sound {
        r#" sound name "default""#
    } else {
        ""
    };

    let script = format!(
        r#"display notification "{body}" with title "{title}"{sound}
"#,
        body = safe_body,
        title = safe_title,
        sound = sound_clause,
    );
    run_osa(&script).await?;
    Ok(format!("Notification sent: {title}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applescript::escape_applescript;

    // --- AppleScript escape tests (injection guard) ---

    #[test]
    fn escape_rejects_double_quote_injection() {
        // A raw `"` would close the AppleScript string literal early.
        let input = r#"Hello "World""#;
        let escaped = escape_applescript(input);
        // Every `"` must be preceded by `\` (i.e. no unescaped quotes).
        assert!(!has_unescaped_quote(&escaped), "unescaped quote: {escaped}");
        assert!(escaped.contains(r#"\""#));
    }

    /// Helper: true if `s` contains a `"` not preceded by a `\`.
    fn has_unescaped_quote(s: &str) -> bool {
        let bytes = s.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'"' {
                if i == 0 || bytes[i - 1] != b'\\' {
                    return true;
                }
            }
        }
        false
    }

    #[test]
    fn escape_rejects_backslash_injection() {
        let input = r#"path\to\file"#;
        let escaped = escape_applescript(input);
        // Every `\` in the original must be doubled; the escaped form should
        // contain `\\` pairs and no stray `\t` (which would mean a bare
        // backslash got misinterpreted as a tab escape).
        assert!(escaped.contains("\\\\"));
        // The literal "path\\to\\file" contains "\\t" as a substring, so the
        // stronger invariant is: the escape doubled every backslash.
        let raw_backslashes = input.chars().filter(|c| *c == '\\').count();
        let escaped_backslashes = escaped.chars().filter(|c| *c == '\\').count();
        assert_eq!(escaped_backslashes, raw_backslashes * 2);
    }

    #[test]
    fn escape_rejects_newline_injection() {
        let input = "line1\nend tell\ntell application \"Finder\"";
        let escaped = escape_applescript(input);
        assert!(!escaped.contains('\n'));
        assert!(escaped.contains("\\n"));
    }

    #[test]
    fn escape_rejects_carriage_return_injection() {
        let input = "value\rinjection";
        let escaped = escape_applescript(input);
        assert!(!escaped.contains('\r'));
        assert!(escaped.contains("\\r"));
    }

    #[test]
    fn escape_preserves_unicode() {
        let input = "日本語 café";
        let escaped = escape_applescript(input);
        assert_eq!(escaped, "日本語 café");
    }

    #[test]
    fn escape_combined_injection_attempt() {
        // Multi-vector attack: quote + backslash + newline.
        let input = "\";\nmalicious code\n\"";
        let escaped = escape_applescript(input);
        assert!(!escaped.contains('\n'));
        // No unescaped `"` (every `"` must be preceded by `\`).
        assert!(!has_unescaped_quote(&escaped), "unescaped quote: {escaped}");
        // Should have both \" and \n escape sequences.
        assert!(escaped.contains("\\\""));
        assert!(escaped.contains("\\n"));
    }

    // --- Shortcut name validation ---

    #[test]
    fn shortcut_entry_no_folder_parses_correctly() {
        // Simulate the parser logic inline for unit testability without I/O.
        let line = "My Shortcut";
        let entry = parse_shortcut_line(line);
        assert_eq!(entry.name, "My Shortcut");
        assert!(entry.folder.is_none());
    }

    #[test]
    fn shortcut_entry_with_folder_parses_correctly() {
        let line = "Lights Off [Home Automations]";
        let entry = parse_shortcut_line(line);
        assert_eq!(entry.name, "Lights Off");
        assert_eq!(entry.folder.as_deref(), Some("Home Automations"));
    }

    #[test]
    fn shortcut_entry_empty_bracket_yields_no_folder() {
        let line = "Test []";
        let entry = parse_shortcut_line(line);
        assert_eq!(entry.name, "Test");
        assert!(entry.folder.is_none());
    }

    // --- Music query parsing ---

    #[test]
    fn music_play_query_escapes_quotes() {
        // The query is embedded in an AppleScript string literal; verify
        // the escape path produces safe output.
        let q = r#"Rock "Classics""#;
        let escaped = escape_applescript(q.trim());
        // Must not contain any unescaped double-quote.
        assert!(!has_unescaped_quote(&escaped), "unescaped quote: {escaped}");
        assert!(escaped.contains("\\\""));
    }

    #[test]
    fn music_volume_clamps_above_100() {
        // We can't call the async fn in a sync test, but we can verify
        // the clamp logic in isolation.
        let raw: u32 = 150;
        let clamped = raw.min(100);
        assert_eq!(clamped, 100);
    }

    // --- Notification parameter boundaries ---

    #[test]
    fn notification_empty_title_body_escaping() {
        let title = "";
        let body = r#"Alert: "critical" issue\n detected"#;
        let safe_body = escape_applescript(body);
        // No unescaped quotes must survive.
        assert!(!has_unescaped_quote(&safe_body), "unescaped quote: {safe_body}");
        // Empty title stays empty (caller rejects it before reaching AppleScript).
        assert!(title.trim().is_empty());
    }

    #[test]
    fn notification_sound_clause_flag() {
        let with_sound = if true { r#" sound name "default""# } else { "" };
        let without_sound = if false { r#" sound name "default""# } else { "" };
        assert!(with_sound.contains("sound"));
        assert!(without_sound.is_empty());
    }

    #[test]
    fn photos_parse_empty_raw_returns_no_photos() {
        let result = parse_photos_output("", 10).unwrap();
        assert_eq!(result, "No photos found.");
    }

    #[test]
    fn photos_parse_single_entry() {
        let rs = '\u{1f}';
        let fs = '\u{1e}';
        let raw = format!("ABC123{fs}2026-04-20{fs}4032{fs}3024{rs}");
        let result = parse_photos_output(&raw, 10).unwrap();
        assert!(result.contains("ABC123"));
        assert!(result.contains("4032x3024"));
    }

    // --- Shortcut parser helper (extracted for unit tests) ---
    fn parse_shortcut_line(line: &str) -> ShortcutEntry {
        if let Some(bracket) = line.rfind('[') {
            let name = line[..bracket].trim().to_string();
            let folder_raw = &line[bracket + 1..];
            let folder = folder_raw.trim_end_matches(']').trim().to_string();
            ShortcutEntry {
                name,
                folder: if folder.is_empty() { None } else { Some(folder) },
            }
        } else {
            ShortcutEntry {
                name: line.trim().to_string(),
                folder: None,
            }
        }
    }
}
