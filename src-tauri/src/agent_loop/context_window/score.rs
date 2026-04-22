//! # Block importance scoring
//!
//! Each atomic "block" (a single message, or a tool_use + its results) gets a
//! numeric importance score that drives which blocks are dropped first when
//! the conversation exceeds the context budget.
//!
//! ## Scoring table
//!
//! | Block type                                          | Score |
//! |-----------------------------------------------------|-------|
//! | System message (handled upstream, never in history) | ∞     |
//! | First user turn (the original goal)                 | 1000  |
//! | Tool block whose result is referenced downstream    | 800   |
//! | Message containing an error envelope                | 700   |
//! | Regular user message                                | 400   |
//! | Regular assistant message (reasoning / prose)       | 300   |
//! | Tool block whose result is NOT referenced later     | 200   |
//! | Repeated tool output (same tool called before)      | 100   |
//! | Assistant "thinking out loud" (no downstream ref)   | 50    |

use serde_json::Value;

/// Score assigned to the first user turn — the original goal statement.
pub const SCORE_FIRST_USER_TURN: u32 = 1000;
/// Tool block whose results are referenced by a later assistant message.
pub const SCORE_TOOL_REFERENCED: u32 = 800;
/// Message that contains an error envelope (future attempts need history).
pub const SCORE_ERROR_ENVELOPE: u32 = 700;
/// Ordinary user message (not the first).
pub const SCORE_USER_PLAIN: u32 = 400;
/// Ordinary assistant prose message.
pub const SCORE_ASSISTANT_PLAIN: u32 = 300;
/// Tool block with no downstream reference.
pub const SCORE_TOOL_UNREFERENCED: u32 = 200;
/// Repeated tool output (same tool name appeared in an earlier block).
pub const SCORE_TOOL_REPEATED: u32 = 100;
/// Assistant "thinking out loud" block with no downstream reference.
pub const SCORE_ASSISTANT_THINKING: u32 = 50;

// ---------------------------------------------------------------------------
// Error-envelope detection
// ---------------------------------------------------------------------------

/// Returns true when the message JSON contains common error-envelope patterns:
///   - A top-level `"error"` object with a `"type"` or `"message"` field.
///   - A content-array item with `"type":"tool_result"` whose content
///     contains an `"is_error": true` field or the string `"error"` in its
///     text.
///   - A top-level `"is_error": true` flag.
pub(super) fn contains_error_envelope(msg: &Value) -> bool {
    // Top-level error object (Anthropic API error)
    if let Some(err) = msg.get("error") {
        if err.is_object()
            && (err.get("type").is_some() || err.get("message").is_some())
        {
            return true;
        }
    }
    // is_error flag
    if msg.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
        return true;
    }
    // Tool-result content with error
    if let Some(content) = msg.get("content") {
        if let Some(arr) = content.as_array() {
            for item in arr {
                if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    if item.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
                        return true;
                    }
                    // error text in nested content
                    if let Some(inner) = item.get("content") {
                        let text = match inner {
                            Value::String(s) => s.to_lowercase(),
                            Value::Array(arr) => arr
                                .iter()
                                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(" ")
                                .to_lowercase(),
                            _ => String::new(),
                        };
                        if text.contains("error") || text.contains("failed") || text.contains("exception") {
                            return true;
                        }
                    }
                }
            }
        }
        // Plain string content with error marker
        if let Some(s) = content.as_str() {
            let lower = s.to_lowercase();
            if lower.starts_with("error:") || lower.starts_with("{\"error\"") {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tool-id reference tracking
// ---------------------------------------------------------------------------

/// Extract tool-result IDs referenced within a message (the `tool_use_id`
/// fields in Anthropic tool_result blocks).
pub(super) fn tool_result_ids_in_msg(msg: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                if let Some(id) = item.get("tool_use_id").and_then(|i| i.as_str()) {
                    ids.push(id.to_owned());
                }
            }
        }
    }
    ids
}

/// Extract the tool name from an assistant tool_use block (first one found).
pub(super) fn tool_name_in_block(msgs: &[Value]) -> Option<String> {
    for msg in msgs {
        if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
            for item in arr {
                if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                        return Some(name.to_owned());
                    }
                }
            }
        }
        // Ollama
        if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
            if let Some(call) = calls.first() {
                if let Some(name) = call
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                {
                    return Some(name.to_owned());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Assistant "thinking out loud" heuristic
// ---------------------------------------------------------------------------

/// Returns true when an assistant message is reasoning / thinking with no
/// downstream reference — a long prose block that isn't a tool call and
/// isn't the final answer turn.
///
/// Heuristic: plain assistant text that is NOT the last assistant message,
/// is longer than 200 chars, and contains hedging language patterns.
pub(super) fn is_thinking_out_loud(msg: &Value, is_last_assistant: bool) -> bool {
    if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return false;
    }
    if is_last_assistant {
        return false;
    }
    let text = match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return false,
    };
    if text.len() < 200 {
        return false;
    }
    // Hedging / internal-reasoning markers
    let lower = text.to_lowercase();
    lower.contains("let me think")
        || lower.contains("hmm,")
        || lower.contains("i need to")
        || lower.contains("let me consider")
        || lower.contains("actually,")
        || lower.contains("wait,")
        || lower.contains("on second thought")
        || lower.contains("i wonder")
}

// ---------------------------------------------------------------------------
// Public scoring entry point
// ---------------------------------------------------------------------------

/// Compute an importance score for every block in `blocks`. `history` is the
/// full original message slice. `block_idx` is the 0-based index within the
/// blocks vec (used to detect the first user turn).
pub fn score_blocks(
    history: &[Value],
    blocks: &[std::ops::Range<usize>],
) -> Vec<u32> {
    // We need to know:
    //   1. Which tool-use IDs are referenced by later tool-result messages.
    //   2. Which tool names have appeared in earlier blocks (for repeat detection).
    //   3. Index of the last assistant message (for thinking heuristic).

    // Collect all tool-result references across the entire history
    let all_result_refs: std::collections::HashSet<String> = history
        .iter()
        .flat_map(|m| tool_result_ids_in_msg(m))
        .collect();

    // Find the index of the last assistant message in history
    let last_assistant_idx = history
        .iter()
        .enumerate()
        .rev()
        .find(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
        .map(|(i, _)| i);

    let mut seen_tool_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut scores = Vec::with_capacity(blocks.len());

    for (bi, block) in blocks.iter().enumerate() {
        let msgs = &history[block.clone()];
        let first_msg = &msgs[0];
        let role = first_msg.get("role").and_then(|r| r.as_str()).unwrap_or("");

        let score = if bi == 0
            && role == "user"
            && !crate::agent_loop::context_window::is_tool_result_message(first_msg)
        {
            // First user turn — the original goal. Never drop (score is very
            // high; the actual "never drop" guard is in truncate.rs).
            SCORE_FIRST_USER_TURN
        } else if crate::agent_loop::context_window::is_tool_use_assistant(first_msg) {
            // Tool block: check error, repetition, and downstream reference
            let is_repeated = if let Some(name) = tool_name_in_block(msgs) {
                let repeated = seen_tool_names.contains(&name);
                seen_tool_names.insert(name);
                repeated
            } else {
                false
            };

            let has_error = msgs.iter().any(contains_error_envelope);

            // Check if this block's tool_use IDs are referenced by result messages
            let tool_ids: Vec<String> = msgs
                .iter()
                .flat_map(|m| {
                    // Collect IDs from assistant tool_use content
                    let mut ids = Vec::new();
                    if let Some(arr) = m.get("content").and_then(|c| c.as_array()) {
                        for item in arr {
                            if item.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                                    ids.push(id.to_owned());
                                }
                            }
                        }
                    }
                    if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
                        for call in calls {
                            if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                                ids.push(id.to_owned());
                            }
                        }
                    }
                    ids
                })
                .collect();

            let is_referenced = tool_ids.iter().any(|id| all_result_refs.contains(id));

            if has_error {
                SCORE_ERROR_ENVELOPE
            } else if is_repeated {
                SCORE_TOOL_REPEATED
            } else if is_referenced {
                SCORE_TOOL_REFERENCED
            } else {
                SCORE_TOOL_UNREFERENCED
            }
        } else if role == "assistant" {
            let is_last_asst = last_assistant_idx
                .map(|idx| block.contains(&idx))
                .unwrap_or(false);
            let has_error = msgs.iter().any(contains_error_envelope);
            if has_error {
                SCORE_ERROR_ENVELOPE
            } else if is_thinking_out_loud(first_msg, is_last_asst) {
                SCORE_ASSISTANT_THINKING
            } else {
                SCORE_ASSISTANT_PLAIN
            }
        } else {
            // Plain user message (not first, not tool_result)
            let has_error = msgs.iter().any(contains_error_envelope);
            if has_error {
                SCORE_ERROR_ENVELOPE
            } else {
                SCORE_USER_PLAIN
            }
        };

        scores.push(score);
    }

    scores
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_user_turn_gets_max_score() {
        let history = vec![
            json!({"role": "user", "content": "Hello, please help me build X"}),
            json!({"role": "assistant", "content": "Sure!"}),
        ];
        let blocks = crate::agent_loop::context_window::group_into_blocks(&history);
        let scores = score_blocks(&history, &blocks);
        assert_eq!(scores[0], SCORE_FIRST_USER_TURN);
    }

    #[test]
    fn error_envelope_detected_in_tool_result() {
        let msg = json!({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "t1",
                    "is_error": true,
                    "content": "Permission denied"
                }
            ]
        });
        assert!(contains_error_envelope(&msg));
    }

    #[test]
    fn error_envelope_not_detected_in_clean_result() {
        let msg = json!({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "t1",
                    "content": "file contents here"
                }
            ]
        });
        assert!(!contains_error_envelope(&msg));
    }

    #[test]
    fn thinking_out_loud_detected() {
        let msg = json!({
            "role": "assistant",
            "content": "Let me think about this carefully. I need to consider the various ways this could work. Actually, the second approach seems better because it avoids the issue with the first one. Let me consider the trade-offs more carefully before deciding."
        });
        assert!(is_thinking_out_loud(&msg, false));
        // Should NOT flag the last assistant message
        assert!(!is_thinking_out_loud(&msg, true));
    }

    #[test]
    fn repeated_tool_name_gets_lower_score() {
        // Two consecutive ls-style tool blocks, second should be SCORE_TOOL_REPEATED
        let history = vec![
            json!({"role": "user", "content": "start"}),
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "list_dir", "input": {}}
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "a b c"}
            ]}),
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": "t2", "name": "list_dir", "input": {}}
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t2", "content": "a b c"}
            ]}),
            json!({"role": "assistant", "content": "done"}),
        ];
        let blocks = crate::agent_loop::context_window::group_into_blocks(&history);
        let scores = score_blocks(&history, &blocks);
        // block 0: first user → SCORE_FIRST_USER_TURN
        // block 1: tool block t1, first list_dir → SCORE_TOOL_UNREFERENCED (or REFERENCED)
        // block 2: tool block t2, repeated list_dir → SCORE_TOOL_REPEATED
        // block 3: plain assistant
        assert_eq!(scores[2], SCORE_TOOL_REPEATED);
    }
}
