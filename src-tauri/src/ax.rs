//! macOS window/app introspection via `osascript` + System Events.
//!
//! We intentionally avoid the native Accessibility API (AXUIElement / CG
//! window list) because:
//!   1. AX requires the user to grant Accessibility permission to Sunny in
//!      System Settings → Privacy & Security → Accessibility, and that grant
//!      is brittle across app re-signs / dev builds.
//!   2. Shelling out to `osascript` is reliable, ships with every macOS, and
//!      already works for basic frontmost-process queries *without* any
//!      permission prompt. Listing windows of other processes does trip the
//!      Automation / System Events prompt — we detect that error case and
//!      return a human-readable hint pointing the user at the right settings
//!      pane.
//!
//! Every `osascript` invocation runs with `env("PATH", fat_path())` and is
//! wrapped in a 3 s `tokio::time::timeout`. On timeout we return a descriptive
//! error rather than hanging the caller.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct FocusedApp {
    pub name: String,
    pub bundle_id: Option<String>,
    #[ts(type = "number")]
    pub pid: i64,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct WindowInfo {
    pub app_name: String,
    pub title: String,
    #[ts(type = "number")]
    pub pid: i64,
    #[ts(type = "number | null")]
    pub window_id: Option<u64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

pub async fn focused_app() -> Result<FocusedApp, String> {
    // Returns three lines: name, bundle id (may be "missing value"), unix id.
    let script = r#"
        tell application "System Events"
            set fp to first process whose frontmost is true
            set pn to name of fp
            set bid to ""
            try
                set bid to bundle identifier of fp
            end try
            set upid to unix id of fp
            return pn & linefeed & bid & linefeed & upid
        end tell
    "#;
    let out = run_osascript(script).await?;
    parse_focused_app(&out)
}

pub async fn active_window_title() -> Result<String, String> {
    let script = r#"
        tell application "System Events"
            set fp to first process whose frontmost is true
            try
                return name of front window of fp
            on error
                return ""
            end try
        end tell
    "#;
    let out = run_osascript(script).await?;
    Ok(out.trim().to_string())
}

pub async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    // One window per line:  app_name | title | x,y | w,h | unix_id
    let script = r#"
        set out to ""
        tell application "System Events"
            repeat with p in (processes whose background only is false)
                try
                    set pn to name of p
                    set upid to unix id of p
                    repeat with w in windows of p
                        try
                            set t to name of w
                            if t is missing value then set t to ""
                            set b to position of w
                            set s to size of w
                            set out to out & pn & "|" & t & "|" & (item 1 of b) & "," & (item 2 of b) & "|" & (item 1 of s) & "," & (item 2 of s) & "|" & upid & linefeed
                        end try
                    end repeat
                end try
            end repeat
        end tell
        return out
    "#;
    let out = run_osascript(script).await?;
    Ok(parse_window_listing(&out))
}

pub async fn frontmost_bundle_id() -> Result<String, String> {
    let script = r#"
        tell application "System Events"
            set fp to first process whose frontmost is true
            try
                return bundle identifier of fp
            on error
                return ""
            end try
        end tell
    "#;
    let out = run_osascript(script).await?;
    Ok(out.trim().to_string())
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

async fn run_osascript(script: &str) -> Result<String, String> {
    let fat = crate::paths::fat_path().unwrap_or_default();
    // kill_on_drop is load-bearing: when `timeout()` elapses it drops the
    // wait future, which drops the `Child`. Without kill_on_drop, tokio
    // leaves the `osascript` process running in the background and a
    // few dozen timeouts later the AppleScript bridge is saturated with
    // zombies, taking every subsequent osascript caller (calendar, mail,
    // notes, reminders, messages…) down with it.
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
                "osascript timed out after {}s — System Events may be unresponsive",
                OSASCRIPT_TIMEOUT.as_secs()
            ))
        }
    };

    let output = result.map_err(|e| format!("osascript spawn failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_osascript_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn classify_osascript_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("not authorized") || lower.contains("automation") || lower.contains("-1743") {
        "System Events automation permission required — System Settings → Privacy → Automation → Sunny".to_string()
    } else {
        format!("osascript error: {}", stderr.trim())
    }
}

fn parse_focused_app(out: &str) -> Result<FocusedApp, String> {
    let mut lines = out.lines().map(|l| l.trim());
    let name = lines.next().unwrap_or("").to_string();
    let bid_raw = lines.next().unwrap_or("").to_string();
    let pid_raw = lines.next().unwrap_or("");

    if name.is_empty() {
        return Err("focused app: empty response from System Events".to_string());
    }

    let bundle_id = if bid_raw.is_empty() || bid_raw == "missing value" {
        None
    } else {
        Some(bid_raw)
    };

    let pid: i64 = pid_raw.parse().unwrap_or(0);

    Ok(FocusedApp {
        name,
        bundle_id,
        pid,
    })
}

/// Parse the window listing output. Format per line:
///   app_name | title | x,y | w,h | unix_id
/// Tolerant of malformed lines — silently skips them.
fn parse_window_listing(out: &str) -> Vec<WindowInfo> {
    out.lines()
        .filter_map(|l| parse_window_line(l).ok())
        .collect()
}

fn parse_window_line(line: &str) -> Result<WindowInfo, &'static str> {
    let line = line.trim();
    if line.is_empty() {
        return Err("empty line");
    }
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() < 5 {
        return Err("too few fields");
    }

    let app_name = parts[0].trim().to_string();
    let title = parts[1].trim().to_string();
    let (x, y) = parse_pair(parts[2]);
    let (w, h) = parse_pair(parts[3]);
    let pid: i64 = parts[4].trim().parse().unwrap_or(0);

    if app_name.is_empty() {
        return Err("empty app name");
    }

    Ok(WindowInfo {
        app_name,
        title,
        pid,
        window_id: None, // AppleScript does not expose the CG window id.
        x,
        y,
        w,
        h,
    })
}

fn parse_pair(s: &str) -> (Option<f64>, Option<f64>) {
    let mut it = s.trim().split(',');
    let a = it.next().and_then(|v| v.trim().parse::<f64>().ok());
    let b = it.next().and_then(|v| v.trim().parse::<f64>().ok());
    (a, b)
}

// --------------------------------------------------------------------------
// Tests — pure helpers only. Do NOT hit System Events in CI.
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_window_line_extracts_all_fields() {
        let line = "Safari|Apple — Official Site|120,80|1440,900|5421";
        let w = parse_window_line(line).expect("should parse");
        assert_eq!(w.app_name, "Safari");
        assert_eq!(w.title, "Apple — Official Site");
        assert_eq!(w.x, Some(120.0));
        assert_eq!(w.y, Some(80.0));
        assert_eq!(w.w, Some(1440.0));
        assert_eq!(w.h, Some(900.0));
        assert_eq!(w.pid, 5421);
        assert!(w.window_id.is_none());
    }

    #[test]
    fn parse_window_line_rejects_malformed_input() {
        assert!(parse_window_line("").is_err());
        assert!(parse_window_line("Safari|title|120,80").is_err(), "needs 5 fields");
        assert!(parse_window_line("|title|0,0|100,100|1").is_err(), "empty app name");
    }

    #[test]
    fn parse_window_listing_skips_bad_lines_and_keeps_good() {
        let out = "\
Safari|Home|0,0|800,600|1\n\
broken line with no pipes\n\
Finder||10,10|400,300|2\n\
\n\
Terminal|zsh|50,50|900,700|3\n";
        let ws = parse_window_listing(out);
        assert_eq!(ws.len(), 3, "expected 3 valid windows, got {}", ws.len());
        assert_eq!(ws[0].app_name, "Safari");
        assert_eq!(ws[1].app_name, "Finder");
        assert_eq!(ws[1].title, ""); // empty title is allowed
        assert_eq!(ws[2].app_name, "Terminal");
    }

    #[test]
    fn parse_focused_app_handles_missing_bundle_id() {
        let out = "TextEdit\nmissing value\n1234\n";
        let fa = parse_focused_app(out).unwrap();
        assert_eq!(fa.name, "TextEdit");
        assert!(fa.bundle_id.is_none());
        assert_eq!(fa.pid, 1234);
    }

    #[test]
    fn parse_focused_app_accepts_real_bundle_id() {
        let out = "Safari\ncom.apple.Safari\n4242\n";
        let fa = parse_focused_app(out).unwrap();
        assert_eq!(fa.name, "Safari");
        assert_eq!(fa.bundle_id.as_deref(), Some("com.apple.Safari"));
        assert_eq!(fa.pid, 4242);
    }

    #[test]
    fn parse_focused_app_errors_on_empty() {
        assert!(parse_focused_app("").is_err());
    }

    #[test]
    fn classify_osascript_error_flags_automation_denial() {
        let msg = classify_osascript_error("execution error: Not authorized to send Apple events to System Events. (-1743)");
        assert!(msg.contains("Automation"), "expected Automation hint, got: {msg}");
        assert!(msg.contains("System Settings"));
    }

    #[test]
    fn classify_osascript_error_passes_through_other_errors() {
        let msg = classify_osascript_error("syntax error: Expected end of line.");
        assert!(msg.contains("osascript error"));
        assert!(msg.contains("syntax error"));
    }
}

// === REGISTER IN lib.rs ===
// mod ax;
// #[tauri::command] async fn window_focused_app() -> Result<ax::FocusedApp, String> { ax::focused_app().await }
// #[tauri::command] async fn window_active_title() -> Result<String, String> { ax::active_window_title().await }
// #[tauri::command] async fn window_list() -> Result<Vec<ax::WindowInfo>, String> { ax::list_windows().await }
// #[tauri::command] async fn window_frontmost_bundle_id() -> Result<String, String> { ax::frontmost_bundle_id().await }
// Add to invoke_handler: window_focused_app, window_active_title, window_list, window_frontmost_bundle_id
// No new Cargo deps required.
// === END REGISTER ===
