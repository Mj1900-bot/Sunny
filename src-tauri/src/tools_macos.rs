//! macOS Control tool module — AppleScript-driven access to Mail, Calendar,
//! Notes, Messages, Reminders, Shortcuts, and basic application control so
//! that voice-first flows ("send this email", "what's on my calendar today",
//! "remind me to call Mom at three") all route through a single, uniform
//! surface.
//!
//! # Permissions
//!
//! SUNNY.app needs Automation permissions for each scripted app under
//! **System Settings → Privacy & Security → Automation → Sunny**:
//!
//!   - Mail         (for mail_list_unread / mail_send)
//!   - Calendar     (for calendar_today / calendar_upcoming / calendar_create_event)
//!   - Notes        (for notes_create / notes_search)
//!   - Messages     (for imessage_send)
//!   - Reminders    (for reminders_add / reminders_today)
//!   - Finder       (for finder_reveal)
//!   - System Events / any target app (for app_launch / app_quit)
//!   - Shortcuts    (for shortcut_run; also relies on the `shortcuts` CLI)
//!
//! The OS prompts once per (scripting-app × target-app) pair on first use.
//! A denial surfaces as AppleScript error `-1743` / "not authorized" — we
//! classify that into a human-readable hint pointing back here.
//!
//! # Safety
//!
//! Most commands in this module mutate user-visible state (deliver a message,
//! create a calendar event, launch an app). The frontend tool registrations
//! in `tools.macos.ts` mark those `dangerous: true` so the orchestrator's
//! `ConfirmGate` can show a preview before invocation. Read-only commands
//! (`mail_list_unread`, `calendar_today`, `calendar_upcoming`, `notes_search`,
//! `reminders_today`) are not gated.
//!
//! # Stdin-piped osascript
//!
//! Every AppleScript snippet in this module is handed to `osascript` on stdin
//! rather than via `-e <literal>` so multi-line scripts and embedded quotes
//! don't have to be double-escaped through the shell. `run_osascript` writes
//! the script to the child's stdin then waits for exit. Inputs that land
//! inside AppleScript string literals go through `escape_as` (backslashes,
//! double-quotes, tabs). Newlines are rendered via the `& return &`
//! concatenation form so a stray `\n` can't terminate a literal early.

use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

/// 30s covers a cold Calendar.app launch + iCloud sync. 20s was too
/// tight when Calendar had to rebuild its event cache on first call of
/// the session, which surfaced as `calendar_today: timeout` in the
/// Memory page. Raise cost budget rather than cap the useful path.
const OSA_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Pipe `script` into `osascript` on stdin. This avoids the CLI escape hell
/// that comes with `-e "…"` for multi-line scripts and lets us embed any
/// character the AppleScript compiler will accept without an extra
/// shell-escape pass.
async fn run_osascript(script: &str) -> Result<String, String> {
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
        // Dropping `stdin` here closes the pipe so osascript sees EOF.
    }

    let output = match timeout(OSA_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript wait failed: {e}")),
        Err(_) => return Err(format!("osascript timed out after {}s", OSA_TIMEOUT.as_secs())),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_osascript_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_string())
}

fn classify_osascript_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("-1743")
        || lower.contains("not authorized")
        || lower.contains("not allowed")
    {
        return "Automation permission denied — System Settings → Privacy & Security → Automation → Sunny, enable the target app".to_string();
    }
    format!("osascript: {}", stderr.trim())
}

/// Escape a string for embedding in an AppleScript double-quoted literal.
/// Order matters: backslashes first, then quotes, then control characters.
/// Newlines are NOT inlined here — use `as_string_expr` when the caller
/// needs a multi-line value, which splits on newlines and splices `return`
/// tokens at the AppleScript level.
fn escape_as(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

/// Render `s` as an AppleScript *expression* that evaluates to the original
/// string, preserving newlines by concatenating literal fragments with
/// `return`. Single-line inputs round-trip to a plain quoted literal.
fn as_string_expr(s: &str) -> String {
    if !s.contains('\n') && !s.contains('\r') {
        return format!("\"{}\"", escape_as(s));
    }
    // Normalise CRLF → LF then split so we don't generate an empty fragment
    // between `\r\n` pairs.
    let normalised = s.replace("\r\n", "\n").replace('\r', "\n");
    let parts: Vec<String> = normalised
        .split('\n')
        .map(|frag| format!("\"{}\"", escape_as(frag)))
        .collect();
    parts.join(" & return & ")
}

/// Convert an ISO-8601 timestamp ("2026-04-18T14:30:00" or trailing "Z") into
/// the `YYYY-MM-DD HH:MM:SS` form AppleScript's `date` coercion accepts.
/// Returns `None` for inputs that don't look like an ISO timestamp so the
/// caller can surface a clear error instead of producing `date "garbage"`.
fn iso_to_applescript_date(iso: &str) -> Option<String> {
    let t = iso.trim();
    if t.is_empty() {
        return None;
    }
    // Strip trailing Z and any ±HH:MM offset.
    let stripped = strip_tz_suffix(t);
    // Allow date-only "YYYY-MM-DD" — treat as midnight.
    if stripped.len() == 10 && stripped.as_bytes().get(4) == Some(&b'-') {
        return Some(format!("{stripped} 00:00:00"));
    }
    // Expect "YYYY-MM-DDTHH:MM(:SS)?".
    let (date, time) = stripped.split_once('T')?;
    if date.len() != 10 {
        return None;
    }
    let time_padded = match time.len() {
        5 => format!("{time}:00"),
        8 => time.to_string(),
        _ => return None,
    };
    Some(format!("{date} {time_padded}"))
}

fn strip_tz_suffix(s: &str) -> String {
    if let Some(idx) = s.rfind(&['+', '-'][..]) {
        // Only treat +/- as a TZ sign if it's at position >= 11 (after the
        // date portion) and followed by something that looks like HH:MM.
        if idx >= 11 {
            let tail = &s[idx..];
            if tail.len() >= 3 && tail[1..].chars().all(|c| c.is_ascii_digit() || c == ':') {
                return s[..idx].to_string();
            }
        }
    }
    if let Some(prefix) = s.strip_suffix('Z') {
        return prefix.to_string();
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/// List the newest unread messages across every INBOX mailbox. Returns a
/// numbered, human-readable block the agent can read aloud verbatim. The
/// script gathers `{subject, sender, date received}` triples from every
/// mailbox whose name ends with "INBOX", concatenates them with a record
/// separator `\u{1f}` and a field separator `\u{1e}`, then we take the
/// newest `limit` rows in Rust to keep AppleScript-side sorting cheap.
#[tauri::command]
pub async fn mail_list_unread(limit: Option<u32>) -> Result<String, String> {
    let cap = limit.unwrap_or(10).clamp(1, 200) as usize;

    // Field separator: ASCII 0x1e (RS). Record separator: ASCII 0x1f (US).
    // Using control characters means we never collide with anything the
    // user could plausibly type into a subject line.
    let script = r#"set rs to (ASCII character 31)
set fs to (ASCII character 30)
set outLines to {}
tell application "Mail"
    repeat with acct in accounts
        try
            repeat with mb in mailboxes of acct
                try
                    if (name of mb) is "INBOX" or (name of mb) ends with "INBOX" or (name of mb) is "Inbox" then
                        set unreadMsgs to (messages of mb whose read status is false)
                        repeat with m in unreadMsgs
                            try
                                set theSubj to (subject of m) as text
                            on error
                                set theSubj to "(no subject)"
                            end try
                            try
                                set theSender to (sender of m) as text
                            on error
                                set theSender to "(unknown)"
                            end try
                            try
                                set theDate to (date received of m) as text
                            on error
                                set theDate to ""
                            end try
                            set end of outLines to theSubj & fs & theSender & fs & theDate
                        end repeat
                    end if
                end try
            end repeat
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#;

    let raw = run_osascript(script).await?;
    if raw.trim().is_empty() {
        return Ok("No unread mail.".to_string());
    }

    let rs = '\u{1f}';
    let fs = '\u{1e}';
    let rows: Vec<(String, String, String)> = raw
        .split(rs)
        .filter_map(|row| {
            let row = row.trim_matches('\n');
            if row.is_empty() {
                return None;
            }
            let mut parts = row.split(fs);
            let subject = parts.next()?.to_string();
            let sender = parts.next().unwrap_or("").to_string();
            let date = parts.next().unwrap_or("").to_string();
            Some((subject, sender, date))
        })
        .collect();

    if rows.is_empty() {
        return Ok("No unread mail.".to_string());
    }

    // AppleScript returned messages roughly in mailbox order; the spec asks
    // for the newest first, so sort descending by date string. The macOS
    // date format ("Saturday, April 18, 2026 at 2:30:00 PM") doesn't sort
    // lexicographically, so we reverse the original order as a best-effort
    // "newest last" → "newest first" heuristic, which matches how Mail.app
    // enumerates messages inside a mailbox.
    let mut newest_first: Vec<(String, String, String)> = rows.into_iter().rev().collect();
    newest_first.truncate(cap);

    let mut out = String::new();
    for (idx, (subject, sender, date)) in newest_first.iter().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "{n}. From {sender} ({date}): {subject}",
            n = idx + 1,
            sender = sender,
            date = date,
            subject = subject,
        ));
    }
    Ok(out)
}

/// Compose and send a message via Mail.app. Returns a confirmation string
/// on success. Any AppleScript failure — including the automation prompt
/// being denied — surfaces through `classify_osascript_error`.
#[tauri::command]
pub async fn mail_send(
    to: String,
    subject: String,
    body: String,
    cc: Option<String>,
) -> Result<String, String> {
    if to.trim().is_empty() {
        return Err("mail_send: `to` is empty".to_string());
    }
    if subject.trim().is_empty() {
        return Err("mail_send: `subject` is empty".to_string());
    }

    let subject_expr = as_string_expr(&subject);
    let body_expr = as_string_expr(&body);
    let to_expr = format!("\"{}\"", escape_as(&to));

    let cc_block = match cc.as_deref() {
        Some(c) if !c.trim().is_empty() => format!(
            "        make new cc recipient at end of cc recipients with properties {{address:\"{}\"}}\n",
            escape_as(c)
        ),
        _ => String::new(),
    };

    let script = format!(
        r#"tell application "Mail"
    set newMsg to make new outgoing message with properties {{subject:{subject_expr}, content:{body_expr}, visible:false}}
    tell newMsg
        make new to recipient at end of to recipients with properties {{address:{to_expr}}}
{cc_block}    end tell
    send newMsg
end tell
return "sent"
"#,
        subject_expr = subject_expr,
        body_expr = body_expr,
        to_expr = to_expr,
        cc_block = cc_block,
    );

    run_osascript(&script).await?;
    Ok(format!("Mail sent to {to} — \"{subject}\""))
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn calendar_today() -> Result<String, String> {
    calendar_window(0).await
}

#[tauri::command]
pub async fn calendar_upcoming(days: Option<u32>) -> Result<String, String> {
    let d = days.unwrap_or(3).clamp(1, 30);
    calendar_window(d as i64).await
}

/// Internal: list events whose start falls between `midnight_today` and
/// `midnight_today + (days + 1) * 86400` seconds. `days == 0` means "today
/// only"; `days > 0` extends the window `days` calendar days forward.
async fn calendar_window(days: i64) -> Result<String, String> {
    let rs: char = '\u{1f}';
    let fs: char = '\u{1e}';

    // AppleScript date arithmetic: `current date` → today at now; we roll
    // back to midnight, then expand the window by `(days + 1) * 86400` to
    // include every event that starts on any day in the range.
    let script = format!(
        r#"set rs to (ASCII character 31)
set fs to (ASCII character 30)
set startOfDay to (current date)
set hours of startOfDay to 0
set minutes of startOfDay to 0
set seconds of startOfDay to 0
set endOfRange to startOfDay + ({days} + 1) * days
set outLines to {{}}
tell application "Calendar"
    repeat with cal in calendars
        try
            set calName to (name of cal) as text
            set evs to (every event of cal whose start date >= startOfDay and start date < endOfRange)
            repeat with e in evs
                try
                    set evTitle to (summary of e) as text
                on error
                    set evTitle to "(untitled)"
                end try
                try
                    set evStart to (start date of e) as text
                on error
                    set evStart to ""
                end try
                try
                    set evEnd to (end date of e) as text
                on error
                    set evEnd to ""
                end try
                set end of outLines to evStart & fs & evEnd & fs & evTitle & fs & calName
            end repeat
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#,
        days = days,
    );

    let raw = run_osascript(&script).await?;
    if raw.trim().is_empty() {
        return Ok(if days == 0 {
            "No events today.".to_string()
        } else {
            format!("No events in the next {} days.", days)
        });
    }

    let mut rows: Vec<(String, String, String, String)> = raw
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
            Some((
                parts[0].to_string(),
                parts[1].to_string(),
                parts[2].to_string(),
                parts[3].to_string(),
            ))
        })
        .collect();

    // Best-effort chronological sort by start string. AppleScript renders
    // dates in the user's locale so lexical order isn't reliable across
    // locales — we fall back to the AppleScript-insertion order by using
    // a stable sort keyed on the extracted time portion when we can.
    rows.sort_by(|a, b| extract_time_key(&a.0).cmp(&extract_time_key(&b.0)));

    let mut out = String::new();
    for (i, (start, end, title, calname)) in rows.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let start_hm = extract_hhmm(start);
        let end_hm = extract_hhmm(end);
        out.push_str(&format!(
            "{start_hm} – {end_hm} {title} ({calname})",
            start_hm = start_hm,
            end_hm = end_hm,
            title = title,
            calname = calname,
        ));
    }
    Ok(out)
}

/// Extract `HH:MM` from an AppleScript-rendered date like
/// "Saturday, April 18, 2026 at 2:30:00 PM" or "2026-04-18 14:30:00".
/// Falls back to the full trimmed string if nothing looks like a clock.
fn extract_hhmm(as_date: &str) -> String {
    // AppleScript AM/PM form: "… at 2:30:00 PM"
    if let Some(idx) = as_date.rfind(" at ") {
        let tail = &as_date[idx + 4..];
        if let Some(hm) = parse_clock(tail) {
            return hm;
        }
    }
    if let Some(hm) = parse_clock(as_date) {
        return hm;
    }
    as_date.trim().to_string()
}

fn parse_clock(s: &str) -> Option<String> {
    // Find first digit run followed by ':'.
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            // Scan forward "H(H):MM".
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] != b':' {
                continue;
            }
            let hour_str = &s[start..i];
            i += 1;
            let min_start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i - min_start < 2 {
                continue;
            }
            let min_str = &s[min_start..min_start + 2];
            let mut hour: u32 = hour_str.parse().ok()?;
            // Detect trailing AM/PM to convert to 24-hour.
            let rest = &s[i..];
            let upper = rest.to_ascii_uppercase();
            if upper.contains("PM") && hour < 12 {
                hour += 12;
            } else if upper.contains("AM") && hour == 12 {
                hour = 0;
            }
            return Some(format!("{hour:02}:{min_str}"));
        }
        i += 1;
    }
    None
}

fn extract_time_key(as_date: &str) -> String {
    extract_hhmm(as_date)
}

/// Create a calendar event. `start` and `end` are ISO-8601 timestamps
/// ("YYYY-MM-DDTHH:MM:SS"), `calendar` defaults to "Calendar" per the
/// module spec.
///
/// Renamed to `tool_calendar_create_event` (from `calendar_create_event`)
/// to resolve collision with the pre-existing `commands::calendar_create_event`
/// Tauri command. Both register into the invoke handler under distinct names.
#[tauri::command]
pub async fn tool_calendar_create_event(
    title: String,
    start: String,
    end: String,
    calendar: Option<String>,
    notes: Option<String>,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("calendar_create_event: `title` is empty".to_string());
    }
    let cal_name = calendar
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Calendar");

    let start_as = iso_to_applescript_date(&start)
        .ok_or_else(|| format!("calendar_create_event: invalid ISO start `{start}`"))?;
    let end_as = iso_to_applescript_date(&end)
        .ok_or_else(|| format!("calendar_create_event: invalid ISO end `{end}`"))?;

    let title_expr = as_string_expr(&title);
    let notes_prop = match notes.as_deref() {
        Some(n) if !n.is_empty() => format!(", description:{}", as_string_expr(n)),
        _ => String::new(),
    };

    let script = format!(
        r#"tell application "Calendar"
    tell calendar "{cal}"
        set newEv to make new event with properties {{summary:{title_expr}, start date:(date "{start}"), end date:(date "{end}"){notes_prop}}}
        return (uid of newEv) as text
    end tell
end tell
"#,
        cal = escape_as(cal_name),
        title_expr = title_expr,
        start = start_as,
        end = end_as,
        notes_prop = notes_prop,
    );

    let uid = run_osascript(&script).await?;
    Ok(format!(
        "Event \"{title}\" created in {cal_name} ({start_as} → {end_as}) [uid {}]",
        uid.trim()
    ))
}

// ---------------------------------------------------------------------------
// Notes — PARKED (not yet registered in lib.rs invoke_handler).
// `notes_app_create` in notes_app.rs is the currently-wired creator;
// this is a lighter-weight alt kept around for the agent-tool bridge.
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(dead_code)]
pub async fn notes_create(
    title: String,
    body: String,
    folder: Option<String>,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("notes_create: `title` is empty".to_string());
    }

    // Notes.app expects the full HTML body; we build it from plain text by
    // escaping minimally and using <br> for newlines so line breaks survive.
    let html = plain_to_notes_html(&title, &body);
    let html_expr = as_string_expr(&html);

    let script = match folder.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => format!(
            r#"tell application "Notes"
    set targetFolder to missing value
    repeat with fld in folders
        if (name of fld) as text is "{fname}" then
            set targetFolder to fld
            exit repeat
        end if
    end repeat
    if targetFolder is missing value then
        set targetFolder to make new folder with properties {{name:"{fname}"}}
    end if
    set newNote to make new note at targetFolder with properties {{body:{html_expr}}}
    return (id of newNote) as text
end tell
"#,
            fname = escape_as(f),
            html_expr = html_expr,
        ),
        None => format!(
            r#"tell application "Notes"
    set newNote to make new note with properties {{body:{html_expr}}}
    return (id of newNote) as text
end tell
"#,
            html_expr = html_expr,
        ),
    };

    let id = run_osascript(&script).await?;
    Ok(format!("Note \"{title}\" created [{}]", id.trim()))
}

#[allow(dead_code)]
fn plain_to_notes_html(title: &str, body: &str) -> String {
    let mut out = String::new();
    out.push_str("<h1>");
    out.push_str(&html_escape(title));
    out.push_str("</h1>");
    if !body.is_empty() {
        out.push_str("<div>");
        let escaped = html_escape(body).replace('\n', "<br>");
        out.push_str(&escaped);
        out.push_str("</div>");
    }
    out
}

#[allow(dead_code)]
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[tauri::command]
pub async fn notes_search(query: String, limit: Option<u32>) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("notes_search: `query` is empty".to_string());
    }
    let cap = limit.unwrap_or(20).clamp(1, 500) as usize;
    let rs: char = '\u{1f}';

    let script = format!(
        r#"set rs to (ASCII character 31)
set outLines to {{}}
tell application "Notes"
    set matches to (every note whose name contains "{q}")
    repeat with n in matches
        try
            set end of outLines to (name of n) as text
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#,
        q = escape_as(query.trim()),
    );

    let raw = run_osascript(&script).await?;
    if raw.trim().is_empty() {
        return Ok(format!("No notes matching \"{}\".", query.trim()));
    }
    let titles: Vec<&str> = raw
        .split(rs)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(cap)
        .collect();
    if titles.is_empty() {
        return Ok(format!("No notes matching \"{}\".", query.trim()));
    }
    let mut out = String::new();
    for (i, t) in titles.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format!("{}. {}", i + 1, t));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// iMessage
// ---------------------------------------------------------------------------

/// Send a message through Messages.app. The existing `messaging.rs` exposes
/// this as `messaging_send_imessage`; this is the tool-module alias with
/// the voice-flow-friendly name agents can address directly.
#[tauri::command]
pub async fn imessage_send(recipient: String, body: String) -> Result<String, String> {
    let to = recipient.trim();
    if to.is_empty() {
        return Err("imessage_send: `recipient` is empty".to_string());
    }
    if body.is_empty() {
        return Err("imessage_send: `body` is empty".to_string());
    }

    let to_expr = format!("\"{}\"", escape_as(to));
    let body_expr = as_string_expr(&body);

    let script = format!(
        r#"tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy {to_expr} of targetService
    send {body_expr} to targetBuddy
end tell
return "sent"
"#,
        to_expr = to_expr,
        body_expr = body_expr,
    );

    run_osascript(&script).await?;
    Ok(format!("iMessage sent to {to}"))
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn reminders_add(
    title: String,
    due: Option<String>,
    list: Option<String>,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("reminders_add: `title` is empty".to_string());
    }

    let title_expr = as_string_expr(&title);
    let due_prop = match due.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => {
            let as_date = iso_to_applescript_date(d)
                .ok_or_else(|| format!("reminders_add: invalid ISO `due` `{d}`"))?;
            format!(", due date:(date \"{}\")", as_date)
        }
        None => String::new(),
    };

    let script = match list.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(l) => format!(
            r#"tell application "Reminders"
    set targetList to missing value
    repeat with lst in lists
        if (name of lst) as text is "{lname}" then
            set targetList to lst
            exit repeat
        end if
    end repeat
    if targetList is missing value then
        set targetList to make new list with properties {{name:"{lname}"}}
    end if
    set newRem to make new reminder at targetList with properties {{name:{title_expr}{due_prop}}}
    return (id of newRem) as text
end tell
"#,
            lname = escape_as(l),
            title_expr = title_expr,
            due_prop = due_prop,
        ),
        None => format!(
            r#"tell application "Reminders"
    set newRem to make new reminder with properties {{name:{title_expr}{due_prop}}}
    return (id of newRem) as text
end tell
"#,
            title_expr = title_expr,
            due_prop = due_prop,
        ),
    };

    let id = run_osascript(&script).await?;
    let list_name = list.as_deref().unwrap_or("default list");
    Ok(format!(
        "Reminder \"{title}\" added to {list_name} [{}]",
        id.trim()
    ))
}

#[tauri::command]
pub async fn reminders_today() -> Result<String, String> {
    let rs: char = '\u{1f}';
    let fs: char = '\u{1e}';

    let script = r#"set rs to (ASCII character 31)
set fs to (ASCII character 30)
set startOfDay to (current date)
set hours of startOfDay to 0
set minutes of startOfDay to 0
set seconds of startOfDay to 0
set endOfDay to startOfDay + 1 * days
set outLines to {}
tell application "Reminders"
    repeat with lst in lists
        try
            set lname to (name of lst) as text
            set items to (every reminder of lst whose completed is false)
            repeat with r in items
                try
                    set rname to (name of r) as text
                on error
                    set rname to "(untitled)"
                end try
                set rdue to ""
                try
                    if (due date of r) is not missing value then
                        if (due date of r) >= startOfDay and (due date of r) < endOfDay then
                            set rdue to (due date of r) as text
                            set end of outLines to rname & fs & rdue & fs & lname
                        end if
                    end if
                end try
            end repeat
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#;

    let raw = run_osascript(script).await?;
    if raw.trim().is_empty() {
        return Ok("No reminders due today.".to_string());
    }
    let rows: Vec<(String, String, String)> = raw
        .split(rs)
        .filter_map(|row| {
            let row = row.trim_matches('\n');
            if row.is_empty() {
                return None;
            }
            let parts: Vec<&str> = row.split(fs).collect();
            if parts.len() < 3 {
                return None;
            }
            Some((
                parts[0].to_string(),
                parts[1].to_string(),
                parts[2].to_string(),
            ))
        })
        .collect();
    if rows.is_empty() {
        return Ok("No reminders due today.".to_string());
    }
    let mut out = String::new();
    for (i, (name, due, list)) in rows.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let when = extract_hhmm(due);
        out.push_str(&format!(
            "{n}. {name} — {when} ({list})",
            n = i + 1,
            name = name,
            when = when,
            list = list,
        ));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Apps + Shortcuts
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn app_launch(name: String) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("app_launch: `name` is empty".to_string());
    }
    let script = format!(
        r#"tell application "{name}" to activate
"#,
        name = escape_as(n),
    );
    run_osascript(&script).await?;
    Ok(format!("Activated {n}"))
}

#[tauri::command]
pub async fn app_quit(name: String) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("app_quit: `name` is empty".to_string());
    }
    let script = format!(
        r#"tell application "{name}" to quit
"#,
        name = escape_as(n),
    );
    run_osascript(&script).await?;
    Ok(format!("Quit {n}"))
}

/// Run a macOS Shortcut by name. We prefer the `shortcuts` CLI (ships with
/// macOS Monterey+) because it supports structured input via stdin, which
/// dodges AppleScript's clunky input-property form. When `input` is
/// provided, we pipe it to the CLI on stdin and let the shortcut consume
/// it as "Shortcut Input".
#[tauri::command]
pub async fn shortcut_run(name: String, input: Option<String>) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("shortcut_run: `name` is empty".to_string());
    }

    // Prefer the CLI when it's on PATH. Fall back to AppleScript so the
    // tool keeps working on locked-down machines where the binary was
    // removed — admittedly rare.
    let cli_ok = Command::new("which")
        .arg("shortcuts")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if cli_ok {
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
            .map_err(|e| format!("shortcuts spawn failed: {e}"))?;

        if let (Some(mut stdin), Some(body)) = (child.stdin.take(), input.as_deref()) {
            stdin
                .write_all(body.as_bytes())
                .await
                .map_err(|e| format!("shortcuts stdin write failed: {e}"))?;
        }

        let output = match timeout(OSA_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(format!("shortcuts wait failed: {e}")),
            Err(_) => {
                return Err(format!(
                    "shortcut `{n}` timed out after {}s",
                    OSA_TIMEOUT.as_secs()
                ))
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("shortcut `{n}` exited with {}", output.status)
            } else {
                format!("shortcut `{n}`: {stderr}")
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if stdout.is_empty() {
            format!("Shortcut `{n}` ran.")
        } else {
            stdout
        });
    }

    // AppleScript fallback — no input plumbing available cheaply.
    let script = format!(
        r#"tell application "Shortcuts Events"
    run shortcut named "{name}"
end tell
return "ran"
"#,
        name = escape_as(n),
    );
    run_osascript(&script).await?;
    Ok(format!("Shortcut `{n}` ran (AppleScript fallback)."))
}

#[tauri::command]
pub async fn finder_reveal(path: String) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("finder_reveal: `path` is empty".to_string());
    }

    // `open -R <path>` highlights the file in its parent Finder window and
    // respects permission prompts identically to AppleScript's `reveal`
    // verb, without requiring the Finder automation entitlement.
    let output = Command::new("open")
        .arg("-R")
        .arg(p)
        .output()
        .await
        .map_err(|e| format!("open spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("open -R exited with {}", output.status)
        } else {
            format!("open -R: {stderr}")
        });
    }
    Ok(format!("Revealed {p} in Finder"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_as_handles_backslash_and_quote() {
        assert_eq!(escape_as("hello"), "hello");
        assert_eq!(escape_as("say \"hi\""), "say \\\"hi\\\"");
        assert_eq!(escape_as("back\\slash"), "back\\\\slash");
        assert_eq!(escape_as("tab\there"), "tab\\there");
    }

    #[test]
    fn as_string_expr_single_line_is_plain_literal() {
        assert_eq!(as_string_expr("hello"), "\"hello\"");
        assert_eq!(as_string_expr("she said \"hi\""), "\"she said \\\"hi\\\"\"");
    }

    #[test]
    fn as_string_expr_splices_return_for_multiline() {
        let got = as_string_expr("line1\nline2");
        assert_eq!(got, "\"line1\" & return & \"line2\"");

        // CRLF should collapse to single `return` splices, not produce
        // stray empty fragments.
        let crlf = as_string_expr("a\r\nb\r\nc");
        assert_eq!(crlf, "\"a\" & return & \"b\" & return & \"c\"");
    }

    #[test]
    fn iso_to_applescript_date_normalises_forms() {
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30:00"),
            Some("2026-04-18 14:30:00".to_string())
        );
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30:00Z"),
            Some("2026-04-18 14:30:00".to_string())
        );
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30"),
            Some("2026-04-18 14:30:00".to_string())
        );
        assert_eq!(
            iso_to_applescript_date("2026-04-18"),
            Some("2026-04-18 00:00:00".to_string())
        );
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30:00-07:00"),
            Some("2026-04-18 14:30:00".to_string())
        );
        assert_eq!(iso_to_applescript_date("garbage"), None);
        assert_eq!(iso_to_applescript_date(""), None);
    }

    #[test]
    fn parse_clock_handles_am_pm_and_24h() {
        assert_eq!(parse_clock("2:30:00 PM"), Some("14:30".to_string()));
        assert_eq!(parse_clock("12:05:00 AM"), Some("00:05".to_string()));
        assert_eq!(parse_clock("12:05:00 PM"), Some("12:05".to_string()));
        assert_eq!(parse_clock("14:30:00"), Some("14:30".to_string()));
        assert_eq!(parse_clock("no time here"), None);
    }

    #[test]
    fn extract_hhmm_finds_time_inside_applescript_date_text() {
        assert_eq!(
            extract_hhmm("Saturday, April 18, 2026 at 2:30:00 PM"),
            "14:30"
        );
        assert_eq!(extract_hhmm("2026-04-18 09:05:00"), "09:05");
    }

    #[test]
    fn plain_to_notes_html_escapes_html_specials() {
        let html = plain_to_notes_html("A <b>title</b>", "line1 & line2\nline3");
        assert!(html.contains("<h1>A &lt;b&gt;title&lt;/b&gt;</h1>"));
        assert!(html.contains("line1 &amp; line2<br>line3"));
    }
}

