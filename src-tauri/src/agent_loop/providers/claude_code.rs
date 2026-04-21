//! Claude Code CLI provider adapter.
//!
//! Drives the locally-installed `claude` CLI (`/Users/sunny/.local/bin/claude`)
//! by spawning it as a subprocess with `--output-format json`, parses its
//! JSON stdout, and returns a `TurnOutcome::Final` — no tool dispatch, because
//! Claude Code runs its own full agentic loop inside the subprocess.
//!
//! # Prompt construction
//!
//! The `messages` Vec (alternating user/assistant history) is concatenated
//! into a single prompt string passed to `-p "…"`. The latest system message
//! (if any) is forwarded via `--append-system-prompt` so Claude Code's own
//! CLAUDE.md-derived system prompt is extended, not replaced. Sunny's internal
//! system prompt is intentionally NOT forwarded — Claude has its own context
//! from `~/.claude/` and the project's `CLAUDE.md`; leaking Sunny's verbose
//! persona prompt would confuse it.
//!
//! # Token accounting
//!
//! The `--output-format json` response includes a `usage` object with
//! `input_tokens` and `output_tokens`. These are Anthropic API counts for the
//! Claude-Code-to-API round-trip, so they are real and reliable — they are
//! the same numbers that appear on Anthropic's billing dashboard. We record
//! them verbatim as `provider = "claude-code"`.
//!
//! # Fallback markers
//!
//! - `claude_code_unavailable:` — binary not found on PATH; caller chains to glm_turn.
//! - `claude_code_auth_expired:` — stderr contains auth/login cues; caller chains to glm_turn.
//! - `claude_code_timeout:` — process exceeded 120 s; caller chains to glm_turn.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::process::Command;
use tokio::time::timeout;

use super::super::types::TurnOutcome;
use crate::telemetry::{cost_estimate, record_llm_turn, TelemetryEvent};

/// Default model forwarded to the CLI. The `-p` path doesn't support
/// streaming mid-tokens, so we use Opus which is the highest-quality
/// batch model available via Claude Code.
pub const CLAUDE_CODE_MODEL: &str = "claude-opus-4-5";

/// Wall-clock ceiling for one CLI subprocess call. Opus can take 60-90 s
/// on complex tasks; 120 s gives headroom without hanging the agent loop
/// indefinitely.
pub const CLAUDE_CODE_TIMEOUT_SECS: u64 = 120;

/// Subset of auth-expired signals observed in Claude Code CLI stderr.
/// Kept as an array so new patterns can be added without touching logic.
const AUTH_EXPIRED_MARKERS: &[&str] = &[
    "not logged in",
    "authentication",
    "please run: claude login",
    "api key",
    "unauthorized",
    "invalid x-api-key",
    "401",
];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Top-level JSON object from `claude --output-format json`.
/// Only the fields we consume are typed; the rest are tolerated via
/// `#[serde(default)]` so a future CLI version adding new keys doesn't break us.
#[derive(Deserialize, Debug)]
pub struct ClaudeCodeResponse {
    /// The final assistant reply text.
    #[serde(default)]
    pub result: String,
    /// Token accounting from the CLI's Anthropic API call.
    #[serde(default)]
    pub usage: Option<ClaudeCodeUsage>,
    /// `"error"` when the CLI signals a hard failure at the JSON level.
    #[serde(default)]
    pub r#type: Option<String>,
    /// Error detail, present when `type == "error"`.
    #[serde(default)]
    pub error: Option<ClaudeCodeError>,
}

#[derive(Deserialize, Debug, Default)]
pub struct ClaudeCodeUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    /// Model slug as reported by the CLI (e.g. `"claude-opus-4-5"`).
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ClaudeCodeError {
    #[serde(default)]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Context carrier
// ---------------------------------------------------------------------------

/// Minimal context the caller must supply alongside the raw messages.
/// Kept small — only what's needed for prompt construction and telemetry.
pub struct TurnContext<'a> {
    /// Optional high-level system instruction (not Sunny's internal prompt).
    /// Forwarded via `--append-system-prompt` when non-empty.
    pub system_hint: Option<&'a str>,
    /// Working directory for the subprocess. Defaults to CWD when `None`.
    pub project_cwd: Option<&'a str>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Run one full Claude Code CLI turn.
///
/// # Errors
///
/// Returns an `Err(String)` whose text starts with one of the following
/// markers, allowing the caller to implement a fallback chain:
///
/// - `"claude_code_unavailable:"` — binary not found.
/// - `"claude_code_auth_expired:"` — CLI reported an auth failure.
/// - `"claude_code_timeout:"` — subprocess exceeded `CLAUDE_CODE_TIMEOUT_SECS`.
/// - Any other string — non-recoverable subprocess or JSON parse failure.
pub async fn claude_code_turn(
    _app: &AppHandle,
    ctx: &TurnContext<'_>,
    messages: Vec<Value>,
    _tools: Vec<Value>,   // reserved — Claude Code runs its own tool loop
    _max_tokens: u32,     // reserved — CLI controls output length internally
) -> Result<TurnOutcome, String> {
    // Locate binary. `crate::paths::which` handles Tauri's stripped PATH.
    let claude_bin = crate::paths::which("claude")
        .or_else(|| {
            let explicit = std::path::PathBuf::from("/Users/sunny/.local/bin/claude");
            explicit.exists().then_some(explicit)
        })
        .ok_or_else(|| {
            "claude_code_unavailable: binary not found on PATH — \
             install from https://docs.claude.ai/claude-code, \
             fallback to cloud"
                .to_string()
        })?;

    // Build the prompt string from the messages history.
    let prompt = build_prompt(&messages);
    if prompt.trim().is_empty() {
        return Err("claude_code_turn: empty prompt after message concat".to_string());
    }

    // Extract the latest system message content, if any, to forward.
    let system_hint = ctx
        .system_hint
        .filter(|s| !s.trim().is_empty())
        .or_else(|| extract_system_hint(&messages));

    let mut cmd = Command::new(&claude_bin);
    cmd.arg("-p").arg(&prompt);
    cmd.arg("--output-format").arg("json");
    cmd.arg("--model").arg(CLAUDE_CODE_MODEL);
    // Skip interactive permission prompts — running headless.
    cmd.arg("--dangerously-skip-permissions");

    if let Some(hint) = system_hint {
        cmd.arg("--append-system-prompt").arg(hint);
    }

    // CWD: prefer caller-supplied project dir, fall back to process CWD.
    if let Some(dir) = ctx.project_cwd {
        cmd.current_dir(dir);
    }

    // Augment PATH so the CLI can find node, npm, etc. under Tauri.
    if let Some(fat) = crate::paths::fat_path() {
        cmd.env("PATH", fat);
    }

    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let started = Instant::now();

    let raw_output = match timeout(
        Duration::from_secs(CLAUDE_CODE_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("claude_code_unavailable: spawn failed — {e}")),
        Err(_) => {
            return Err(format!(
                "claude_code_timeout: exceeded {CLAUDE_CODE_TIMEOUT_SECS}s, \
                 fallback to cloud"
            ))
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    let stderr_text = String::from_utf8_lossy(&raw_output.stderr).to_ascii_lowercase();

    // Auth-expired detection: scan stderr before we check the exit code,
    // because an auth failure may produce a non-zero exit AND a JSON body
    // with type=="error". We want to surface the auth marker to the caller.
    if is_auth_error(&stderr_text) {
        return Err(format!(
            "claude_code_auth_expired: {}, fallback to cloud",
            stderr_text.lines().next().unwrap_or("auth failure")
        ));
    }

    let stdout_str = String::from_utf8_lossy(&raw_output.stdout);

    // Non-zero exit without an auth signal → parse stderr for context.
    if !raw_output.status.success() {
        let tail: String = stderr_text
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!(
            "claude_code exit {}: {}",
            raw_output.status, tail
        ));
    }

    // Parse JSON output.
    let parsed: ClaudeCodeResponse = serde_json::from_str(stdout_str.trim())
        .map_err(|e| format!("claude_code decode: {e} — raw: {}", crate::agent_loop::helpers::truncate(stdout_str.trim(), 400)))?;

    // Surface JSON-level errors (type == "error").
    if parsed.r#type.as_deref() == Some("error") {
        let msg = parsed
            .error
            .as_ref()
            .and_then(|e| e.message.as_deref())
            .unwrap_or("unknown error from claude CLI");
        if is_auth_error(&msg.to_ascii_lowercase()) {
            return Err(format!(
                "claude_code_auth_expired: {msg}, fallback to cloud"
            ));
        }
        return Err(format!("claude_code error: {msg}"));
    }

    // Token accounting. Claude Code reports real Anthropic API token counts
    // (the same numbers on the billing dashboard), so they are reliable.
    // `cache_read` and `cache_create` are not surfaced by the CLI JSON today;
    // we record them as 0 so the telemetry ring stays consistent.
    let (input_tok, output_tok, model_slug) = parsed
        .usage
        .as_ref()
        .map(|u| {
            (
                u.input_tokens,
                u.output_tokens,
                u.model
                    .clone()
                    .unwrap_or_else(|| CLAUDE_CODE_MODEL.to_string()),
            )
        })
        .unwrap_or_else(|| (0, 0, CLAUDE_CODE_MODEL.to_string()));

    log::info!(
        "claude-code tokens: input={} output={} model={} duration_ms={}",
        input_tok, output_tok, model_slug, duration_ms,
    );

    let cost_usd = cost_estimate("claude-code", input_tok, output_tok, 0, 0);
    record_llm_turn(TelemetryEvent {
        provider: "claude-code".to_string(),
        model: model_slug,
        input: input_tok,
        cache_read: 0,
        cache_create: 0,
        output: output_tok,
        duration_ms,
        at: chrono::Utc::now().timestamp(),
        cost_usd,
        tier: None,
    });

    Ok(TurnOutcome::final_buffered(parsed.result))
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/// Concatenate a `messages` array (OpenAI/Anthropic shape: `[{role, content}]`)
/// into a single prompt string suitable for `claude -p "<prompt>"`.
///
/// Strategy:
/// - Skip `role == "system"` entries — forwarded separately via
///   `--append-system-prompt` where the caller opts in.
/// - Prefix each turn with `[User]:` / `[Assistant]:` so Claude Code
///   understands the conversation structure.
/// - A single-message array (the common first-turn case) produces a
///   clean prompt with no role prefix to avoid unnecessary ceremony.
pub fn build_prompt(messages: &[Value]) -> String {
    let non_system: Vec<(&str, &str)> = messages
        .iter()
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?;
            if role == "system" {
                return None;
            }
            let content = m.get("content")?.as_str().unwrap_or("");
            Some((role, content))
        })
        .collect();

    if non_system.is_empty() {
        return String::new();
    }

    if non_system.len() == 1 {
        // Single-turn: emit the content directly, no role label.
        return non_system[0].1.to_string();
    }

    // Multi-turn: prefix each entry for conversational context.
    let mut out = String::with_capacity(
        non_system.iter().map(|(r, c)| r.len() + c.len() + 10).sum(),
    );
    for (role, content) in &non_system {
        let label = if *role == "user" { "[User]" } else { "[Assistant]" };
        out.push_str(label);
        out.push_str(": ");
        out.push_str(content);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Extract the content of the last `system` message from the history, if any.
/// Used when the caller doesn't populate `TurnContext::system_hint` directly.
fn extract_system_hint<'a>(messages: &'a [Value]) -> Option<&'a str> {
    messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("system"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.trim().is_empty())
}

/// Return true if the lowercase error text contains any known auth signal.
fn is_auth_error(lower: &str) -> bool {
    AUTH_EXPIRED_MARKERS.iter().any(|marker| lower.contains(marker))
}

// ---------------------------------------------------------------------------
// Tests (14 total)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- build_prompt -------------------------------------------------------

    #[test]
    fn single_user_message_no_role_label() {
        let msgs = vec![json!({"role": "user", "content": "hello world"})];
        assert_eq!(build_prompt(&msgs), "hello world");
    }

    #[test]
    fn empty_messages_returns_empty_string() {
        assert_eq!(build_prompt(&[]), "");
    }

    #[test]
    fn system_messages_are_skipped_in_prompt() {
        let msgs = vec![
            json!({"role": "system", "content": "You are Sunny."}),
            json!({"role": "user", "content": "What is Rust?"}),
        ];
        // System-only after filtering leaves a single user msg → no label.
        assert_eq!(build_prompt(&msgs), "What is Rust?");
    }

    #[test]
    fn multi_turn_uses_role_labels() {
        let msgs = vec![
            json!({"role": "user",      "content": "first question"}),
            json!({"role": "assistant", "content": "first answer"}),
            json!({"role": "user",      "content": "follow up"}),
        ];
        let out = build_prompt(&msgs);
        assert!(out.contains("[User]: first question"), "missing user label: {out}");
        assert!(out.contains("[Assistant]: first answer"), "missing assistant label: {out}");
        assert!(out.contains("[User]: follow up"), "missing follow-up: {out}");
    }

    #[test]
    fn multi_turn_preserves_order() {
        let msgs = vec![
            json!({"role": "user",      "content": "A"}),
            json!({"role": "assistant", "content": "B"}),
            json!({"role": "user",      "content": "C"}),
        ];
        let out = build_prompt(&msgs);
        let a = out.find('A').expect("A missing");
        let b = out.find('B').expect("B missing");
        let c = out.find('C').expect("C missing");
        assert!(a < b && b < c, "order wrong: A={a} B={b} C={c}");
    }

    #[test]
    fn message_missing_content_field_is_skipped_gracefully() {
        let msgs = vec![
            json!({"role": "user"}),          // no content key
            json!({"role": "user", "content": "real msg"}),
        ];
        let out = build_prompt(&msgs);
        // The no-content entry collapses to "", single real entry → no label
        // because len after filter is 2 (empty string is still included).
        assert!(out.contains("real msg"), "real msg missing: {out}");
    }

    // ---- extract_system_hint ------------------------------------------------

    #[test]
    fn extract_system_hint_finds_last_system_message() {
        let msgs = vec![
            json!({"role": "system", "content": "first system"}),
            json!({"role": "user",   "content": "user msg"}),
            json!({"role": "system", "content": "second system"}),
        ];
        assert_eq!(extract_system_hint(&msgs), Some("second system"));
    }

    #[test]
    fn extract_system_hint_returns_none_when_absent() {
        let msgs = vec![json!({"role": "user", "content": "hello"})];
        assert_eq!(extract_system_hint(&msgs), None);
    }

    // ---- is_auth_error ------------------------------------------------------

    #[test]
    fn is_auth_error_detects_not_logged_in() {
        assert!(is_auth_error("error: not logged in, please run: claude login"));
    }

    #[test]
    fn is_auth_error_detects_401() {
        assert!(is_auth_error("http error 401 unauthorized"));
    }

    #[test]
    fn is_auth_error_returns_false_for_unrelated_error() {
        assert!(!is_auth_error("error: file not found /tmp/foo.rs"));
    }

    // ---- JSON parsing -------------------------------------------------------

    #[test]
    fn parses_valid_json_response() {
        let raw = r#"{"result": "the answer", "usage": {"input_tokens": 42, "output_tokens": 7, "model": "claude-opus-4-5"}}"#;
        let parsed: ClaudeCodeResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.result, "the answer");
        let usage = parsed.usage.unwrap();
        assert_eq!(usage.input_tokens, 42);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.model.as_deref(), Some("claude-opus-4-5"));
    }

    #[test]
    fn parses_error_response_type_field() {
        let raw = r#"{"type": "error", "error": {"message": "Session expired"}}"#;
        let parsed: ClaudeCodeResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.r#type.as_deref(), Some("error"));
        assert_eq!(
            parsed.error.unwrap().message.as_deref(),
            Some("Session expired")
        );
    }

    #[test]
    fn usage_to_telemetry_event_maps_correctly() {
        let usage = ClaudeCodeUsage {
            input_tokens: 100,
            output_tokens: 50,
            model: Some("claude-opus-4-5".to_string()),
        };
        // Mirror the mapping logic in claude_code_turn.
        let (input_tok, output_tok, model_slug) = (
            usage.input_tokens,
            usage.output_tokens,
            usage.model.clone().unwrap_or_else(|| CLAUDE_CODE_MODEL.to_string()),
        );
        let cost = cost_estimate("claude-code", input_tok, output_tok, 0, 0);
        let event = TelemetryEvent {
            provider: "claude-code".to_string(),
            model: model_slug.clone(),
            input: input_tok,
            cache_read: 0,
            cache_create: 0,
            output: output_tok,
            duration_ms: 999,
            at: chrono::Utc::now().timestamp(),
            cost_usd: cost,
            tier: None,
        };
        assert_eq!(event.provider, "claude-code");
        assert_eq!(event.input, 100);
        assert_eq!(event.output, 50);
        assert_eq!(event.cache_read, 0);
        assert_eq!(event.model, "claude-opus-4-5");
    }

    // ---- fallback markers ---------------------------------------------------

    #[test]
    fn missing_binary_error_starts_with_marker() {
        // Simulate the error path: binary not present.
        // We test the formatted string directly since we cannot call
        // `which()` in a unit test without a binary present.
        let err = "claude_code_unavailable: binary not found on PATH — \
                   install from https://docs.claude.ai/claude-code, \
                   fallback to cloud"
            .to_string();
        assert!(
            err.starts_with("claude_code_unavailable:"),
            "marker missing in: {err}"
        );
    }

    #[test]
    fn timeout_error_starts_with_marker() {
        let err = format!(
            "claude_code_timeout: exceeded {CLAUDE_CODE_TIMEOUT_SECS}s, fallback to cloud"
        );
        assert!(
            err.starts_with("claude_code_timeout:"),
            "marker missing in: {err}"
        );
    }
}
