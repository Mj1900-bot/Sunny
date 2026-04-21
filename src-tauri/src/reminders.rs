//! macOS Reminders.app bridge via AppleScript.
//!
//! We drive `osascript` with short, carefully-escaped scripts that emit
//! `|`-delimited records, one reminder per line. Five fields per line:
//!
//! ```text
//!     <id>|<title>|<notes>|<completed: "true"|"false">|<due date>
//! ```
//!
//! AppleScript returns localized date strings — e.g.
//! `"date Thursday, 17 April 2026 at 10:00:00"` — which are user-locale
//! dependent and awkward to parse reliably. We therefore surface them
//! as opaque strings for the UI layer; `missing value` and empty strings
//! collapse to `None`. Creation accepts ISO 8601 and we convert to the
//! AppleScript `date "<string>"` form (locale-agnostic enough on modern
//! macOS, which accepts `"YYYY-MM-DD HH:MM:SS"`).
//!
//! Permission UX: first call on a cold system triggers the TCC prompt.
//! If the user declines (or we're run before grant), osascript returns
//! error -1743 / "not allowed assistive access" or "not allowed to send
//! Apple events". We detect that text and return an instructional message.
//!
//! Every `osascript` invocation is guarded by a 6-second timeout and
//! receives the fat PATH so a Homebrew `osascript` shim (rare) is found.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(6);
const LIST_SENTINEL_DEFAULT: &str = "DEFAULT";
const PERMISSION_HINT: &str =
    "Reminders access required \u{2014} System Settings \u{2192} Privacy & Security \u{2192} Reminders \u{2192} add Sunny";

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub list: String,
    pub completed: bool,
    pub due: Option<String>,     // ISO 8601 or localized AppleScript date string
    pub created: Option<String>, // ISO 8601
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Escape a string for safe embedding inside an AppleScript double-quoted
/// literal. Order matters — backslashes first, then the double quote itself.
fn safe_quote(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Map osascript stderr/stdout into a user-actionable error.
fn classify_error(raw: &str) -> String {
    let lowered = raw.to_ascii_lowercase();
    if lowered.contains("not allowed") || lowered.contains("-1743") || lowered.contains("-1728") {
        return PERMISSION_HINT.to_string();
    }
    raw.trim().to_string()
}

/// Run an osascript with a timeout, returning stdout as a string on success.
async fn run_osascript(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg(script).kill_on_drop(true);
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }

    let fut = cmd.output();
    let out = match timeout(OSASCRIPT_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript spawn failed: {e}")),
        Err(_) => return Err("osascript timed out after 6s".to_string()),
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(classify_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Parse one `|`-delimited reminder record emitted by the listing script.
///
/// Fields, in order:
///   id | title | notes | completed | due
///
/// Edge cases handled:
///   - Empty / `missing value` due date → `None`.
///   - An embedded `|` inside user text is escaped to `\|` by the producer
///     script; we unescape on the way out. If a producer ever emits an
///     unescaped `|` (legacy data), we err on the side of joining extra
///     fields back into the trailing column rather than dropping data.
///   - Completed column treats anything other than the literal "true"
///     (case-insensitive) as false.
fn parse_reminder_line(line: &str, list_name: &str) -> Option<Reminder> {
    if line.trim().is_empty() {
        return None;
    }

    // Split on unescaped `|`. We walk the string tracking a preceding `\`.
    let mut parts: Vec<String> = Vec::with_capacity(5);
    let mut cur = String::new();
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            // Preserve the escaped char verbatim (unescaping `\|` → `|`).
            cur.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '|' {
            parts.push(std::mem::take(&mut cur));
            continue;
        }
        cur.push(ch);
    }
    parts.push(cur);

    if parts.len() < 4 {
        return None;
    }

    // If producer emitted extra unescaped `|`, fold them back into the
    // "due" slot (last column) to avoid data loss.
    while parts.len() > 5 {
        let tail = parts.pop().unwrap_or_default();
        if let Some(last) = parts.last_mut() {
            last.push('|');
            last.push_str(&tail);
        }
    }

    let id = parts.first().cloned().unwrap_or_default();
    let title = parts.get(1).cloned().unwrap_or_default();
    let notes = parts.get(2).cloned().unwrap_or_default();
    let completed_raw = parts.get(3).cloned().unwrap_or_default();
    let due_raw = parts.get(4).cloned().unwrap_or_default();

    let completed = completed_raw.trim().eq_ignore_ascii_case("true");
    let due = normalize_date(&due_raw);

    Some(Reminder {
        id,
        title,
        notes,
        list: list_name.to_string(),
        completed,
        due,
        created: None,
    })
}

/// AppleScript emits either `"missing value"` or an empty string for absent
/// dates, or a localized string like
/// `"date Thursday, 17 April 2026 at 10:00:00"`. We pass localized strings
/// through unchanged (documented UI contract) and only collapse absent
/// values to `None`.
fn normalize_date(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("missing value") {
        return None;
    }
    Some(trimmed.to_string())
}

/// Convert an ISO 8601 due date into the AppleScript form
/// `date "YYYY-MM-DD HH:MM:SS"`. On parse failure we fall back to the
/// raw input so the user gets a useful AppleScript error instead of a
/// silent drop.
fn iso_to_applescript_date(iso: &str) -> String {
    // `chrono` is already a dep; accept RFC3339 / ISO 8601 forms.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S") {
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    iso.to_string()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List reminder lists by name.
pub async fn list_reminder_lists() -> Result<Vec<String>, String> {
    let script = r#"
        tell application "Reminders"
            set out to ""
            repeat with l in lists
                set out to out & (name of l) & linefeed
            end repeat
            return out
        end tell
    "#;
    let stdout = run_osascript(script).await?;
    Ok(stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// List reminders in a specific list (or the default list). If
/// `include_completed` is false, only incomplete reminders are returned.
/// `limit` caps the result count.
pub async fn list_reminders(
    list_name: Option<String>,
    include_completed: bool,
    limit: Option<usize>,
) -> Result<Vec<Reminder>, String> {
    let raw_name = list_name
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| LIST_SENTINEL_DEFAULT.to_string());
    let safe_name = safe_quote(&raw_name);

    // Producer-side escaping: any `|` in titles/notes gets `\|` so our
    // parser can round-trip. `linefeed` is our record separator.
    let script = format!(
        r#"
        tell application "Reminders"
            set out to ""
            set targetList to missing value
            if "{safe_name}" is "{sentinel}" then
                set targetList to default list
            else
                set targetList to list "{safe_name}"
            end if
            set listTitle to name of targetList
            repeat with r in reminders of targetList
                set rid to id of r
                set rname to name of r
                set rbody to body of r
                if rbody is missing value then set rbody to ""
                set rcomp to (completed of r) as text
                set rdue to due date of r
                if rdue is missing value then
                    set rdueText to ""
                else
                    set rdueText to rdue as text
                end if
                -- Escape `|` in user-controlled fields.
                set AppleScript's text item delimiters to "|"
                set nameParts to text items of rname
                set AppleScript's text item delimiters to "\\|"
                set rname to nameParts as text
                set AppleScript's text item delimiters to "|"
                set bodyParts to text items of rbody
                set AppleScript's text item delimiters to "\\|"
                set rbody to bodyParts as text
                set AppleScript's text item delimiters to ""
                set out to out & rid & "|" & rname & "|" & rbody & "|" & rcomp & "|" & rdueText & linefeed
            end repeat
            return out
        end tell
        "#,
        safe_name = safe_name,
        sentinel = LIST_SENTINEL_DEFAULT,
    );

    let stdout = run_osascript(&script).await?;

    // Re-derive the effective list name for display; we asked AppleScript
    // to resolve "DEFAULT" so the user sees the real name in the UI.
    let effective_list = if raw_name == LIST_SENTINEL_DEFAULT {
        resolve_default_list_name().await.unwrap_or_default()
    } else {
        raw_name.clone()
    };

    let mut out: Vec<Reminder> = stdout
        .lines()
        .filter_map(|line| parse_reminder_line(line, &effective_list))
        .filter(|r| include_completed || !r.completed)
        .collect();

    if let Some(n) = limit {
        out.truncate(n);
    }
    Ok(out)
}

async fn resolve_default_list_name() -> Result<String, String> {
    let script = r#"
        tell application "Reminders"
            return name of default list
        end tell
    "#;
    Ok(run_osascript(script).await?.trim().to_string())
}

/// Create a reminder. `due_iso` accepts an ISO 8601 / RFC 3339 timestamp.
pub async fn create_reminder(
    title: String,
    notes: Option<String>,
    list_name: Option<String>,
    due_iso: Option<String>,
) -> Result<Reminder, String> {
    if title.trim().is_empty() {
        return Err("title cannot be empty".to_string());
    }

    let safe_title = safe_quote(&title);
    let safe_notes = safe_quote(notes.as_deref().unwrap_or(""));
    let target_list = list_name
        .as_deref()
        .unwrap_or(LIST_SENTINEL_DEFAULT)
        .to_string();
    let safe_list = safe_quote(&target_list);

    // AppleScript builder — optional `due date` clause.
    let due_clause = match due_iso.as_deref() {
        Some(iso) if !iso.trim().is_empty() => {
            let as_date = iso_to_applescript_date(iso);
            format!(", due date:date \"{}\"", safe_quote(&as_date))
        }
        _ => String::new(),
    };

    let script = format!(
        r#"
        tell application "Reminders"
            set targetList to missing value
            if "{safe_list}" is "{sentinel}" then
                set targetList to default list
            else
                set targetList to list "{safe_list}"
            end if
            set newRem to make new reminder at end of reminders of targetList with properties {{name:"{safe_title}", body:"{safe_notes}"{due_clause}}}
            set rdue to due date of newRem
            if rdue is missing value then
                set rdueText to ""
            else
                set rdueText to rdue as text
            end if
            return (id of newRem) & "|" & (name of newRem) & "|" & (body of newRem) & "|" & ((completed of newRem) as text) & "|" & rdueText
        end tell
        "#,
        safe_list = safe_list,
        sentinel = LIST_SENTINEL_DEFAULT,
        safe_title = safe_title,
        safe_notes = safe_notes,
        due_clause = due_clause,
    );

    let stdout = run_osascript(&script).await?;
    let line = stdout.lines().next().unwrap_or("").trim();
    let list_display = if target_list == LIST_SENTINEL_DEFAULT {
        resolve_default_list_name().await.unwrap_or_default()
    } else {
        target_list
    };
    parse_reminder_line(line, &list_display)
        .ok_or_else(|| format!("could not parse created reminder response: {line:?}"))
}

/// Mark a reminder complete by its AppleScript id.
pub async fn complete_reminder(id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("id cannot be empty".to_string());
    }
    let safe_id = safe_quote(&id);
    let script = format!(
        r#"
        tell application "Reminders"
            set target to first reminder whose id is "{safe_id}"
            set completed of target to true
        end tell
        "#,
        safe_id = safe_id
    );
    run_osascript(&script).await.map(|_| ())
}

/// Delete a reminder by its AppleScript id.
pub async fn delete_reminder(id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("id cannot be empty".to_string());
    }
    let safe_id = safe_quote(&id);
    let script = format!(
        r#"
        tell application "Reminders"
            set target to first reminder whose id is "{safe_id}"
            delete target
        end tell
        "#,
        safe_id = safe_id
    );
    run_osascript(&script).await.map(|_| ())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_happy_path() {
        let line = "x-apple-reminderkit://REMCDReminder/ABC123|Buy milk|2L organic|false|date Thursday, 17 April 2026 at 10:00:00";
        let r = parse_reminder_line(line, "Groceries").expect("parse");
        assert_eq!(r.id, "x-apple-reminderkit://REMCDReminder/ABC123");
        assert_eq!(r.title, "Buy milk");
        assert_eq!(r.notes, "2L organic");
        assert_eq!(r.list, "Groceries");
        assert!(!r.completed);
        assert_eq!(
            r.due.as_deref(),
            Some("date Thursday, 17 April 2026 at 10:00:00")
        );
    }

    #[test]
    fn parse_escaped_pipes_in_body() {
        // The producer AppleScript escapes `|` in user text as `\|`.
        // Parser must unescape them and NOT treat them as column separators.
        let line = r"ID1|a\|b|note with \| pipe|true|";
        let r = parse_reminder_line(line, "Work").expect("parse");
        assert_eq!(r.id, "ID1");
        assert_eq!(r.title, "a|b");
        assert_eq!(r.notes, "note with | pipe");
        assert!(r.completed);
        assert_eq!(r.due, None);
    }

    #[test]
    fn parse_empty_body_and_empty_due() {
        let line = "ID2|Title only||false|";
        let r = parse_reminder_line(line, "Inbox").expect("parse");
        assert_eq!(r.id, "ID2");
        assert_eq!(r.title, "Title only");
        assert_eq!(r.notes, "");
        assert!(!r.completed);
        assert_eq!(r.due, None);
    }

    #[test]
    fn parse_missing_due_collapses_to_none() {
        // Exactly the string AppleScript emits when the due field is absent
        // and we didn't catch it in the producer.
        let line = "ID3|Task|Some note|false|missing value";
        let r = parse_reminder_line(line, "Home").expect("parse");
        assert_eq!(r.id, "ID3");
        assert_eq!(r.title, "Task");
        assert_eq!(r.notes, "Some note");
        assert!(!r.completed);
        assert_eq!(r.due, None);
    }
}

// === REGISTER IN lib.rs ===
// mod reminders;
// #[tauri::command] async fn reminders_list(list_name: Option<String>, include_completed: Option<bool>, limit: Option<usize>) -> Result<Vec<reminders::Reminder>, String> { reminders::list_reminders(list_name, include_completed.unwrap_or(false), limit).await }
// #[tauri::command] async fn reminders_lists() -> Result<Vec<String>, String> { reminders::list_reminder_lists().await }
// #[tauri::command] async fn reminders_create(title: String, notes: Option<String>, list_name: Option<String>, due_iso: Option<String>) -> Result<reminders::Reminder, String> { reminders::create_reminder(title, notes, list_name, due_iso).await }
// #[tauri::command] async fn reminders_complete(id: String) -> Result<(), String> { reminders::complete_reminder(id).await }
// #[tauri::command] async fn reminders_delete(id: String) -> Result<(), String> { reminders::delete_reminder(id).await }
// invoke_handler: reminders_list, reminders_lists, reminders_create, reminders_complete, reminders_delete
// No new deps.
// === END REGISTER ===
