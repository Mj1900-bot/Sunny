//! Common fixtures, helpers, and skip-guards for live integration tests.
//!
//! Imported as `live_helpers` by `tests/live.rs` (the integration test entry
//! point). Test submodules are declared in `live.rs` with `#[path]` attributes
//! and reference helpers via `super::` (which resolves to `live_helpers` as
//! re-exported from `live.rs` via `use live_helpers::*`).
//!
//! Cost ceiling: $0.01 per full `cargo test --test live -- --ignored` run.
//! All prompts use max_tokens=50 to stay well inside that bound.

use std::time::Instant;

use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Keychain key loader
// ---------------------------------------------------------------------------

/// Read the Z.AI API key from macOS Keychain (service `sunny-zai-api-key`).
/// Returns `None` when: Keychain entry absent, binary missing, or value empty.
pub async fn load_zai_key() -> Option<String> {
    // Prefer env override (useful in CI when someone wants to run live tests
    // with a secret injected via environment instead of the Keychain).
    for var in &["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY"] {
        if let Ok(v) = std::env::var(var) {
            let t = v.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    // Fall back to Keychain via the same path the app uses at runtime.
    sunny_lib::secrets::zai_api_key().await
}

// ---------------------------------------------------------------------------
// Skip helpers
// ---------------------------------------------------------------------------

/// Returns `true` when the Z.AI key is absent — test should skip.
/// Prints a human-readable reason so developers know why a test was skipped.
pub async fn should_skip_glm() -> bool {
    if load_zai_key().await.is_none() {
        eprintln!(
            "SKIP: no Z.AI key in env (ZAI_API_KEY / ZHIPU_API_KEY / GLM_API_KEY) \
             or macOS Keychain (sunny-zai-api-key)"
        );
        return true;
    }
    false
}

/// Returns `true` when Ollama is not reachable on 127.0.0.1:11434.
pub async fn should_skip_ollama() -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    match client.get("http://127.0.0.1:11434/api/tags").send().await {
        Ok(r) if r.status().is_success() => false,
        _ => {
            eprintln!("SKIP: ollama not reachable on 127.0.0.1:11434");
            true
        }
    }
}

/// Returns `true` when `model` is not present in `ollama list`, or when
/// Ollama itself is unreachable.
pub async fn should_skip_ollama_model(model: &str) -> bool {
    if should_skip_ollama().await {
        return true;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let resp = match client.get("http://127.0.0.1:11434/api/tags").send().await {
        Ok(r) => r,
        Err(_) => {
            eprintln!("SKIP: could not reach ollama to check model list");
            return true;
        }
    };
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => {
            eprintln!("SKIP: could not parse ollama /api/tags response");
            return true;
        }
    };
    let installed = body
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
                .any(|n| n == model || n.starts_with(&format!("{model}:")))
        })
        .unwrap_or(false);
    if !installed {
        eprintln!("SKIP: model `{model}` not found in `ollama list`");
        true
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Minimal conversation builder
// ---------------------------------------------------------------------------

/// Build a one-turn user history for use with `glm_turn` / `ollama_turn`.
/// Both providers expect `history` to be the conversation so far, NOT
/// including the system prompt (which is passed separately).
pub fn single_user_turn(text: &str) -> Vec<Value> {
    vec![json!({"role": "user", "content": text})]
}

// ---------------------------------------------------------------------------
// Response quality helper
// ---------------------------------------------------------------------------

/// Assert that `text` looks like a legitimate LLM response:
///   - Non-empty after trimming (at least 1 character)
///   - Not all whitespace
///   - Not a verbatim echo of `input`
///
/// Single-character responses (e.g. "4" for "what is 2+2") are valid.
pub fn assert_reasonable_llm_response(text: &str, input: &str) {
    let trimmed = text.trim();
    assert!(
        !trimmed.is_empty(),
        "LLM response was empty or all whitespace"
    );
    // A single meaningful character (digit, letter) is a valid response.
    // The "not all whitespace" guarantee is covered by the is_empty check above.
    assert_ne!(
        trimmed,
        input.trim(),
        "LLM response was a verbatim echo of the input"
    );
}

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

/// Convenience: time a future and return (result, elapsed_ms).
pub async fn timed<F, T>(f: F) -> (T, u128)
where
    F: std::future::Future<Output = T>,
{
    let start = Instant::now();
    let result = f.await;
    let ms = start.elapsed().as_millis();
    (result, ms)
}

/// Returns `true` when `err` is a transient infrastructure error that should
/// cause the test to SKIP rather than FAIL. Covers rate limits (429) and
/// timeouts, which prove nothing about provider correctness.
pub fn is_transient_glm_error(err: &str) -> bool {
    err.contains("429")
        || err.to_lowercase().contains("rate limit")
        || err.to_lowercase().contains("timed out")
        || err.to_lowercase().contains("timeout")
}

// ---------------------------------------------------------------------------
// Mail helper — used by scenarios/email_triage
// ---------------------------------------------------------------------------

/// Structured unread message extracted from the osascript output produced
/// by `load_unread_mail_or_skip`.
#[derive(Debug, Clone)]
pub struct UnreadMessage {
    pub subject: String,
    pub from: String,
    pub date: String,
}

/// Call `mail_list_unread` via the same osascript pipeline used at runtime,
/// returning up to `limit` unread messages. Returns `None` (causing the
/// caller to skip) when:
///   - Mail.app automation is not authorised (Full Disk Access / Automation
///     denied — osascript exits non-zero with "not authorized" in stderr)
///   - The mailbox is empty (no unread messages)
///   - osascript is unavailable or times out
///
/// This mirrors the logic in `src/tools_macos.rs::mail_list_unread` but
/// lives here (in the test harness) so the integration test can call it
/// without needing a Tauri `AppHandle`.
pub async fn load_unread_mail_or_skip(limit: usize) -> Option<Vec<UnreadMessage>> {
    use tokio::process::Command;
    use tokio::time::timeout;
    use std::time::Duration;

    let cap = limit.clamp(1, 50);

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

    let output = match timeout(
        Duration::from_secs(15),
        Command::new("osascript").arg("-e").arg(script).output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            eprintln!("SKIP: osascript spawn failed: {e}");
            return None;
        }
        Err(_) => {
            eprintln!("SKIP: osascript timed out — large mailbox or Mail not running");
            return None;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("SKIP: Mail.app not accessible — {}", stderr.trim());
        return None;
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    if raw.trim().is_empty() {
        eprintln!("SKIP: no unread messages in Mail.app");
        return None;
    }

    let rs = '\u{1f}';
    let fs = '\u{1e}';
    let mut messages: Vec<UnreadMessage> = raw
        .split(rs)
        .filter_map(|row| {
            let row = row.trim_matches('\n');
            if row.is_empty() {
                return None;
            }
            let mut parts = row.split(fs);
            let subject = parts.next()?.trim().to_string();
            let from = parts.next().unwrap_or("").trim().to_string();
            let date = parts.next().unwrap_or("").trim().to_string();
            Some(UnreadMessage { subject, from, date })
        })
        .collect();

    // Newest-first heuristic (mirrors tools_macos.rs behaviour).
    messages.reverse();
    messages.truncate(cap);

    if messages.is_empty() {
        eprintln!("SKIP: no unread messages after parsing");
        return None;
    }

    Some(messages)
}
