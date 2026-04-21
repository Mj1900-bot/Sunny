//! # Dynamic context windowing
//!
//! Extracted from `core.rs` so the state-machine driver stays focused.
//! When prior history + system block would exceed the user-configured
//! `contextBudget`, we drop blocks using importance-weighted scoring
//! (rather than naively oldest-first) until the conversation fits.
//!
//! ## Scoring summary
//!
//! | Block                                         | Score |
//! |-----------------------------------------------|-------|
//! | First user turn (original goal)               | 1000  |
//! | Tool block referenced downstream              | 800   |
//! | Message with error envelope                   | 700   |
//! | Plain user message                            | 400   |
//! | Ordinary assistant prose                      | 300   |
//! | Unreferenced tool block                       | 200   |
//! | Repeated tool output (same name seen before)  | 100   |
//! | Assistant "thinking out loud"                 | 50    |
//!
//! Dropped runs are replaced with a short
//! `[truncated: N messages, ~T tokens]` marker so the model knows context
//! was elided.
//!
//! Token estimation is `chars / 4` — conservative rail, not exact.

pub mod score;
pub mod truncate;

use serde_json::Value;
use super::core::{DEFAULT_CONTEXT_BUDGET_TOKENS};

// ---------------------------------------------------------------------------
// Budget loading (public, used by core.rs)
// ---------------------------------------------------------------------------

/// Resolve the context budget (in tokens) for this process. Preference order:
///   1. `SUNNY_CONTEXT_BUDGET` env var — per-run override for experiments.
///   2. `contextBudget` in `~/.sunny/settings.json` — the user's configured
///      default from the Settings → Models UI.
///   3. `DEFAULT_CONTEXT_BUDGET_TOKENS` — safe compile-time fallback.
pub fn load_context_budget_tokens() -> usize {
    if let Ok(raw) = std::env::var("SUNNY_CONTEXT_BUDGET") {
        if let Ok(n) = raw.trim().parse::<usize>() {
            if n >= 1024 {
                return n;
            }
        }
    }
    if let Ok(value) = crate::settings::load() {
        if let Some(obj) = value.as_object() {
            if let Some(n) = obj
                .get("contextBudget")
                .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
            {
                let as_usize = n as usize;
                if as_usize >= 1024 {
                    return as_usize;
                }
            }
        }
    }
    DEFAULT_CONTEXT_BUDGET_TOKENS as usize
}

// ---------------------------------------------------------------------------
// Wire-format helpers (shared by score.rs, truncate.rs, and tests)
// ---------------------------------------------------------------------------

/// True if the given assistant message initiates a tool call.
///
/// Covers both wire formats:
///   * Anthropic: `content` array with `{"type":"tool_use", ...}` block.
///   * Ollama / GLM (OpenAI-compatible): top-level `tool_calls` non-empty array.
pub(crate) fn is_tool_use_assistant(msg: &Value) -> bool {
    if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return false;
    }
    if msg
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .is_some_and(|arr| !arr.is_empty())
    {
        return true;
    }
    if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
        if arr
            .iter()
            .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        {
            return true;
        }
    }
    false
}

/// True if `msg` is a tool-result message that MUST follow a tool_use
/// assistant. Anthropic: `role:"user"` with `type:"tool_result"` content
/// items. OpenAI-compatible: `role:"tool"`.
pub(crate) fn is_tool_result_message(msg: &Value) -> bool {
    let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
    if role == "tool" {
        return true;
    }
    if role == "user" {
        if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
            return arr
                .iter()
                .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
        }
    }
    false
}

/// Rough char count for a single message.
pub(crate) fn estimate_message_chars(msg: &Value) -> usize {
    serde_json::to_string(msg)
        .map(|s| s.chars().count())
        .unwrap_or(4096)
}

/// Group `history` into atomic "blocks" that can be dropped or kept as a
/// unit without breaking wire-format invariants.
///
/// A block is either:
///   1. A single plain user or assistant message.
///   2. A tool-use assistant followed by its contiguous run of
///      tool-result messages.
pub(crate) fn group_into_blocks(history: &[Value]) -> Vec<std::ops::Range<usize>> {
    let mut blocks: Vec<std::ops::Range<usize>> = Vec::new();
    let mut i = 0;
    while i < history.len() {
        let start = i;
        if is_tool_use_assistant(&history[i]) {
            let mut j = i + 1;
            while j < history.len() && is_tool_result_message(&history[j]) {
                j += 1;
            }
            blocks.push(start..j);
            i = j;
        } else {
            blocks.push(start..start + 1);
            i = start + 1;
        }
    }
    blocks
}

// ---------------------------------------------------------------------------
// Public entry point: re-export importance-weighted truncation as
// `truncate_history` so call sites in core.rs need no changes.
// ---------------------------------------------------------------------------

/// Truncate `history` so that `system_chars + total_history_chars` stays
/// under `budget_tokens * 4`. Uses importance-weighted scoring to preserve
/// high-value blocks (first user turn, error envelopes, referenced tool
/// results) and drops low-value blocks (repeated tool outputs, assistant
/// thinking-out-loud) first.
///
/// Dropped runs are replaced by a short `[truncated: …]` marker message.
/// Returns a freshly allocated `Vec<Value>` — the input is consumed but
/// never mutated in place.
pub fn truncate_history(
    history: Vec<Value>,
    system_chars: usize,
    budget_tokens: usize,
) -> Vec<Value> {
    truncate::truncate_by_importance(history, system_chars, budget_tokens)
}

// ---------------------------------------------------------------------------
// Tests for helpers in this module
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_tool_use_assistant_detects_both_formats() {
        let anth = json!({"role": "assistant", "content": [
            {"type": "tool_use", "id": "a", "name": "x", "input": {}}
        ]});
        let ollama = json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{"id": "c1"}],
        });
        let plain = json!({"role": "assistant", "content": "hello"});
        let user = json!({"role": "user", "content": "hi"});

        assert!(is_tool_use_assistant(&anth));
        assert!(is_tool_use_assistant(&ollama));
        assert!(!is_tool_use_assistant(&plain));
        assert!(!is_tool_use_assistant(&user));
    }

    #[test]
    fn is_tool_result_message_detects_both_formats() {
        let anth = json!({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "r"}
        ]});
        let ollama = json!({"role": "tool", "name": "search", "content": "r"});
        let plain_user = json!({"role": "user", "content": "hi"});
        let assistant = json!({"role": "assistant", "content": "hi"});

        assert!(is_tool_result_message(&anth));
        assert!(is_tool_result_message(&ollama));
        assert!(!is_tool_result_message(&plain_user));
        assert!(!is_tool_result_message(&assistant));
    }

    #[test]
    fn group_into_blocks_pairs_anthropic_tool_cycle() {
        let history = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "x", "input": {}}
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "r"}
            ]}),
            json!({"role": "assistant", "content": "done"}),
        ];
        let blocks = group_into_blocks(&history);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0], 0..1);
        assert_eq!(blocks[1], 1..3);
        assert_eq!(blocks[2], 3..4);
    }

    #[test]
    fn group_into_blocks_pairs_ollama_tool_cycle() {
        let history = vec![
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{"id": "c1"}],
            }),
            json!({"role": "tool", "name": "search", "content": "r"}),
            json!({"role": "assistant", "content": "ok"}),
        ];
        let blocks = group_into_blocks(&history);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], 0..2);
        assert_eq!(blocks[1], 2..3);
    }

    #[test]
    fn truncate_history_noop_when_under_budget() {
        let history = vec![
            json!({"role": "user", "content": "hello"}),
            json!({"role": "assistant", "content": "hi there"}),
        ];
        let original = history.clone();
        let out = truncate_history(history, 0, 32_000);
        assert_eq!(out, original);
    }

    #[test]
    fn truncate_history_drops_until_fit() {
        // 50 plain pairs + current turn = 101 messages
        let mut history = Vec::new();
        history.push(json!({"role": "user", "content": "initial goal message here"}));
        for i in 0..49 {
            history.push(json!({"role": "user",
                "content": format!("user message {:03} padded with filler text here", i)}));
            history.push(json!({"role": "assistant",
                "content": format!("asst reply {:03} padded with filler text here", i)}));
        }
        history.push(json!({"role": "user", "content": "current question under test"}));
        let original_len = history.len();

        let out = truncate_history(history, 0, 500);

        assert!(out.len() < original_len, "expected truncation");

        // Current user turn must still be last
        let last = out.last().expect("non-empty");
        assert_eq!(last["role"], "user");
        assert_eq!(last["content"], "current question under test");
    }

    #[test]
    fn truncate_history_keeps_tool_use_with_tool_result() {
        let history = vec![
            json!({"role": "user", "content": "x".repeat(500)}),
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": "tu_1", "name": "search", "input": {}}
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "tu_1", "content": "body"}
            ]}),
            json!({"role": "assistant", "content": "final"}),
            json!({"role": "user", "content": "current"}),
        ];

        let out = truncate_history(history, 0, 256);
        for (i, msg) in out.iter().enumerate() {
            if is_tool_result_message(msg) {
                assert!(i > 0, "tool_result cannot be first message");
                assert!(
                    is_tool_use_assistant(&out[i - 1]),
                    "tool_result at {i} missing paired tool_use",
                );
            }
        }
    }

    #[test]
    fn truncate_history_ollama_tool_pair_atomic() {
        let history = vec![
            json!({"role": "user", "content": "y".repeat(500)}),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{"id": "c1", "function": {"name": "search"}}],
            }),
            json!({"role": "tool", "name": "search", "content": "result body"}),
            json!({"role": "assistant", "content": "answer"}),
            json!({"role": "user", "content": "now"}),
        ];
        let out = truncate_history(history, 0, 200);
        for (i, msg) in out.iter().enumerate() {
            if is_tool_result_message(msg) {
                assert!(
                    i > 0 && is_tool_use_assistant(&out[i - 1]),
                    "role:tool at {i} without preceding tool_calls assistant",
                );
            }
        }
    }
}
