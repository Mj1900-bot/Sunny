//! Browser tool module — drives Safari (and Safari-only for now) through
//! AppleScript / `osascript`. Gives SUNNY the ability to open URLs, inspect
//! the current tab, read visible page text, navigate history, list and
//! select tabs, and snapshot the browser window.
//!
//! # Prerequisites (user must grant once)
//!
//!   1. **Safari → Develop menu → "Allow JavaScript from Apple Events"**
//!      must be enabled. Without this, every `do JavaScript` call fails
//!      with "Safari got an error: AppleEvent handler failed." and we
//!      can't evaluate `document.readyState`, `document.body.innerText`,
//!      `history.back()`, etc. Enable the Develop menu first in
//!      Safari → Settings → Advanced → "Show Develop menu in menu bar".
//!
//!   2. **System Settings → Privacy & Security → Automation**: Sunny.app
//!      must be allowed to control Safari (and "System Events" if the
//!      screenshot helper needs it). The first time we fire an Apple Event
//!      macOS will prompt; if the user clicks Don't Allow, subsequent
//!      calls return `-1743` and show up here as a string error.
//!
//! We deliberately do NOT try to toggle either setting programmatically —
//! that would require `defaults write` + a Safari relaunch, and silently
//! changing browser security preferences is not the SUNNY style.
//!
//! # Transport
//!
//! Everything goes through `/usr/bin/osascript -e <script>`. No new Cargo
//! deps; macOS has osascript preinstalled. We follow the same async +
//! `Result<String, String>` contract as `voice.rs` / `ai.rs` so the Tauri
//! wrappers in `commands.rs` / `lib.rs` can forward results verbatim.
//!
//! # Input safety
//!
//! AppleScript string literals are double-quoted. Any `"` or `\` in a
//! user-supplied string (a URL, a title) is escaped before interpolation.
//! URLs are further rejected if they contain ASCII control characters
//! (0x00–0x1F, 0x7F) which cannot legally appear in a URL and almost
//! always indicate injection attempts or malformed input.
//!
//! NOTE: Only `browser_open` and `browser_read_page_text` are currently
//! wired into the dispatch loop. The remaining commands (tabs list,
//! back/forward, screenshot, tab close/select) are PARKED — they'll be
//! activated when the agent gains richer browser control. Keeping them
//! compiled catches signature drift early.

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::sleep;

use crate::applescript::escape_applescript;

const OSASCRIPT_BIN: &str = "/usr/bin/osascript";
const SCREENCAPTURE_BIN: &str = "/usr/sbin/screencapture";

const READY_POLL_MS: u64 = 200;
const READY_TIMEOUT_MS: u64 = 8_000;

const READ_TEXT_DEFAULT: usize = 6_000;
const READ_TEXT_MAX: usize = 16_000;


/// Reject anything that isn't a plain `http://` or `https://` URL the user
/// would reasonably expect a browser-open tool to handle.
///
/// Why a strict allowlist: the LLM drives this tool and an attacker-controlled
/// prompt could convince it to open `file:///Users/...ssh/id_rsa` (Safari
/// renders the private key, then `browser_read_page_text` exfiltrates it),
/// `javascript:…` (executes in whatever tab is active), or
/// `data:text/html,…` (self-hosted phishing surface). We also reject
/// `user:pass@host` authorities because they hide the true destination from
/// a human skimming the URL bar.
///
/// Control characters are rejected separately — they should never appear in
/// a URL and almost always indicate shell/AppleScript injection attempts.
fn validate_url(url: &str) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("url must not be empty".into());
    }
    if url.chars().any(|c| (c as u32) < 0x20 || (c as u32) == 0x7F) {
        return Err("url contains control characters".into());
    }

    // Extract scheme (up to first ':'). RFC 3986 requires the scheme to start
    // with an ALPHA and contain only ALPHA / DIGIT / '+' / '-' / '.'. We
    // parse more leniently and then match against the allowlist — if the
    // scheme is malformed we'll fall through to "missing scheme".
    let colon = url
        .find(':')
        .ok_or_else(|| "url missing scheme; only http and https URLs can be opened".to_string())?;
    let scheme = &url[..colon];
    if scheme.is_empty() {
        return Err("url missing scheme; only http and https URLs can be opened".into());
    }
    let scheme_lc = scheme.to_ascii_lowercase();
    if scheme_lc != "http" && scheme_lc != "https" {
        return Err(format!(
            "scheme '{scheme_lc}' is not allowed; only http and https URLs can be opened"
        ));
    }

    // After the scheme we require "//" (an authority component). Without it
    // we can't have a real host — reject `http:foo`, `http:/bar`, etc.
    let rest = &url[colon + 1..];
    let authority_and_path = rest
        .strip_prefix("//")
        .ok_or_else(|| "url missing '//' after scheme".to_string())?;

    // Authority ends at the first '/', '?', or '#'; everything before that
    // is `[userinfo@]host[:port]`.
    let auth_end = authority_and_path
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(authority_and_path.len());
    let authority = &authority_and_path[..auth_end];

    // Reject user:pass@ — the '@' before the host lets an attacker dress up
    // a malicious URL to look like a trusted one in the prompt
    // (`https://apple.com@evil.example/`).
    if authority.contains('@') {
        return Err("url must not contain userinfo (user:pass@host is not allowed)".into());
    }

    // Host is everything up to an optional ':port'. Strip IPv6 brackets for
    // the emptiness check — `[::1]` is a perfectly valid host.
    let host = match authority.rfind(':') {
        // Don't split on ':' inside an IPv6 literal: `[::1]:8080` — the
        // rightmost ':' is the port separator, and it follows the closing
        // bracket. If the authority starts with '[' but the ':' precedes
        // the ']', we're inside the literal; use the whole authority.
        Some(idx) if !(authority.starts_with('[') && idx < authority.rfind(']').unwrap_or(0)) => {
            &authority[..idx]
        }
        _ => authority,
    };
    let host_trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if host_trimmed.is_empty() {
        return Err("url has empty host".into());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// osascript plumbing
// ---------------------------------------------------------------------------

/// Run an AppleScript source string, return trimmed stdout. Errors surface
/// osascript's stderr when present so AppleScript-level failures (`-1743`
/// not authorised, `-1728` can't get window 1, …) are visible to the AI
/// and to the UI.
async fn run_osascript(script: &str) -> Result<String, String> {
    let mut cmd = Command::new(OSASCRIPT_BIN);
    cmd.arg("-e")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("osascript spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let code = out.status.code().unwrap_or(-1);
        return Err(if stderr.is_empty() {
            format!("osascript exit {code}")
        } else {
            format!("osascript exit {code}: {stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

// ---------------------------------------------------------------------------
// 1. browser_open
// ---------------------------------------------------------------------------

/// Activate Safari (launching it if necessary), open `url` in a new tab
/// in the frontmost window, and wait up to 8 s for the page to finish
/// loading. Returns `"Opened <url> in Safari"` on success.
///
/// The wait polls `document.readyState` at 200 ms intervals and exits
/// early once the value becomes `"complete"`. If the browser never
/// reaches that state (slow page, blocked by a dialog) we still return
/// Ok — the caller wanted the URL opened, not a render guarantee — and
/// note the timeout in the returned string.
#[tauri::command]
pub async fn browser_open(url: String) -> Result<String, String> {
    validate_url(&url)?;
    let url_esc = escape_applescript(&url);

    // Activate and launch. Using `tell app "Safari" to activate` starts
    // Safari if it's not running and brings it forward. We then open the
    // URL via `open location` when there are no windows, otherwise
    // `make new tab` in the front window so we don't clobber context.
    let open_script = format!(
        r#"tell application "Safari"
    activate
    if (count of windows) is 0 then
        make new document with properties {{URL:"{url}"}}
    else
        tell window 1
            set newTab to make new tab with properties {{URL:"{url}"}}
            set current tab to newTab
        end tell
    end if
end tell
return "ok""#,
        url = url_esc
    );
    run_osascript(&open_script).await?;

    // Poll readyState until "complete" or timeout. Each poll is its own
    // osascript call — osascript is fast enough (~30-60 ms warm) that
    // a 200 ms cadence is fine and keeps the logic simple.
    let ready_script = r#"tell application "Safari"
    try
        return (do JavaScript "document.readyState" in current tab of window 1) as string
    on error
        return "error"
    end try
end tell"#;
    let deadline_polls = READY_TIMEOUT_MS / READY_POLL_MS;
    let mut last_state = String::from("unknown");
    let mut timed_out = true;
    for _ in 0..deadline_polls {
        sleep(Duration::from_millis(READY_POLL_MS)).await;
        match run_osascript(ready_script).await {
            Ok(state) => {
                last_state = state;
                if last_state == "complete" {
                    timed_out = false;
                    break;
                }
            }
            Err(_) => {
                // Transient — the tab might not be fully attached yet.
                // Keep polling; we'll return the underlying message if
                // we never see "complete".
            }
        }
    }

    if timed_out {
        Ok(format!(
            "Opened {url} in Safari (load wait timed out at {}ms, readyState={last_state})",
            READY_TIMEOUT_MS
        ))
    } else {
        Ok(format!("Opened {url} in Safari"))
    }
}

// ---------------------------------------------------------------------------
// 2. browser_current_url
// ---------------------------------------------------------------------------

/// Return the URL of the frontmost Safari tab. Errors if Safari is not
/// running or has no open windows.
#[tauri::command]
pub async fn browser_current_url() -> Result<String, String> {
    let script = r#"tell application "Safari"
    if (count of windows) is 0 then error "Safari has no open windows"
    return URL of current tab of window 1
end tell"#;
    let url = run_osascript(script).await?;
    if url.is_empty() {
        return Err("Safari returned no URL (blank tab?)".into());
    }
    Ok(url)
}

// ---------------------------------------------------------------------------
// 3. browser_read_page_text
// ---------------------------------------------------------------------------

/// Evaluate `document.body.innerText` in the frontmost Safari tab. The
/// Safari Develop menu's **"Allow JavaScript from Apple Events"** must be
/// enabled — without it this call fails with an AppleEvent error and we
/// do NOT try to toggle the setting from here.
///
/// Whitespace is normalised (runs of spaces/tabs collapsed, blank lines
/// limited to single blanks) and the result is truncated to `max_chars`
/// (default 6 000, upper bound 16 000) with a trailing
/// `[truncated at N chars]` suffix when cut.
#[tauri::command]
pub async fn browser_read_page_text(max_chars: Option<usize>) -> Result<String, String> {
    let cap = max_chars
        .unwrap_or(READ_TEXT_DEFAULT)
        .clamp(1, READ_TEXT_MAX);

    let script = r#"tell application "Safari"
    if (count of windows) is 0 then error "Safari has no open windows"
    try
        set theText to (do JavaScript "document.body ? document.body.innerText : ''" in current tab of window 1)
    on error errMsg number errNum
        error "innerText failed (" & errNum & "): " & errMsg
    end try
    if theText is missing value then return ""
    return theText as string
end tell"#;

    let raw = run_osascript(script).await?;
    let cleaned = collapse_whitespace(&raw);

    if cleaned.chars().count() <= cap {
        return Ok(cleaned);
    }
    // Truncate by character count, not byte count, so multi-byte Unicode
    // doesn't produce a sliced glyph at the boundary.
    let truncated: String = cleaned.chars().take(cap).collect();
    Ok(format!("{truncated}\n[truncated at {cap} chars]"))
}

/// Collapse runs of horizontal whitespace and limit consecutive blank
/// lines to one. Keeps the body readable without losing paragraph
/// structure; Safari's innerText typically already separates paragraphs
/// with `\n\n`.
fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut blank_run = 0usize;
    for raw_line in input.split('\n') {
        // Collapse interior horizontal whitespace runs to a single space.
        let mut line = String::with_capacity(raw_line.len());
        let mut prev_space = false;
        for ch in raw_line.chars() {
            if ch == ' ' || ch == '\t' {
                if !prev_space {
                    line.push(' ');
                    prev_space = true;
                }
            } else {
                line.push(ch);
                prev_space = false;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    // Strip leading/trailing blank runs so the final output doesn't
    // start or end with whitespace.
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// 4. browser_tabs_list
// ---------------------------------------------------------------------------

/// List all tabs across every Safari window as `"<idx>. <title> — <url>"`
/// lines. Indices are 1-based and contiguous across windows in the order
/// AppleScript enumerates them (front window first); callers pass the
/// index straight back to `browser_tab_select`.
#[tauri::command]
pub async fn browser_tabs_list() -> Result<String, String> {
    // AppleScript's `repeat with w in windows of application "Safari"` and
    // `repeat with t in tabs of w` lets us build a flat list. We use a
    // tab character between fields to keep the parse robust (titles can
    // contain em-dashes themselves) then rebuild as " — " on the Rust
    // side.
    let script = r#"set out to ""
tell application "Safari"
    if (count of windows) is 0 then return ""
    set idx to 0
    repeat with w in windows
        repeat with t in tabs of w
            set idx to idx + 1
            try
                set theTitle to name of t
            on error
                set theTitle to "(untitled)"
            end try
            try
                set theUrl to URL of t
            on error
                set theUrl to ""
            end try
            if theTitle is missing value then set theTitle to "(untitled)"
            if theUrl is missing value then set theUrl to ""
            set out to out & idx & (ASCII character 9) & theTitle & (ASCII character 9) & theUrl & linefeed
        end repeat
    end repeat
end tell
return out"#;

    let raw = run_osascript(script).await?;
    if raw.trim().is_empty() {
        return Ok("No Safari tabs open.".into());
    }
    let mut rendered = String::new();
    let mut count = 0usize;
    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let (idx, title, url) = match (parts.next(), parts.next(), parts.next()) {
            (Some(i), Some(t), Some(u)) => (i, t, u),
            _ => continue,
        };
        let title = if title.is_empty() { "(untitled)" } else { title };
        let url = if url.is_empty() { "(no url)" } else { url };
        rendered.push_str(&format!("{idx}. {title} — {url}\n"));
        count += 1;
    }
    if count == 0 {
        return Ok("No Safari tabs open.".into());
    }
    Ok(rendered.trim_end().to_string())
}

// ---------------------------------------------------------------------------
// 5. browser_tab_select
// ---------------------------------------------------------------------------

/// Make the tab at the given 1-based index (as returned by
/// `browser_tabs_list`) the frontmost tab, bringing its parent window to
/// the front if necessary.
#[tauri::command]
pub async fn browser_tab_select(index: usize) -> Result<String, String> {
    if index == 0 {
        return Err("tab index is 1-based; use 1 for the first tab".into());
    }

    let script = format!(
        r#"set targetIdx to {index}
set cursor to 0
tell application "Safari"
    if (count of windows) is 0 then error "Safari has no open windows"
    repeat with w in windows
        set tabCount to count of tabs of w
        if cursor + tabCount is greater than or equal to targetIdx then
            set localIdx to targetIdx - cursor
            set current tab of w to tab localIdx of w
            set index of w to 1
            activate
            try
                set t to current tab of w
                return (name of t as string)
            on error
                return "selected"
            end try
        end if
        set cursor to cursor + tabCount
    end repeat
    error "tab index " & targetIdx & " out of range (" & cursor & " tabs total)"
end tell"#,
        index = index
    );

    let title = run_osascript(&script).await?;
    let shown = if title.is_empty() { "(untitled)" } else { title.as_str() };
    Ok(format!("Selected tab {index}: {shown}"))
}

// ---------------------------------------------------------------------------
// 6. browser_back / browser_forward
// ---------------------------------------------------------------------------

/// Navigate the frontmost tab one step back in history. Relies on JS
/// Apple Events being enabled (see the module doc).
#[tauri::command]
pub async fn browser_back() -> Result<String, String> {
    history_nav("history.back()", "back").await
}

/// Navigate the frontmost tab one step forward in history.
#[tauri::command]
pub async fn browser_forward() -> Result<String, String> {
    history_nav("history.forward()", "forward").await
}

async fn history_nav(js: &str, label: &str) -> Result<String, String> {
    let script = format!(
        r#"tell application "Safari"
    if (count of windows) is 0 then error "Safari has no open windows"
    do JavaScript "{js}; void 0;" in current tab of window 1
end tell
return "ok""#,
        js = js
    );
    run_osascript(&script).await?;
    Ok(format!("Navigated {label} in Safari"))
}

// ---------------------------------------------------------------------------
// 7. browser_close_tab
// ---------------------------------------------------------------------------

/// Close the frontmost Safari tab. If the closure leaves the window with
/// zero tabs, Safari itself handles window-close semantics (which is a
/// user preference) — we don't second-guess it.
#[tauri::command]
pub async fn browser_close_tab() -> Result<String, String> {
    let script = r#"tell application "Safari"
    if (count of windows) is 0 then error "Safari has no open windows"
    try
        set t to current tab of window 1
        set theTitle to name of t
    on error
        set theTitle to "(untitled)"
    end try
    close current tab of window 1
    return theTitle
end tell"#;
    let title = run_osascript(script).await?;
    let shown = if title.is_empty() { "(untitled)" } else { title.as_str() };
    Ok(format!("Closed tab: {shown}"))
}

// ---------------------------------------------------------------------------
// 8. browser_screenshot
// ---------------------------------------------------------------------------

/// Capture the frontmost Safari window to a PNG under `$TMPDIR` and
/// return the absolute file path. Uses `screencapture -l <windowId>`
/// when we can resolve the CGWindowID via AppleScript (`id of window 1`
/// inside `tell app "Safari"`); falls back to a full-screen capture if
/// that fails. The caller is expected to read / base64-encode the file.
#[tauri::command]
pub async fn browser_screenshot() -> Result<String, String> {
    let path = tmp_screenshot_path();

    let window_id = safari_front_window_id().await;
    let mut args: Vec<String> = Vec::new();
    if let Some(id) = window_id {
        args.push(format!("-l{id}"));
    }
    args.extend(["-x".into(), "-t".into(), "png".into()]);
    args.push(path.to_string_lossy().into_owned());

    let mut cmd = Command::new(SCREENCAPTURE_BIN);
    cmd.args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("screencapture spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "screencapture exit {}: {}",
            out.status,
            if stderr.is_empty() {
                "(no stderr — likely Screen Recording permission not granted)"
            } else {
                stderr.as_str()
            }
        ));
    }

    // Sanity-check the file exists and is non-trivial. A zero-byte PNG
    // usually means the window id was stale by the time screencapture
    // looked it up.
    match std::fs::metadata(&path) {
        Ok(m) if m.len() > 128 => Ok(path.to_string_lossy().into_owned()),
        Ok(m) => Err(format!(
            "screencapture produced a suspiciously small file ({} bytes) at {}",
            m.len(),
            path.display()
        )),
        Err(e) => Err(format!("screencapture output missing at {}: {}", path.display(), e)),
    }
}

async fn safari_front_window_id() -> Option<u64> {
    // `id of window 1` on Safari returns the CGWindowID (a 64-bit number)
    // that `screencapture -l` accepts. We ask Safari directly rather than
    // going through System Events so the user only has to approve one
    // automation target.
    let script = r#"tell application "Safari"
    if (count of windows) is 0 then return ""
    try
        return id of window 1 as string
    on error
        return ""
    end try
end tell"#;
    let raw = run_osascript(script).await.ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

fn tmp_screenshot_path() -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("sunny-safari-{nonce:x}.png"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn validate_url_rejects_controls_and_empty() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("").is_err());
        assert!(validate_url("   ").is_err());
        assert!(validate_url("https://e\nvil.com").is_err());
        assert!(validate_url("https://e\x7fvil.com").is_err());
    }

    #[test]
    fn validate_url_allows_http_and_https() {
        assert!(validate_url("http://example.com").is_ok());
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://example.com/path?q=1#frag").is_ok());
        assert!(validate_url("https://example.com:8443/path").is_ok());
    }

    #[test]
    fn validate_url_scheme_compare_is_case_insensitive() {
        assert!(validate_url("HTTPS://EXAMPLE.COM").is_ok());
        assert!(validate_url("HtTp://Example.com").is_ok());
    }

    #[test]
    fn validate_url_rejects_dangerous_schemes() {
        let cases = [
            "file:///etc/passwd",
            "file:///Users/sunny/.ssh/id_rsa",
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "about:blank",
            "chrome://settings",
            "resource://gre/modules/",
            "ftp://example.com/",
            "ws://example.com/",
            "wss://example.com/",
        ];
        for url in cases {
            let res = validate_url(url);
            assert!(res.is_err(), "expected rejection for {url}, got Ok");
            let msg = res.unwrap_err();
            assert!(
                msg.contains("not allowed") || msg.contains("missing"),
                "unexpected error for {url}: {msg}"
            );
        }
    }

    #[test]
    fn validate_url_error_message_names_scheme() {
        let err = validate_url("file:///etc/passwd").unwrap_err();
        assert!(err.contains("file"), "err should name the scheme: {err}");
        assert!(
            err.contains("only http and https"),
            "err should mention allowed schemes: {err}"
        );
    }

    #[test]
    fn validate_url_rejects_userinfo_authority() {
        assert!(validate_url("http://user:pass@evil.com").is_err());
        assert!(validate_url("https://user@evil.com/path").is_err());
        assert!(validate_url("https://apple.com@evil.example/").is_err());
    }

    #[test]
    fn validate_url_rejects_empty_host() {
        assert!(validate_url("http://").is_err());
        assert!(validate_url("https://").is_err());
        assert!(validate_url("http:///path").is_err());
        assert!(validate_url("https://:8080/").is_err());
    }

    #[test]
    fn validate_url_rejects_missing_scheme_and_garbage() {
        assert!(validate_url("not-a-url").is_err());
        assert!(validate_url("example.com").is_err());
        assert!(validate_url("//example.com").is_err());
        assert!(validate_url(":no-scheme").is_err());
        assert!(validate_url("http:no-slashes").is_err());
    }

    #[test]
    fn validate_url_accepts_ipv6_literal_host() {
        // Make sure the authority parser doesn't choke on IPv6 brackets.
        assert!(validate_url("http://[::1]/").is_ok());
        assert!(validate_url("https://[2001:db8::1]:8443/path").is_ok());
    }

    #[test]
    fn collapse_whitespace_collapses_runs_and_blanks() {
        let input = "  hello   world  \n\n\n\nnext\n\n\n";
        let got = collapse_whitespace(input);
        assert_eq!(got, "hello world\n\nnext");
    }

    #[test]
    fn collapse_whitespace_preserves_unicode() {
        let input = "café  —  münchen";
        assert_eq!(collapse_whitespace(input), "café — münchen");
    }
}
