//! iMessage contacts — reads recent conversations from ~/Library/Messages/chat.db.
//!
//! Uses the built-in macOS `sqlite3` binary in read-only mode so we don't need
//! any new crates. Requires Full Disk Access permission for the parent app.
//!
//! Output is parsed as JSON (`.mode json`) rather than pipe-delimited lines.
//! Message bodies routinely contain `|` and literal newlines (URLs, code,
//! multi-line texts) — list/CSV modes would silently mis-split rows.

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;

const APPLE_EPOCH_OFFSET: i64 = 978_307_200;
const LAST_MESSAGE_TRUNCATE: usize = 140;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessageContact {
    pub handle: String,
    pub display: String,
    pub last_message: String,
    #[ts(type = "number")]
    pub last_ts: i64,
    #[ts(type = "number")]
    pub message_count: i64,
    pub is_imessage: bool,
    /// Number of unread inbound messages in this conversation. `0` for
    /// everything you've already read (or sent yourself).
    #[serde(default)]
    #[ts(type = "number")]
    pub unread_count: i64,
}

#[derive(Debug, Deserialize)]
struct RawRow {
    chat_identifier: Option<String>,
    display_name: Option<String>,
    handles: Option<String>,
    style: Option<i64>,
    service: Option<String>,
    last_date: Option<i64>,
    msg_count: Option<i64>,
    last_text: Option<String>,
    /// Hex-encoded attributedBody of the last message, for Ventura+ where
    /// `text` is null but the body lives in the typedstream BLOB.
    last_attributed_body_hex: Option<String>,
    last_has_attachment: Option<i64>,
    unread_count: Option<i64>,
}

// Group by chat (conversation), matching how Messages.app orders its sidebar.
// Grouping by handle produced duplicate rows for group chats (one per
// participant) and an ordering that mixed group + 1:1 activity for each handle.
const QUERY: &str = r#"
WITH chat_stats AS (
  SELECT
    cmj.chat_id AS chat_id,
    MAX(m.date) AS last_date,
    COUNT(m.ROWID) AS msg_count
  FROM chat_message_join cmj
  JOIN message m ON m.ROWID = cmj.message_id
  GROUP BY cmj.chat_id
)
SELECT
  c.chat_identifier AS chat_identifier,
  c.display_name    AS display_name,
  c.service_name    AS service,
  c.style           AS style,
  (
    SELECT GROUP_CONCAT(h.id, ',')
    FROM chat_handle_join chj
    JOIN handle h ON h.ROWID = chj.handle_id
    WHERE chj.chat_id = c.ROWID
  ) AS handles,
  cs.last_date AS last_date,
  cs.msg_count AS msg_count,
  (
    SELECT m.text FROM message m
    JOIN chat_message_join cmj2 ON cmj2.message_id = m.ROWID
    WHERE cmj2.chat_id = c.ROWID
      AND m.text IS NOT NULL AND TRIM(m.text) <> ''
    ORDER BY m.date DESC LIMIT 1
  ) AS last_text,
  (
    -- Fallback to the typedstream BLOB for Ventura+ messages whose `text`
    -- column is null. Rust-side extractor pulls the readable body.
    SELECT HEX(m.attributedBody) FROM message m
    JOIN chat_message_join cmj4 ON cmj4.message_id = m.ROWID
    WHERE cmj4.chat_id = c.ROWID
      AND (m.text IS NULL OR TRIM(m.text) = '')
      AND m.attributedBody IS NOT NULL
    ORDER BY m.date DESC LIMIT 1
  ) AS last_attributed_body_hex,
  (
    SELECT m.cache_has_attachments FROM message m
    JOIN chat_message_join cmj3 ON cmj3.message_id = m.ROWID
    WHERE cmj3.chat_id = c.ROWID
    ORDER BY m.date DESC LIMIT 1
  ) AS last_has_attachment,
  (
    SELECT COUNT(*) FROM message m
    JOIN chat_message_join cmj5 ON cmj5.message_id = m.ROWID
    WHERE cmj5.chat_id = c.ROWID
      AND m.is_from_me = 0
      AND m.is_read = 0
  ) AS unread_count
FROM chat c
JOIN chat_stats cs ON cs.chat_id = c.ROWID
ORDER BY cs.last_date DESC
LIMIT ?;
"#;

fn apple_date_to_unix(raw: i64) -> i64 {
    let seconds = if raw > 1_000_000_000_000 { raw / 1_000_000_000 } else { raw };
    seconds + APPLE_EPOCH_OFFSET
}

fn format_us_phone(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    match digits.len() {
        11 if digits.starts_with('1') => format!(
            "+1 ({}) {}-{}",
            &digits[1..4], &digits[4..7], &digits[7..11],
        ),
        10 => format!(
            "+1 ({}) {}-{}",
            &digits[0..3], &digits[3..6], &digits[6..10],
        ),
        _ => raw.to_string(),
    }
}

fn prettify_handle(handle: &str) -> String {
    if handle.starts_with('+') {
        format_us_phone(handle)
    } else {
        handle.to_string()
    }
}

fn truncate(text: &str, max: usize) -> String {
    let single = text.replace(['\n', '\r'], " ");
    let collapsed: String = single.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max {
        let cut: String = collapsed.chars().take(max).collect();
        format!("{cut}…")
    } else {
        collapsed
    }
}

fn home_messages_db() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join("Library/Messages/chat.db").to_string_lossy().into_owned())
}

fn classify_sqlite_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("unable to open database file")
        || lower.contains("authorization denied")
        || lower.contains("operation not permitted")
    {
        "permission denied — grant Full Disk Access to Sunny in System Settings → Privacy".to_string()
    } else {
        format!("sqlite3: {}", stderr.trim())
    }
}

pub async fn recent_contacts(limit: usize) -> Result<Vec<MessageContact>, String> {
    let db_path = home_messages_db()?;
    let bounded_limit = limit.clamp(1, 500);
    // LIMIT doesn't accept ? binding via the sqlite CLI one-shot form, so we
    // substitute the clamped literal. Safe because `bounded_limit` is u-bounded.
    let sql = QUERY.replace('?', &bounded_limit.to_string());
    // Kick off the AddressBook lookup concurrently with the chat.db query.
    // Worst case it returns an empty index; best case we get real names.
    let address_book = crate::contacts_book::get_index().await;

    // `.mode json` returns a single JSON array — handles `|`, newlines, quotes,
    // emoji-in-message — and parses cleanly with serde_json.
    let output = Command::new("sqlite3")
        .arg("-readonly")
        .arg("-cmd").arg(".mode json")
        .arg(&db_path)
        .arg(&sql)
        .output()
        .await
        .map_err(|e| format!("sqlite3 spawn failed: {e}"))?;

    if !output.status.success() {
        return Err(classify_sqlite_error(&String::from_utf8_lossy(&output.stderr)));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.to_lowercase().contains("unable to open database file") {
        return Err(classify_sqlite_error(&stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_json(&stdout, &address_book)
}

fn parse_json(
    stdout: &str,
    address_book: &crate::contacts_book::ContactIndex,
) -> Result<Vec<MessageContact>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let raw_rows: Vec<RawRow> =
        serde_json::from_str(trimmed).map_err(|e| format!("sqlite json parse: {e}"))?;

    Ok(raw_rows
        .into_iter()
        .filter_map(|r| {
            let chat_identifier = r.chat_identifier.unwrap_or_default();
            if chat_identifier.is_empty() { return None; }

            let handles_raw = r.handles.unwrap_or_default();
            let handles: Vec<&str> = handles_raw
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();

            // `style == 43` is the group-chat flag in Messages' schema.
            // We also treat >1 participant as group (belt-and-suspenders).
            let is_group = r.style.unwrap_or(0) == 43 || handles.len() > 1;

            let last_date = r.last_date.unwrap_or(0);
            let last_text_plain = r.last_text.unwrap_or_default();
            let had_attachment = r.last_has_attachment.unwrap_or(0) != 0;

            // Ventura+ stores text inside attributedBody, not the text column.
            // If the plain text is empty, try extracting from the typedstream
            // blob before giving up and showing "[attachment]" or nothing.
            let last_text = if !last_text_plain.trim().is_empty() {
                last_text_plain
            } else if let Some(hex) = r.last_attributed_body_hex.as_deref() {
                crate::attributed_body::extract_text_from_hex(hex).unwrap_or_default()
            } else {
                String::new()
            };

            let last_message = if !last_text.trim().is_empty() {
                truncate(&last_text, LAST_MESSAGE_TRUNCATE)
            } else if had_attachment {
                "[attachment]".to_string()
            } else {
                String::new()
            };

            let display_name = r.display_name.unwrap_or_default();
            let display_name_trim = display_name.trim();
            let display = if !display_name_trim.is_empty() {
                // iMessage-assigned group names always win; they reflect what
                // the user explicitly typed into the Messages.app info pane.
                display_name_trim.to_string()
            } else if is_group {
                // Group without a name: join up to 3 participant labels,
                // preferring AddressBook matches over raw phone numbers.
                let pretty: Vec<String> = handles
                    .iter()
                    .take(3)
                    .map(|h| {
                        address_book
                            .lookup(h)
                            .map(str::to_string)
                            .unwrap_or_else(|| prettify_handle(h))
                    })
                    .collect();
                let joined = pretty.join(", ");
                if handles.len() > 3 {
                    format!("{} +{}", joined, handles.len() - 3)
                } else if joined.is_empty() {
                    "Group".to_string()
                } else {
                    joined
                }
            } else {
                // 1:1 chat → prefer a real contact name from AddressBook.
                address_book
                    .lookup(&chat_identifier)
                    .map(str::to_string)
                    .unwrap_or_else(|| prettify_handle(&chat_identifier))
            };

            let service = r.service.unwrap_or_default();
            let is_imessage = service.eq_ignore_ascii_case("iMessage");
            let last_ts = apple_date_to_unix(last_date);

            Some(MessageContact {
                handle: chat_identifier,
                display,
                last_message,
                last_ts,
                message_count: r.msg_count.unwrap_or(0),
                is_imessage,
                unread_count: r.unread_count.unwrap_or(0).max(0),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prettifies_us_phone() {
        assert_eq!(prettify_handle("+16045551234"), "+1 (604) 555-1234");
    }

    #[test]
    fn keeps_email() {
        assert_eq!(prettify_handle("a@b.com"), "a@b.com");
    }

    #[test]
    fn converts_apple_epoch_ns() {
        let raw: i64 = 631_152_000_000_000_000;
        let unix = apple_date_to_unix(raw);
        assert_eq!(unix, 631_152_000 + APPLE_EPOCH_OFFSET);
    }

    #[test]
    fn truncate_handles_long() {
        let s = "a".repeat(200);
        let out = truncate(&s, 50);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 51);
    }

    fn empty_book() -> crate::contacts_book::ContactIndex {
        crate::contacts_book::ContactIndex::empty()
    }

    #[test]
    fn parse_json_survives_pipes_and_newlines() {
        // sqlite3 .mode json properly escapes \n inside JSON string values.
        let sample = r#"[
          {"chat_identifier":"+16045551234","display_name":"","handles":"+16045551234","style":45,"service":"iMessage","last_date":631152000000000000,"msg_count":42,"last_text":"hey | check this\nsecond line","last_has_attachment":0}
        ]"#;
        let rows = parse_json(sample, &empty_book()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].handle, "+16045551234");
        assert_eq!(rows[0].message_count, 42);
        assert!(rows[0].is_imessage);
        assert!(rows[0].last_message.contains("|"));
        assert!(rows[0].last_message.contains("second line"));
        assert!(!rows[0].last_message.contains('\n'));
    }

    #[test]
    fn parse_json_group_chat_uses_display_name() {
        let sample = r#"[
          {"chat_identifier":"chat12345","display_name":"Dinner Crew","handles":"+16045551234,+16045559999,a@b.com","style":43,"service":"iMessage","last_date":631152000000000000,"msg_count":9,"last_text":"see you there","last_has_attachment":0}
        ]"#;
        let rows = parse_json(sample, &empty_book()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].display, "Dinner Crew");
    }

    #[test]
    fn parse_json_group_chat_without_name_lists_handles() {
        let sample = r#"[
          {"chat_identifier":"chat12345","display_name":"","handles":"+16045551234,+16045559999","style":43,"service":"iMessage","last_date":631152000000000000,"msg_count":9,"last_text":"yo","last_has_attachment":0}
        ]"#;
        let rows = parse_json(sample, &empty_book()).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].display.contains("+1 (604) 555-1234"));
        assert!(rows[0].display.contains("+1 (604) 555-9999"));
    }

    #[test]
    fn parse_json_attachment_placeholder_when_no_text() {
        let sample = r#"[
          {"chat_identifier":"+16045551234","display_name":"","handles":"+16045551234","style":45,"service":"iMessage","last_date":631152000000000000,"msg_count":1,"last_text":null,"last_has_attachment":1}
        ]"#;
        let rows = parse_json(sample, &empty_book()).unwrap();
        assert_eq!(rows[0].last_message, "[attachment]");
    }

    #[test]
    fn parse_json_empty() {
        assert!(parse_json("", &empty_book()).unwrap().is_empty());
        assert!(parse_json("[]", &empty_book()).unwrap().is_empty());
    }

    #[test]
    fn parse_json_uses_address_book_for_one_to_one() {
        let sample = r#"[
          {"chat_identifier":"+16045551234","display_name":"","handles":"+16045551234","style":45,"service":"iMessage","last_date":631152000000000000,"msg_count":1,"last_text":"yo","last_has_attachment":0}
        ]"#;
        // Use the public lookup path via constructing an index through the
        // same normalise we use elsewhere. `by_handle` is pub(crate) but
        // only observable via `with_entry` from out-of-module callers.
        let ab = {
            let _digits = crate::contacts_book::normalise_handle("+16045551234");
            crate::contacts_book::ContactIndex::with_entry("+16045551234", "Mom")
        };
        let rows = parse_json(sample, &ab).unwrap();
        assert_eq!(rows[0].display, "Mom");
    }
}
