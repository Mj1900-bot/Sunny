//! iMessage / SMS sender + chat listing.
//!
//! Sending is done through Messages.app via `osascript`. Listing chats reads
//! `~/Library/Messages/chat.db` with the macOS built-in `sqlite3` binary in
//! read-only mode (same pattern as `messages.rs` for contacts).
//!
//! # Permissions
//!
//! - **Send (osascript → Messages)**: triggers the Automation prompt the first
//!   time. If denied, `osascript` exits non-zero with stderr mentioning
//!   `-1743` / "not allowed" / "not authorized". We surface a descriptive hint
//!   pointing to System Settings → Privacy → Automation → Sunny → Messages.
//! - **List chats (sqlite3 chat.db)**: requires Full Disk Access. Same error
//!   handling as `messages.rs`.
//!
//! # Safety (IMPORTANT)
//!
//! Agent tools that invoke `send_imessage` / `send_sms` MUST be declared with
//! `dangerous=true` — these actually deliver messages to real recipients and
//! cannot be recalled. The orchestrator is responsible for wiring a
//! `ConfirmGate` preview that shows the full `to` + `body` text before the
//! underlying AppleScript is executed.
//!
//! # Escape strategy
//!
//! AppleScript string literals are delimited with double quotes and support
//! `\\` / `\"` as escape sequences. We defend against script injection by
//! replacing `\` → `\\`, `"` → `\"`, and collapsing bare `\r` / `\n` to
//! `\\n`-style escapes so a multi-line body is embedded as a single literal
//! rather than prematurely terminating the line. See `applescript_escape`.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(10);
const APPLE_EPOCH_OFFSET: i64 = 978_307_200;
const LAST_MESSAGE_TRUNCATE: usize = 140;

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChatSummary {
    pub id: String,
    pub display_name: String,
    pub participants: Vec<String>,
    pub last_message_preview: String,
    #[ts(type = "number")]
    pub last_message_ts: i64,
    pub unread: bool,
}

#[derive(Debug, Deserialize)]
struct RawChatRow {
    guid: Option<String>,
    display_name: Option<String>,
    participants: Option<String>,
    last_text: Option<String>,
    last_date: Option<i64>,
    unread_count: Option<i64>,
}

/// A single message row inside a conversation, rendered in UI order
/// (oldest → newest). `from_me` is `true` for messages the user sent.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationMessage {
    #[ts(type = "number")]
    pub rowid: i64,
    pub text: String,
    #[ts(type = "number")]
    pub ts: i64,
    pub from_me: bool,
    pub sender: Option<String>,
    pub is_imessage: bool,
    pub has_attachment: bool,
}

#[derive(Debug, Deserialize)]
struct RawConvRow {
    rowid: Option<i64>,
    text: Option<String>,
    /// Hex-encoded `attributedBody` BLOB — used when `text` is null (Ventura+).
    attributed_body_hex: Option<String>,
    date: Option<i64>,
    is_from_me: Option<i64>,
    sender_handle: Option<String>,
    service: Option<String>,
    has_attachment: Option<i64>,
}

// --------------------------------------------------------------------------
// Public API — send
// --------------------------------------------------------------------------

pub async fn send_imessage(to: String, body: String) -> Result<(), String> {
    send_via_service(&to, &body, "iMessage").await
}

pub async fn send_sms(to: String, body: String) -> Result<(), String> {
    // If the user doesn't have SMS relay linked (no paired iPhone with Text
    // Message Forwarding), the `1st service whose service type = SMS`
    // lookup inside Messages.app raises an error. We detect that class of
    // failure and surface a clear message instead of the raw AppleScript
    // stack trace.
    match send_via_service(&to, &body, "SMS").await {
        Ok(()) => Ok(()),
        Err(e) if looks_like_missing_service(&e) => Err(
            "SMS relay not available — this Mac is not linked to an iPhone with Text Message Forwarding enabled"
                .to_string(),
        ),
        Err(e) => Err(e),
    }
}

// --------------------------------------------------------------------------
// Public API — call (macOS URL-scheme bridges)
// --------------------------------------------------------------------------

/// Dial via iPhone continuity. Opens the `tel:` URL which FaceTime.app
/// resolves to a GSM call on the paired iPhone.
pub async fn call_phone(to: String) -> Result<(), String> {
    open_call_url("tel", &to).await
}

/// Place a FaceTime audio call.
pub async fn facetime_audio(to: String) -> Result<(), String> {
    open_call_url("facetime-audio", &to).await
}

/// Place a FaceTime video call.
pub async fn facetime_video(to: String) -> Result<(), String> {
    open_call_url("facetime", &to).await
}

async fn open_call_url(scheme: &str, raw_to: &str) -> Result<(), String> {
    let recipient = sanitize_recipient(raw_to);
    if recipient.is_empty() {
        return Err("call: recipient is empty after sanitization".to_string());
    }
    // Group chats have synthetic identifiers like `chat12345` — URL schemes
    // only work against a real handle (phone / email), so refuse early with a
    // clear message instead of spawning a call that silently no-ops.
    if recipient.starts_with("chat") && !recipient.contains('@') {
        return Err(
            "call: group chats cannot be dialed — call an individual participant".to_string(),
        );
    }
    let url = format!("{scheme}:{recipient}");
    let status = Command::new("open")
        .arg(&url)
        .status()
        .await
        .map_err(|e| format!("open {scheme}: {e}"))?;
    if !status.success() {
        return Err(format!("open {scheme} exited with status {status}"));
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Public API — list
// --------------------------------------------------------------------------

pub async fn list_chats(limit: Option<usize>) -> Result<Vec<ChatSummary>, String> {
    let bounded = limit.unwrap_or(50).clamp(1, 500);
    let db_path = home_messages_db()?;
    // LIMIT cannot be bound via the sqlite CLI one-shot form, so splice the
    // clamped literal. Safe: `bounded` is a usize we produced ourselves.
    let sql = CHAT_QUERY.replace("${LIMIT}", &bounded.to_string());

    let output = Command::new("sqlite3")
        .arg("-readonly")
        .arg("-cmd")
        .arg(".mode json")
        .arg(&db_path)
        .arg(&sql)
        .output()
        .await
        .map_err(|e| format!("sqlite3 spawn failed: {e}"))?;

    if !output.status.success() {
        return Err(classify_sqlite_error(&String::from_utf8_lossy(
            &output.stderr,
        )));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.to_lowercase().contains("unable to open database file") {
        return Err(classify_sqlite_error(&stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_chat_json(&stdout)
}

// --------------------------------------------------------------------------
// Public API — fetch conversation
// --------------------------------------------------------------------------

/// Return the last N messages of a single conversation, ordered oldest → newest
/// (i.e. reading order). `chat_identifier` is the value we returned as
/// `handle` from `messages::recent_contacts` — for 1:1 chats that's the peer's
/// phone / email, for group chats it's the synthetic `chat12345` id.
///
/// `max_rowid` is optional: if set, only messages with `message.ROWID > max_rowid`
/// are returned. Used by the proxy watcher to fetch only *new* messages since
/// its last tick, avoiding reprocessing.
pub async fn fetch_conversation(
    chat_identifier: String,
    limit: Option<usize>,
    since_rowid: Option<i64>,
) -> Result<Vec<ConversationMessage>, String> {
    if chat_identifier.trim().is_empty() {
        return Err("fetch_conversation: chat_identifier is empty".to_string());
    }
    let bounded = limit.unwrap_or(30).clamp(1, 500);
    let db_path = home_messages_db()?;

    // chat_identifier is user-provided but we defend against SQL injection by
    // requiring it match a strict allowlist (phone / email / chat-guid style).
    // Anything else is rejected before we splice into the SQL.
    if !is_safe_identifier(&chat_identifier) {
        return Err("fetch_conversation: unsupported chat identifier".to_string());
    }
    let since_clause = match since_rowid {
        Some(v) if v > 0 => format!(" AND m.ROWID > {v}"),
        _ => String::new(),
    };
    let sql = CONVERSATION_QUERY
        .replace("${IDENT}", &chat_identifier)
        .replace("${SINCE}", &since_clause)
        .replace("${LIMIT}", &bounded.to_string());

    let output = Command::new("sqlite3")
        .arg("-readonly")
        .arg("-cmd")
        .arg(".mode json")
        .arg(&db_path)
        .arg(&sql)
        .output()
        .await
        .map_err(|e| format!("sqlite3 spawn failed: {e}"))?;

    if !output.status.success() {
        return Err(classify_sqlite_error(&String::from_utf8_lossy(
            &output.stderr,
        )));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.to_lowercase().contains("unable to open database file") {
        return Err(classify_sqlite_error(&stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_conversation_json(&stdout)
}

// --------------------------------------------------------------------------
// Internals — send
// --------------------------------------------------------------------------

async fn send_via_service(to: &str, body: &str, service_type: &str) -> Result<(), String> {
    let recipient = sanitize_recipient(to);
    if recipient.is_empty() {
        return Err("send: recipient is empty after sanitization".to_string());
    }
    if body.is_empty() {
        return Err("send: body is empty".to_string());
    }

    let script = build_send_script(&recipient, body, service_type);
    run_osascript(&script).await.map(|_| ())
}

fn build_send_script(to: &str, body: &str, service_type: &str) -> String {
    let to_esc = applescript_escape(to);
    let body_esc = applescript_escape(body);
    // NB: `service_type` is hard-coded to "iMessage" or "SMS" inside this
    // module — not user-controlled — so it's embedded verbatim.
    format!(
        r#"tell application "Messages"
    set targetService to 1st service whose service type = {service_type}
    set targetBuddy to buddy "{to}" of targetService
    send "{body}" to targetBuddy
end tell"#,
        service_type = service_type,
        to = to_esc,
        body = body_esc,
    )
}

async fn run_osascript(script: &str) -> Result<String, String> {
    // kill_on_drop: prevents orphan osascript zombies when `timeout()` below
    // elapses and drops the wait future. See ax.rs for the full rationale.
    let fut = Command::new("osascript").arg("-e").arg(script).kill_on_drop(true).output();

    let result = match timeout(OSASCRIPT_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => {
            return Err(format!(
                "Messages osascript timed out after {}s",
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
    if lower.contains("-1743") || lower.contains("not allowed") || lower.contains("not authorized")
    {
        return "Messages access required — System Settings → Privacy → Automation → Sunny → Messages".to_string();
    }
    if lower.contains("can't get buddy") || lower.contains("can’t get buddy") {
        return "recipient not reachable — check the handle is a valid iMessage / SMS address".to_string();
    }
    format!("Messages osascript error: {}", stderr.trim())
}

fn looks_like_missing_service(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("can't get 1st service")
        || lower.contains("can’t get 1st service")
        || lower.contains("invalid index")
        || lower.contains("no service")
}

// --------------------------------------------------------------------------
// Internals — list (sqlite)
// --------------------------------------------------------------------------

const CHAT_QUERY: &str = r#"
SELECT
  c.guid AS guid,
  c.display_name AS display_name,
  (
    SELECT GROUP_CONCAT(h.id, ',')
    FROM chat_handle_join chj
    JOIN handle h ON h.ROWID = chj.handle_id
    WHERE chj.chat_id = c.ROWID
  ) AS participants,
  (
    SELECT text FROM message m2
    JOIN chat_message_join cmj2 ON cmj2.message_id = m2.ROWID
    WHERE cmj2.chat_id = c.ROWID
      AND m2.text IS NOT NULL AND TRIM(m2.text) <> ''
    ORDER BY m2.date DESC LIMIT 1
  ) AS last_text,
  (
    SELECT MAX(m3.date) FROM message m3
    JOIN chat_message_join cmj3 ON cmj3.message_id = m3.ROWID
    WHERE cmj3.chat_id = c.ROWID
  ) AS last_date,
  (
    SELECT COUNT(*) FROM message m4
    JOIN chat_message_join cmj4 ON cmj4.message_id = m4.ROWID
    WHERE cmj4.chat_id = c.ROWID
      AND m4.is_from_me = 0
      AND m4.is_read = 0
  ) AS unread_count
FROM chat c
ORDER BY last_date DESC
LIMIT ${LIMIT};
"#;

// The conversation query is ordered DESC + LIMIT at the SQL layer (so we only
// hydrate the last N rows) and re-sorted ASC in Rust for the caller.
//
// Modern Messages (macOS 13+) writes message text into `attributedBody` (a
// typedstream BLOB) and leaves `text` null. We return the BLOB as HEX so it
// survives `.mode json` cleanly — Rust decodes + extracts the text when the
// plain `text` column is empty.
const CONVERSATION_QUERY: &str = r#"
SELECT
  m.ROWID          AS rowid,
  m.text           AS text,
  HEX(m.attributedBody) AS attributed_body_hex,
  m.date           AS date,
  m.is_from_me     AS is_from_me,
  h.id             AS sender_handle,
  m.service        AS service,
  m.cache_has_attachments AS has_attachment
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE c.chat_identifier = '${IDENT}'
  ${SINCE}
ORDER BY m.date DESC
LIMIT ${LIMIT};
"#;

/// Allow phone (`+` / digits), email (`local@host.tld`), and Apple's synthetic
/// `chat…` identifiers. Rejects anything with quotes, semicolons, or
/// whitespace that would enable SQL injection after we splice into the query.
fn is_safe_identifier(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    s.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.' | '_' | '@' | ':')
    })
}

fn home_messages_db() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home
        .join("Library/Messages/chat.db")
        .to_string_lossy()
        .into_owned())
}

fn classify_sqlite_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("unable to open database file")
        || lower.contains("authorization denied")
        || lower.contains("operation not permitted")
    {
        "permission denied — grant Full Disk Access to Sunny in System Settings → Privacy"
            .to_string()
    } else {
        format!("sqlite3: {}", stderr.trim())
    }
}

fn parse_chat_json(stdout: &str) -> Result<Vec<ChatSummary>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawChatRow> =
        serde_json::from_str(trimmed).map_err(|e| format!("sqlite json parse: {e}"))?;

    Ok(raw
        .into_iter()
        .filter_map(|r| {
            let guid = r.guid?;
            if guid.is_empty() {
                return None;
            }
            let participants: Vec<String> = r
                .participants
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let display_name = r
                .display_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| participants.join(", "));
            let last_text = r.last_text.unwrap_or_default();
            let last_message_preview = truncate_preview(&last_text, LAST_MESSAGE_TRUNCATE);
            let last_message_ts = apple_date_to_unix(r.last_date.unwrap_or(0));
            let unread = r.unread_count.unwrap_or(0) > 0;
            Some(ChatSummary {
                id: guid,
                display_name,
                participants,
                last_message_preview,
                last_message_ts,
                unread,
            })
        })
        .collect())
}

fn parse_conversation_json(stdout: &str) -> Result<Vec<ConversationMessage>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawConvRow> =
        serde_json::from_str(trimmed).map_err(|e| format!("sqlite json parse: {e}"))?;

    let mut rows: Vec<ConversationMessage> = raw
        .into_iter()
        .filter_map(|r| {
            let rowid = r.rowid?;
            let mut text = r.text.unwrap_or_default();
            let from_me = r.is_from_me.unwrap_or(0) != 0;
            let has_attachment = r.has_attachment.unwrap_or(0) != 0;

            // Ventura/Sonoma iMessages: `text` is null, the readable body
            // lives inside `attributedBody` as typedstream bytes. Try to
            // extract it before treating the row as empty.
            if text.trim().is_empty() {
                if let Some(hex) = r.attributed_body_hex {
                    if let Some(recovered) = crate::attributed_body::extract_text_from_hex(&hex) {
                        text = recovered;
                    }
                }
            }

            // Drop rows that have neither text nor attachment — almost always
            // tapback / metadata rows that aren't worth surfacing.
            if text.trim().is_empty() && !has_attachment {
                return None;
            }
            let ts = apple_date_to_unix(r.date.unwrap_or(0));
            let service = r.service.unwrap_or_default();
            Some(ConversationMessage {
                rowid,
                text,
                ts,
                from_me,
                sender: if from_me { None } else { r.sender_handle },
                is_imessage: service.eq_ignore_ascii_case("iMessage"),
                has_attachment,
            })
        })
        .collect();

    // SQL returned DESC so we got the *most recent* N rows; flip to reading
    // order (oldest → newest) for the UI and the agent context.
    rows.reverse();
    Ok(rows)
}

fn apple_date_to_unix(raw: i64) -> i64 {
    if raw == 0 {
        return 0;
    }
    let seconds = if raw > 1_000_000_000_000 {
        raw / 1_000_000_000
    } else {
        raw
    };
    seconds + APPLE_EPOCH_OFFSET
}

fn truncate_preview(text: &str, max: usize) -> String {
    let single = text.replace(['\n', '\r'], " ");
    let collapsed: String = single.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max {
        let cut: String = collapsed.chars().take(max).collect();
        format!("{cut}…")
    } else {
        collapsed
    }
}

// --------------------------------------------------------------------------
// Escaping + sanitization
// --------------------------------------------------------------------------

/// Escape a string for safe embedding inside an AppleScript double-quoted
/// literal. Order matters — backslashes first, then quotes, then newlines.
/// Newlines must become `\n` sequences inside the literal so a multi-line
/// body cannot prematurely terminate the script line.
fn applescript_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

/// Normalize a recipient handle for Messages.app.
///
/// - Email addresses: trim whitespace, lower-case (iMessage handles are
///   case-insensitive).
/// - Phone numbers: keep only `+` and digits. Strip spaces, parentheses,
///   dashes, dots — Messages.app accepts the bare E.164-ish form and is
///   forgiving about missing `+`.
fn sanitize_recipient(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.contains('@') {
        return trimmed.to_ascii_lowercase();
    }
    trimmed
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect()
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_escape_handles_specials() {
        let input = "Hello \"world\"\nline2\\back";
        let escaped = applescript_escape(input);
        assert_eq!(escaped, "Hello \\\"world\\\"\\nline2\\\\back");
        // Ensure the escaped body, when wrapped in literal quotes, contains no
        // unescaped `"` that would terminate the AppleScript string early.
        let wrapped = format!("\"{escaped}\"");
        // Count of unescaped `"` should be exactly 2 (the outer pair).
        let unescaped_quotes = wrapped
            .char_indices()
            .filter(|(i, c)| {
                *c == '"'
                    && (*i == 0
                        || wrapped[..*i].chars().last().map(|p| p != '\\').unwrap_or(true))
            })
            .count();
        assert_eq!(unescaped_quotes, 2);
    }

    #[test]
    fn sanitize_recipient_strips_phone_formatting() {
        assert_eq!(sanitize_recipient("+1 (604) 555-1234"), "+16045551234");
        assert_eq!(sanitize_recipient(" 604.555.1234 "), "6045551234");
        assert_eq!(sanitize_recipient("+1-604-555-1234"), "+16045551234");
        // Emails are lower-cased and trimmed, otherwise preserved.
        assert_eq!(sanitize_recipient(" Foo@Bar.COM "), "foo@bar.com");
    }

    #[test]
    fn parse_chat_json_basic() {
        let sample = r#"[
          {
            "guid":"iMessage;-;+16045551234",
            "display_name":"",
            "participants":"+16045551234,a@b.com",
            "last_text":"hey | check\nthis",
            "last_date":631152000000000000,
            "unread_count":2
          },
          {
            "guid":"iMessage;+;fam-group",
            "display_name":"Family",
            "participants":"a@b.com,c@d.com",
            "last_text":"ok",
            "last_date":631152000000000001,
            "unread_count":0
          }
        ]"#;
        let chats = parse_chat_json(sample).unwrap();
        assert_eq!(chats.len(), 2);

        // First chat: no display_name → falls back to joined participants.
        assert_eq!(chats[0].id, "iMessage;-;+16045551234");
        assert_eq!(chats[0].display_name, "+16045551234, a@b.com");
        assert_eq!(chats[0].participants.len(), 2);
        assert!(chats[0].unread);
        assert!(chats[0].last_message_preview.contains("|"));
        assert!(!chats[0].last_message_preview.contains('\n'));

        // Second chat: explicit display_name kept, not unread.
        assert_eq!(chats[1].display_name, "Family");
        assert!(!chats[1].unread);
    }

    #[test]
    fn parse_chat_json_empty() {
        assert!(parse_chat_json("").unwrap().is_empty());
        assert!(parse_chat_json("[]").unwrap().is_empty());
    }

    #[test]
    fn build_send_script_embeds_escaped_fields() {
        let script = build_send_script("+16045551234", "hi \"there\"", "iMessage");
        assert!(script.contains("service type = iMessage"));
        assert!(script.contains("buddy \"+16045551234\""));
        assert!(script.contains("send \"hi \\\"there\\\"\""));
    }

    #[test]
    fn is_safe_identifier_accepts_phones_and_emails() {
        // chat.db's `chat.chat_identifier` column holds bare phone / email /
        // synthetic `chat…` ids — no semicolons or quotes — so the allowlist
        // stays tight against injection.
        assert!(is_safe_identifier("+16045551234"));
        assert!(is_safe_identifier("foo.bar@example.com"));
        assert!(is_safe_identifier("chat123456789"));
        assert!(is_safe_identifier("6045551234"));
    }

    #[test]
    fn is_safe_identifier_rejects_injection_attempts() {
        assert!(!is_safe_identifier(""));
        assert!(!is_safe_identifier("'; DROP TABLE message; --"));
        assert!(!is_safe_identifier("x' OR '1'='1"));
        assert!(!is_safe_identifier("has spaces"));
        assert!(!is_safe_identifier("quoted\""));
    }

    #[test]
    fn parse_conversation_reverses_to_reading_order() {
        // sqlite3 returns newest first (ORDER BY DESC); parse_conversation_json
        // flips to oldest → newest so the UI can render top-to-bottom.
        let sample = r#"[
          {"rowid":300,"text":"c","date":3000000,"is_from_me":1,"sender_handle":null,"service":"iMessage","has_attachment":0},
          {"rowid":200,"text":"b","date":2000000,"is_from_me":0,"sender_handle":"+16045551234","service":"iMessage","has_attachment":0},
          {"rowid":100,"text":"a","date":1000000,"is_from_me":0,"sender_handle":"+16045551234","service":"iMessage","has_attachment":0}
        ]"#;
        let msgs = parse_conversation_json(sample).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].text, "a");
        assert_eq!(msgs[1].text, "b");
        assert_eq!(msgs[2].text, "c");
        assert_eq!(msgs[0].rowid, 100);
        assert_eq!(msgs[2].rowid, 300);
        assert!(msgs[2].from_me);
        assert_eq!(msgs[0].sender.as_deref(), Some("+16045551234"));
    }

    #[test]
    fn parse_conversation_drops_empty_non_attachment_rows() {
        // Tapbacks / metadata often have null text and no attachment — skip them.
        let sample = r#"[
          {"rowid":200,"text":null,"date":2000000,"is_from_me":0,"sender_handle":"+1","service":"iMessage","has_attachment":0},
          {"rowid":100,"text":"real","date":1000000,"is_from_me":0,"sender_handle":"+1","service":"iMessage","has_attachment":0}
        ]"#;
        let msgs = parse_conversation_json(sample).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text, "real");
    }

    #[test]
    fn parse_conversation_keeps_attachment_only_rows() {
        let sample = r#"[
          {"rowid":100,"text":null,"date":1000000,"is_from_me":0,"sender_handle":"+1","service":"iMessage","has_attachment":1}
        ]"#;
        let msgs = parse_conversation_json(sample).unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].has_attachment);
    }
}

// === REGISTER IN lib.rs ===
// mod messaging;
// #[tauri::command]s: messaging_send_imessage, messaging_send_sms, messaging_list_chats
// invoke_handler: messaging_send_imessage, messaging_send_sms, messaging_list_chats
// No new deps.
// === END REGISTER ===
