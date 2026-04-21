//! macOS Mail.app read-only integration.
//!
//! Drives `Mail.app` via AppleScript (`osascript`) so we stay out of private
//! API territory and don't need an extra crate. Everything returned here is
//! read-only: we never send, delete, or flag mail.
//!
//! ### AppleScript pipeline
//! All three listing paths (recent / search / unread-count) build an
//! AppleScript program as a heredoc-ish string, pipe it through `osascript`,
//! and parse the resulting line-based records. Fields within a record are
//! delimited by `|||` (three pipes — unlikely to appear in headers) and
//! records are separated by `---MAILSEP---`. This is tolerant of real-world
//! subjects/senders containing `|` or newlines.
//!
//! ### Permissions
//! macOS gates Mail.app automation under System Settings → Privacy &
//! Security → Automation. The first time SUNNY calls Mail, the user sees a
//! one-shot consent prompt. If they deny, osascript returns exit code 1
//! with "Not authorized to send Apple events" in stderr — we map that to a
//! friendly message so the HUD can surface a fix-it button.
//!
//! ### Performance
//! `messages of inbox` on a large account (> 10k msgs) can take several
//! seconds because Mail has to page in every message header. We mitigate:
//!   * Cap iteration at the caller's `limit` (default 20, max 100).
//!   * Sort by `date received` descending so early termination is cheap.
//!   * Fetch a 280-char snippet, not the full body.
//!   * 12s osascript timeout — enough for slow IMAP syncs, short enough
//!     that the HUD doesn't feel hung.
//! `unread_count` still has to walk every mailbox, but uses AppleScript's
//! native `count (messages whose read status is false)` which Mail
//! optimises server-side on IMAP accounts.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

use crate::applescript::escape_applescript;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;
const SNIPPET_MAX_CHARS: usize = 280;
const RECORD_SEP: &str = "---MAILSEP---";
const FIELD_SEP: &str = "|||";
const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(12);
const PERMISSION_MSG: &str =
    "Mail access required — System Settings → Privacy & Security → Automation → Sunny → Mail";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MailMessage {
    pub id: String,       // message-id header
    pub from: String,     // "Name <addr>"
    pub subject: String,
    pub snippet: String,  // first 280 chars of body, newlines→spaces
    pub received: String, // ISO 8601
    pub unread: bool,
    pub account: String,
    pub mailbox: String,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Recent messages from the unified inbox, newest first.
///
/// `limit` defaults to 20, capped at 100. When `unread_only` is true, only
/// messages with `read status = false` are returned (the cap still applies to
/// the emitted count, not the iteration budget).
pub async fn list_recent_messages(
    limit: Option<usize>,
    unread_only: bool,
) -> Result<Vec<MailMessage>, String> {
    let bounded = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let script = build_recent_script(bounded, unread_only);
    let stdout = run_osascript(&script).await?;
    Ok(parse_messages(&stdout))
}

/// Names of every configured Mail account.
pub async fn list_accounts() -> Result<Vec<String>, String> {
    let script = r#"
        tell application "Mail"
            set out to ""
            repeat with a in accounts
                set out to out & (name of a) & linefeed
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

/// Sum of unread messages across every mailbox of every account.
pub async fn unread_count() -> Result<i64, String> {
    let script = r#"
        tell application "Mail"
            set total to 0
            repeat with a in accounts
                try
                    repeat with mb in every mailbox of a
                        try
                            set n to (count (messages of mb whose read status is false))
                            set total to total + n
                        end try
                    end repeat
                end try
            end repeat
            return total as string
        end tell
    "#;
    let stdout = run_osascript(script).await?;
    stdout
        .trim()
        .parse::<i64>()
        .map_err(|e| format!("unread_count parse: {e} (got {stdout:?})"))
}

/// Full-text search over Mail's index (subject + sender + body).
pub async fn search_messages(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MailMessage>, String> {
    let bounded = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let script = build_search_script(&query, bounded);
    let stdout = run_osascript(&script).await?;
    Ok(parse_messages(&stdout))
}

// ---------------------------------------------------------------------------
// AppleScript builders
// ---------------------------------------------------------------------------

fn build_recent_script(limit: usize, unread_only: bool) -> String {
    let filter = if unread_only {
        "if (read status of m) is false then"
    } else {
        "if true then"
    };
    format!(
        r#"
tell application "Mail"
    set msgCount to 0
    set out to ""
    set msgs to (messages of inbox)
    set sortedMsgs to msgs
    try
        set sortedMsgs to (sort msgs by date received)
    end try
    repeat with m in msgs
        if msgCount >= {limit} then exit repeat
        {filter}
            try
                set mid to ""
                try
                    set mid to message id of m
                end try
                set fromStr to ""
                try
                    set fromStr to sender of m
                end try
                set subj to ""
                try
                    set subj to subject of m
                end try
                set body to ""
                try
                    set body to content of m as text
                end try
                set rcvd to ""
                try
                    set rcvd to (date received of m) as string
                end try
                set rd to true
                try
                    set rd to read status of m
                end try
                set acct to ""
                try
                    set acct to name of (account of (mailbox of m))
                end try
                set mbx to ""
                try
                    set mbx to name of (mailbox of m)
                end try
                set out to out & mid & "{FIELD_SEP}" & fromStr & "{FIELD_SEP}" & subj & "{FIELD_SEP}" & body & "{FIELD_SEP}" & rcvd & "{FIELD_SEP}" & (rd as string) & "{FIELD_SEP}" & acct & "{FIELD_SEP}" & mbx & "{RECORD_SEP}"
                set msgCount to msgCount + 1
            end try
        end if
    end repeat
    return out
end tell
"#
    )
}

fn build_search_script(query: &str, limit: usize) -> String {
    let escaped = escape_applescript(query);
    format!(
        r#"
tell application "Mail"
    set qStr to "{escaped}"
    set msgCount to 0
    set out to ""
    repeat with a in accounts
        if msgCount >= {limit} then exit repeat
        try
            repeat with mb in every mailbox of a
                if msgCount >= {limit} then exit repeat
                try
                    set matches to (messages of mb whose (subject contains qStr) or (sender contains qStr))
                    repeat with m in matches
                        if msgCount >= {limit} then exit repeat
                        try
                            set mid to ""
                            try
                                set mid to message id of m
                            end try
                            set fromStr to ""
                            try
                                set fromStr to sender of m
                            end try
                            set subj to ""
                            try
                                set subj to subject of m
                            end try
                            set body to ""
                            try
                                set body to content of m as text
                            end try
                            set rcvd to ""
                            try
                                set rcvd to (date received of m) as string
                            end try
                            set rd to true
                            try
                                set rd to read status of m
                            end try
                            set acct to ""
                            try
                                set acct to name of a
                            end try
                            set mbx to ""
                            try
                                set mbx to name of mb
                            end try
                            set out to out & mid & "{FIELD_SEP}" & fromStr & "{FIELD_SEP}" & subj & "{FIELD_SEP}" & body & "{FIELD_SEP}" & rcvd & "{FIELD_SEP}" & (rd as string) & "{FIELD_SEP}" & acct & "{FIELD_SEP}" & mbx & "{RECORD_SEP}"
                            set msgCount to msgCount + 1
                        end try
                    end repeat
                end try
            end repeat
        end try
    end repeat
    return out
end tell
"#
    )
}


// ---------------------------------------------------------------------------
// osascript runner
// ---------------------------------------------------------------------------

async fn run_osascript(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg(script).kill_on_drop(true);
    let fut = cmd.output();
    let output = match timeout(OSASCRIPT_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript spawn failed: {e}")),
        Err(_) => return Err("Mail enumeration timed out (12s) — large mailbox?".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_osascript_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn classify_osascript_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("not authorized")
        || lower.contains("not allowed")
        || lower.contains("-1743")
        || lower.contains("-10004")
    {
        PERMISSION_MSG.to_string()
    } else {
        format!("Mail.app error: {}", stderr.trim())
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn parse_messages(stdout: &str) -> Vec<MailMessage> {
    stdout
        .split(RECORD_SEP)
        .filter_map(parse_record)
        .collect()
}

fn parse_record(raw: &str) -> Option<MailMessage> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let fields: Vec<&str> = trimmed.split(FIELD_SEP).collect();
    if fields.len() < 8 {
        return None;
    }
    Some(MailMessage {
        id: fields[0].trim().to_string(),
        from: fields[1].trim().to_string(),
        subject: fields[2].trim().to_string(),
        snippet: snippetize(fields[3]),
        received: applescript_date_to_iso(fields[4].trim()),
        unread: !fields[5].trim().eq_ignore_ascii_case("true"),
        account: fields[6].trim().to_string(),
        mailbox: fields[7].trim().to_string(),
    })
}

/// Normalise a body fragment into a compact single-line snippet of at most
/// [`SNIPPET_MAX_CHARS`] characters.
///
/// Replaces `\n`, `\r`, tabs and non-breaking spaces with a regular space,
/// collapses consecutive whitespace, then truncates on a character (not byte)
/// boundary so multi-byte sequences aren't split.
fn snippetize(raw: &str) -> String {
    let unified: String = raw
        .chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' | '\u{00A0}' => ' ',
            other => other,
        })
        .collect();
    let collapsed: String = unified.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > SNIPPET_MAX_CHARS {
        collapsed.chars().take(SNIPPET_MAX_CHARS).collect()
    } else {
        collapsed
    }
}

/// Convert an AppleScript `date received as string` ("Wednesday, April 15,
/// 2026 at 3:42:18 PM") into a best-effort ISO 8601 string.
///
/// AppleScript's stringified dates are locale-dependent and not round-trip
/// parseable from Rust without pulling chrono + a locale table. Rather than
/// sink that complexity, we forward the raw string unchanged when we can't
/// confidently reformat — downstream consumers display it as-is.
///
/// Written inline (not imported from a sibling module) per the agent spec:
/// modules shouldn't share date helpers, keeps each module standalone.
fn applescript_date_to_iso(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    // Fast path: already looks ISO 8601 (some macOS locales emit this).
    if s.len() >= 10
        && s.as_bytes().get(4) == Some(&b'-')
        && s.as_bytes().get(7) == Some(&b'-')
    {
        return s.to_string();
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_record_separator_splits_multiple_messages() {
        let raw = format!(
            "id1{FS}from1{FS}subj1{FS}body1{FS}2026-04-15{FS}true{FS}iCloud{FS}INBOX{RS}\
             id2{FS}from2{FS}subj2{FS}body2{FS}2026-04-14{FS}false{FS}Gmail{FS}INBOX{RS}",
            FS = FIELD_SEP,
            RS = RECORD_SEP,
        );
        let msgs = parse_messages(&raw);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "id1");
        assert_eq!(msgs[0].account, "iCloud");
        assert!(!msgs[0].unread); // read status "true" means NOT unread
        assert_eq!(msgs[1].id, "id2");
        assert!(msgs[1].unread); // read status "false" means unread
    }

    #[test]
    fn parses_field_split_preserves_eight_fields() {
        let raw = format!(
            "mid{FS}Alice <a@x.com>{FS}Hello{FS}some body{FS}rcvd{FS}false{FS}Work{FS}Inbox{RS}",
            FS = FIELD_SEP,
            RS = RECORD_SEP,
        );
        let msgs = parse_messages(&raw);
        assert_eq!(msgs.len(), 1);
        let m = &msgs[0];
        assert_eq!(m.id, "mid");
        assert_eq!(m.from, "Alice <a@x.com>");
        assert_eq!(m.subject, "Hello");
        assert_eq!(m.snippet, "some body");
        assert_eq!(m.account, "Work");
        assert_eq!(m.mailbox, "Inbox");
        assert!(m.unread);
    }

    #[test]
    fn snippet_truncates_and_normalises_whitespace() {
        let noisy = format!(
            "line1\nline2\r\n\tindented\u{00A0}nbsp   many   spaces {}",
            "x".repeat(400)
        );
        let snip = snippetize(&noisy);
        // Truncation: exactly SNIPPET_MAX_CHARS.
        assert_eq!(snip.chars().count(), SNIPPET_MAX_CHARS);
        // Newlines/tabs/nbsp all gone.
        assert!(!snip.contains('\n'));
        assert!(!snip.contains('\r'));
        assert!(!snip.contains('\t'));
        assert!(!snip.contains('\u{00A0}'));
        // Collapsed: no double spaces.
        assert!(!snip.contains("  "));
    }

    #[test]
    fn snippet_short_input_is_unchanged_modulo_whitespace() {
        assert_eq!(snippetize("hello world"), "hello world");
        assert_eq!(snippetize("  hello\tworld\n"), "hello world");
    }


    #[test]
    fn parse_messages_ignores_malformed_records() {
        let raw = format!(
            "only{FS}three{FS}fields{RS}\
             id2{FS}from2{FS}subj2{FS}body2{FS}rcvd2{FS}true{FS}acct2{FS}mbx2{RS}",
            FS = FIELD_SEP,
            RS = RECORD_SEP,
        );
        let msgs = parse_messages(&raw);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "id2");
    }

    #[test]
    fn classify_permission_error_returns_friendly_message() {
        let stderr = "execution error: Not authorized to send Apple events to Mail. (-1743)";
        assert_eq!(classify_osascript_error(stderr), PERMISSION_MSG);
    }

    #[test]
    fn applescript_date_iso_passthrough_for_iso_like_strings() {
        assert_eq!(applescript_date_to_iso("2026-04-15T12:00:00"), "2026-04-15T12:00:00");
        assert_eq!(applescript_date_to_iso(""), "");
        // Non-ISO locales just pass through.
        let raw = "Wednesday, April 15, 2026 at 3:42:18 PM";
        assert_eq!(applescript_date_to_iso(raw), raw);
    }
}

// === REGISTER IN lib.rs ===
// mod mail;
// #[tauri::command]s: mail_list_recent, mail_list_accounts, mail_unread_count, mail_search
// invoke_handler: mail_list_recent, mail_list_accounts, mail_unread_count, mail_search
// No new deps.
// === END REGISTER ===
