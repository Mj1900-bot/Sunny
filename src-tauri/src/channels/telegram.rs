//! Telegram bot-channel adapter — v0.1 scaffolding.
//!
//! This module is the plumbing layer: config parsing, message shape,
//! Bot API URL construction, chat-id allowlist enforcement, and
//! `send_message` / `get_updates` HTTP calls. Wiring the inbound
//! stream to `agent_loop::core::agent_run` is v0.2 work — we want
//! every security check (allowlisted chat, rate limit, input shape)
//! to compile green before the first live request lands.
//!
//! ## Config file
//!
//! `~/.sunny/telegram.json`:
//!
//! ```json
//! {
//!   "allowed_chat_ids": [123456789, 987654321],
//!   "poll_interval_ms": 1500
//! }
//! ```
//!
//! The bot token itself NEVER lives in this file — it goes through
//! the existing keychain layer (`SecretKind::TelegramBot`) alongside
//! other provider API keys. A config file without a paired keychain
//! entry is inert: `connect` will surface `missing bot token` and
//! exit clean.
//!
//! ## Why chat-id allowlist?
//!
//! A Telegram bot is reachable by anyone who knows its handle. The
//! allowlist is the only barrier between the world and your Sunny
//! instance. Empty list = nobody; unset = unreachable. Fail-closed.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Bot API endpoint — Telegram's public base URL. Exposed so tests
/// can substitute a mock server.
pub const BOT_API_BASE: &str = "https://api.telegram.org";

/// Default long-poll / short-poll cadence when the config file
/// doesn't set one. 1.5 s keeps traffic low while giving snappy
/// response to first-message wake.
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 1_500;

/// Minimum allowed poll interval. Protects the Telegram Bot API rate
/// limit (avoid "Too Many Requests" on tight loops).
pub const MIN_POLL_INTERVAL_MS: u64 = 250;

/// Config file lives under `~/.sunny/telegram.json`. Reading this
/// returns `None` when the file is missing (channel simply not
/// configured — not an error).
const CONFIG_FILE: &str = "telegram.json";

/// Telegram channel config — persisted at `~/.sunny/telegram.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelegramConfig {
    /// chat_ids allowed to message the bot. Strictly fail-closed:
    /// missing / empty list = no one can reach the channel. Individual
    /// user chats use positive integers; group chats use negatives
    /// — Telegram's numbering convention, passed through verbatim.
    #[serde(default)]
    pub allowed_chat_ids: Vec<i64>,
    /// Long-poll interval ms; `None` → `DEFAULT_POLL_INTERVAL_MS`.
    #[serde(default)]
    pub poll_interval_ms: Option<u64>,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        TelegramConfig {
            allowed_chat_ids: Vec::new(),
            poll_interval_ms: None,
        }
    }
}

impl TelegramConfig {
    /// Effective poll interval — floor-clamped at
    /// `MIN_POLL_INTERVAL_MS` so a mis-typed config can't hammer the
    /// Bot API.
    pub fn effective_poll_interval_ms(&self) -> u64 {
        self.poll_interval_ms
            .unwrap_or(DEFAULT_POLL_INTERVAL_MS)
            .max(MIN_POLL_INTERVAL_MS)
    }

    /// `true` when `chat_id` is on the allowlist. Empty list is
    /// ALWAYS `false` — never accidentally permit the world.
    pub fn is_chat_allowed(&self, chat_id: i64) -> bool {
        self.allowed_chat_ids.iter().any(|&id| id == chat_id)
    }
}

/// Resolve `~/.sunny/telegram.json` — `None` when `$HOME` is
/// unresolvable (very exotic environments).
fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".sunny").join(CONFIG_FILE))
}

/// Load the persisted config. Returns:
/// * `Ok(Some(cfg))` — normal path.
/// * `Ok(None)` — config file missing (channel not configured; caller
///   should skip init without logging an error).
/// * `Err(..)` — file exists but is malformed; caller surfaces to user.
pub fn load_config() -> Result<Option<TelegramConfig>, String> {
    let path = match config_path() {
        Some(p) => p,
        None => return Ok(None),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str::<TelegramConfig>(&raw)
        .map(Some)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Bot API wire types
// ---------------------------------------------------------------------------

/// Inbound message as seen by the poller, flattened from Telegram's
/// nested `Update { message: Message { chat: Chat {...}, from: User {...}, text, ... } }`.
/// Non-text updates (photos, stickers, callbacks) are dropped at the
/// parse layer for v0.1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramMessage {
    pub update_id: i64,
    pub chat_id: i64,
    pub from_username: Option<String>,
    pub text: String,
}

/// Parse ONE raw update JSON into our flattened `TelegramMessage`.
/// Returns `None` when the update has no text message (non-text
/// updates are skipped silently in v0.1).
pub fn parse_update(raw: &serde_json::Value) -> Option<TelegramMessage> {
    let update_id = raw.get("update_id")?.as_i64()?;
    let message = raw.get("message")?;
    let chat_id = message.get("chat")?.get("id")?.as_i64()?;
    let text = message.get("text")?.as_str()?.to_string();
    let from_username = message
        .get("from")
        .and_then(|f| f.get("username"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());
    Some(TelegramMessage {
        update_id,
        chat_id,
        from_username,
        text,
    })
}

// ---------------------------------------------------------------------------
// Bot API URL helpers — pure string construction, no network.
// ---------------------------------------------------------------------------

/// Build `https://api.telegram.org/bot<TOKEN>/<method>`. Validates
/// the token shape (non-empty, no whitespace, no newlines) so a
/// mis-paste can never smuggle a CRLF into the URL.
pub fn bot_method_url(token: &str, method: &str) -> Result<String, String> {
    if token.is_empty() {
        return Err("bot token is empty".into());
    }
    if token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("bot token contains whitespace or control chars".into());
    }
    if method.is_empty() {
        return Err("method name is empty".into());
    }
    if method.chars().any(|c| !c.is_ascii_alphanumeric()) {
        return Err("method name must be ASCII alphanumeric".into());
    }
    Ok(format!("{BOT_API_BASE}/bot{token}/{method}"))
}

// ---------------------------------------------------------------------------
// Send / receive (network — not exercised by unit tests)
// ---------------------------------------------------------------------------

/// Send a plain-text message to a Telegram chat. Does NOT check the
/// allowlist — that's the caller's job; `send_message` is the final
/// outbound hop and should be usable to send the "not authorised"
/// rejection to an unrecognised chat if the channel decides to reply.
pub async fn send_message(
    token: &str,
    chat_id: i64,
    text: &str,
) -> Result<(), String> {
    let url = bot_method_url(token, "sendMessage")?;
    let body = serde_json::json!({
        "chat_id": chat_id,
        "text": text,
    });
    let client = crate::http::client();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("telegram send: network: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("telegram send: HTTP {status}: {body}"));
    }
    Ok(())
}

/// Call `getUpdates` with the caller-supplied `offset` (to ack prior
/// messages). Returns the parsed message list + the next offset the
/// poller should pass back. Skips non-text updates silently — their
/// `update_id` still bumps the offset so Telegram deletes them from
/// the queue.
pub async fn get_updates(
    token: &str,
    offset: i64,
    timeout_secs: u64,
) -> Result<(Vec<TelegramMessage>, i64), String> {
    let url = bot_method_url(token, "getUpdates")?;
    let client = crate::http::client();
    let resp = client
        .get(&url)
        .query(&[
            ("offset", offset.to_string()),
            ("timeout", timeout_secs.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("telegram poll: network: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("telegram poll: HTTP {status}: {body}"));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("telegram poll: decode: {e}"))?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "telegram poll: api returned ok=false: {body}",
        ));
    }
    let raw_updates = body
        .get("result")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut messages = Vec::with_capacity(raw_updates.len());
    let mut next_offset = offset;
    for update in &raw_updates {
        if let Some(id) = update.get("update_id").and_then(|v| v.as_i64()) {
            if id + 1 > next_offset {
                next_offset = id + 1;
            }
        }
        if let Some(msg) = parse_update(update) {
            messages.push(msg);
        }
    }
    Ok((messages, next_offset))
}

// ---------------------------------------------------------------------------
// Tests — all pure logic, no network
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── config shape ────────────────────────────────────────────────────────

    #[test]
    fn config_default_has_empty_allowlist() {
        let c = TelegramConfig::default();
        assert!(c.allowed_chat_ids.is_empty());
        assert!(c.poll_interval_ms.is_none());
    }

    #[test]
    fn config_deserialises_minimal_shape() {
        let raw = r#"{"allowed_chat_ids":[123,-456]}"#;
        let c: TelegramConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(c.allowed_chat_ids, vec![123, -456]);
        assert!(c.poll_interval_ms.is_none());
    }

    #[test]
    fn config_deserialises_empty_object_to_default() {
        let c: TelegramConfig = serde_json::from_str("{}").unwrap();
        assert!(c.allowed_chat_ids.is_empty());
    }

    #[test]
    fn config_is_chat_allowed_true_for_listed_id() {
        let c = TelegramConfig {
            allowed_chat_ids: vec![1, 2, 3],
            poll_interval_ms: None,
        };
        assert!(c.is_chat_allowed(2));
    }

    #[test]
    fn config_is_chat_allowed_false_for_empty_list() {
        let c = TelegramConfig::default();
        assert!(!c.is_chat_allowed(1));
        assert!(!c.is_chat_allowed(0));
        assert!(!c.is_chat_allowed(-1));
    }

    #[test]
    fn config_is_chat_allowed_handles_negative_group_ids() {
        // Telegram group chats are negative integers. The allowlist
        // must pass them through verbatim.
        let c = TelegramConfig {
            allowed_chat_ids: vec![-1001234567890],
            poll_interval_ms: None,
        };
        assert!(c.is_chat_allowed(-1001234567890));
        assert!(!c.is_chat_allowed(1001234567890));
    }

    #[test]
    fn effective_poll_interval_uses_default_when_unset() {
        let c = TelegramConfig::default();
        assert_eq!(c.effective_poll_interval_ms(), DEFAULT_POLL_INTERVAL_MS);
    }

    #[test]
    fn effective_poll_interval_clamps_to_minimum() {
        let c = TelegramConfig {
            allowed_chat_ids: vec![],
            poll_interval_ms: Some(10), // well below the floor
        };
        assert_eq!(c.effective_poll_interval_ms(), MIN_POLL_INTERVAL_MS);
    }

    #[test]
    fn effective_poll_interval_honours_explicit_value() {
        let c = TelegramConfig {
            allowed_chat_ids: vec![],
            poll_interval_ms: Some(5000),
        };
        assert_eq!(c.effective_poll_interval_ms(), 5000);
    }

    // ── URL construction / token shape guards ───────────────────────────────

    #[test]
    fn bot_method_url_builds_expected_shape() {
        let url = bot_method_url("12345:ABC-token", "getMe").unwrap();
        assert_eq!(url, "https://api.telegram.org/bot12345:ABC-token/getMe");
    }

    #[test]
    fn bot_method_url_rejects_empty_token() {
        assert!(bot_method_url("", "getMe").is_err());
    }

    #[test]
    fn bot_method_url_rejects_whitespace_in_token() {
        let err = bot_method_url("123:abc def", "getMe").unwrap_err();
        assert!(err.contains("whitespace"), "got: {err}");
    }

    #[test]
    fn bot_method_url_rejects_newline_in_token() {
        let err = bot_method_url("123:abc\ndef", "getMe").unwrap_err();
        assert!(err.contains("whitespace") || err.contains("control"), "got: {err}");
    }

    #[test]
    fn bot_method_url_rejects_non_alphanumeric_method() {
        assert!(bot_method_url("t", "get/Me").is_err());
        assert!(bot_method_url("t", "get Me").is_err());
        assert!(bot_method_url("t", "getMe?foo=1").is_err());
    }

    #[test]
    fn bot_method_url_rejects_empty_method() {
        assert!(bot_method_url("t", "").is_err());
    }

    // ── update parsing ──────────────────────────────────────────────────────

    #[test]
    fn parse_update_extracts_text_message() {
        let raw = json!({
            "update_id": 42,
            "message": {
                "message_id": 99,
                "date": 1700000000,
                "chat": {"id": 12345, "type": "private"},
                "from": {"id": 67890, "is_bot": false, "username": "sunny"},
                "text": "hello"
            }
        });
        let m = parse_update(&raw).unwrap();
        assert_eq!(m.update_id, 42);
        assert_eq!(m.chat_id, 12345);
        assert_eq!(m.from_username.as_deref(), Some("sunny"));
        assert_eq!(m.text, "hello");
    }

    #[test]
    fn parse_update_returns_none_for_non_text_update() {
        // A photo-only message has no `text` key.
        let raw = json!({
            "update_id": 7,
            "message": {
                "chat": {"id": 1},
                "photo": [{"file_id": "abc"}]
            }
        });
        assert!(parse_update(&raw).is_none());
    }

    #[test]
    fn parse_update_returns_none_for_callback_query() {
        // inline-button callbacks don't contain a `message` field.
        let raw = json!({
            "update_id": 5,
            "callback_query": {"id": "cb1", "data": "go"}
        });
        assert!(parse_update(&raw).is_none());
    }

    #[test]
    fn parse_update_returns_none_for_missing_chat() {
        let raw = json!({
            "update_id": 3,
            "message": {"text": "no chat field"}
        });
        assert!(parse_update(&raw).is_none());
    }

    #[test]
    fn parse_update_tolerates_missing_username() {
        let raw = json!({
            "update_id": 9,
            "message": {
                "chat": {"id": 1},
                "from": {"id": 2, "is_bot": false},
                "text": "hi"
            }
        });
        let m = parse_update(&raw).unwrap();
        assert!(m.from_username.is_none());
        assert_eq!(m.text, "hi");
    }
}
