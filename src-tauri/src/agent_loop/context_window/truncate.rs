//! # Importance-weighted context truncation
//!
//! Replaces the old "drop oldest first" strategy with a scored approach:
//!
//! 1. Group history into atomic blocks (never split a tool_use + tool_result).
//! 2. Score each block via `score::score_blocks`.
//! 3. While over budget: drop the lowest-scored block that is NOT the first
//!    user turn. Ties broken by index (older messages dropped before newer).
//! 4. Replace each dropped contiguous run with a single
//!    `[truncated: N messages, ~T tokens]` marker injected as an assistant
//!    message so the model sees the elision.
//!
//! The output is always a freshly-allocated `Vec<Value>` — the input is
//! never mutated.

use serde_json::{json, Value};

use super::super::core::{MIN_TAIL_MESSAGES};
use super::{estimate_message_chars, group_into_blocks};
use super::score::score_blocks;

/// Build a truncation-marker message that replaces a dropped run of blocks.
///
/// Inserting a short assistant message with the marker keeps the LLM aware
/// that context was elided, which prevents it from hallucinating that earlier
/// tool results or reasoning still apply.
fn make_truncation_marker(dropped_message_count: usize, dropped_chars: usize) -> Value {
    let approx_tokens = dropped_chars / 4;
    json!({
        "role": "assistant",
        "content": format!(
            "[truncated: {} message{}, ~{} tokens]",
            dropped_message_count,
            if dropped_message_count == 1 { "" } else { "s" },
            approx_tokens,
        )
    })
}

/// Importance-weighted truncation.
///
/// Drops the lowest-importance blocks first (never splitting tool_use /
/// tool_result pairs and never dropping the first user turn) until the
/// history fits within `available_chars`. Replaces each contiguous run of
/// dropped blocks with a single `[truncated: …]` marker message.
///
/// Returns a newly allocated `Vec<Value>` — the input is consumed but not
/// mutated in place.
pub fn truncate_by_importance(
    history: Vec<Value>,
    system_chars: usize,
    budget_tokens: usize,
) -> Vec<Value> {
    let budget_chars = budget_tokens.saturating_mul(4);
    let system_chars_adjusted = (system_chars as f64 * 1.1) as usize;
    let available = budget_chars.saturating_sub(system_chars_adjusted);

    let per_msg_chars: Vec<usize> = history.iter().map(estimate_message_chars).collect();
    let total: usize = per_msg_chars.iter().sum();

    if total <= available {
        return history;
    }

    let blocks = group_into_blocks(&history);
    if blocks.len() <= 1 {
        log::warn!(
            "truncate_by_importance: single-block history ({} chars) over budget ({} chars) — keeping whole",
            total,
            available,
        );
        return history;
    }

    // Score every block
    let scores = score_blocks(&history, &blocks);

    // Determine the minimum tail we must preserve (index of first kept tail
    // block). Walk from the end collecting MIN_TAIL_MESSAGES.
    let tail_start_block = {
        let mut covered = 0usize;
        let mut idx = blocks.len();
        for (bi, block) in blocks.iter().enumerate().rev() {
            covered += block.len();
            idx = bi;
            if covered >= MIN_TAIL_MESSAGES {
                break;
            }
        }
        idx
    };

    // Build a mutable "keep" mask (true = keep, false = drop).
    let mut keep: Vec<bool> = vec![true; blocks.len()];

    // Running char total for non-dropped blocks
    let block_chars: Vec<usize> = blocks
        .iter()
        .map(|r| per_msg_chars[r.clone()].iter().sum())
        .collect();

    let mut current_chars: usize = block_chars.iter().sum();

    // Marker overhead: a short JSON string, about 80 chars
    const MARKER_CHARS: usize = 80;

    // Candidates for dropping: blocks before the tail start, except the
    // first user turn (block index 0 when it is a plain user message).
    while current_chars > available {
        // Find the droppable block with the lowest score (break ties by
        // preferring older/lower index).
        let candidate = blocks[..tail_start_block]
            .iter()
            .enumerate()
            .filter(|(bi, _)| {
                keep[*bi]
                    && *bi != 0 // never drop first user turn
                    && {
                        // Don't drop tail-protected blocks
                        *bi < tail_start_block
                    }
            })
            .min_by_key(|(bi, _)| (scores[*bi], *bi));

        match candidate {
            None => {
                // Nothing more can be dropped
                log::warn!(
                    "truncate_by_importance: exhausted candidates, {} chars still over budget {}",
                    current_chars,
                    available,
                );
                break;
            }
            Some((bi, _)) => {
                keep[bi] = false;
                // Subtract block chars, add marker overhead once per
                // contiguous dropped run (approximation: subtract block,
                // add marker size — merge logic below handles exact count).
                current_chars = current_chars
                    .saturating_sub(block_chars[bi])
                    .saturating_add(MARKER_CHARS);
            }
        }
    }

    // Reconstruct the output, merging contiguous dropped runs into single
    // markers. Also correctly account for marker tokens in the final log.
    let mut result: Vec<Value> = Vec::with_capacity(history.len());
    let mut drop_run_msgs = 0usize;
    let mut drop_run_chars = 0usize;

    let flush_marker = |result: &mut Vec<Value>, msgs: usize, chars: usize| {
        if msgs > 0 {
            result.push(make_truncation_marker(msgs, chars));
        }
    };

    for (bi, block) in blocks.iter().enumerate() {
        if keep[bi] {
            // Flush any pending drop run first
            flush_marker(&mut result, drop_run_msgs, drop_run_chars);
            drop_run_msgs = 0;
            drop_run_chars = 0;

            for idx in block.clone() {
                result.push(history[idx].clone());
            }
        } else {
            drop_run_msgs += block.len();
            drop_run_chars += block_chars[bi];
        }
    }
    // Flush trailing drop run (shouldn't happen since tail is always kept)
    flush_marker(&mut result, drop_run_msgs, drop_run_chars);

    let kept_chars: usize = result.iter().map(estimate_message_chars).sum();
    let dropped_blocks = keep.iter().filter(|&&k| !k).count();

    log::info!(
        "truncate_by_importance: dropped {} block(s), kept {} messages, ~{} chars (budget {} chars, system {} chars)",
        dropped_blocks,
        result.len(),
        kept_chars,
        available,
        system_chars,
    );

    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::agent_loop::context_window::{is_tool_use_assistant, is_tool_result_message};

    // -----------------------------------------------------------------------
    // Helper: build a history with controllable sizes
    // -----------------------------------------------------------------------

    /// Plain user + assistant pairs. Each pair is padded to ~100 chars each.
    fn plain_pair(i: usize) -> Vec<Value> {
        vec![
            json!({"role": "user",
                   "content": format!("user turn {:03} filler padding padding padding pad", i)}),
            json!({"role": "assistant",
                   "content": format!("asst turn {:03} filler padding padding padding pad", i)}),
        ]
    }

    /// A tool-use block (assistant tool_use + user tool_result).
    fn tool_block(name: &str, id: &str) -> Vec<Value> {
        vec![
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": id, "name": name, "input": {}}
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": id, "content": "some output data here"}
            ]}),
        ]
    }

    /// An error tool-result block.
    fn error_tool_block(id: &str) -> Vec<Value> {
        vec![
            json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": id, "name": "run_cmd", "input": {}}
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": id, "is_error": true,
                 "content": "Permission denied: /etc/passwd"}
            ]}),
        ]
    }

    /// A "thinking out loud" assistant message.
    fn thinking_msg() -> Value {
        json!({"role": "assistant", "content":
            "Let me think about this problem carefully. I need to consider all \
             the angles. Actually, there are several approaches I could take. \
             Hmm, let me think through each one. On second thought, the third \
             approach seems cleaner because it avoids the mutation issue. I wonder \
             if there are edge cases I have not thought of yet. Let me think more."
        })
    }

    // -----------------------------------------------------------------------
    // Required test (a): first user turn is preserved under aggressive truncation
    // -----------------------------------------------------------------------

    #[test]
    fn first_user_turn_preserved_under_aggressive_truncation() {
        let first_goal = json!({
            "role": "user",
            "content": "Original goal: build me a rocket ship with 50 subsystems"
        });

        let mut history = vec![first_goal.clone()];
        // Add 20 filler pairs
        for i in 0..20 {
            history.extend(plain_pair(i));
        }
        history.push(json!({"role": "user", "content": "current question"}));

        // Budget so tight only a handful of messages can survive
        let out = truncate_by_importance(history, 0, 200);

        let first = out.first().expect("output must be non-empty");
        // First message should be the original goal (not a marker)
        assert_eq!(
            first["content"].as_str().unwrap_or(""),
            first_goal["content"].as_str().unwrap_or("x"),
            "first user turn must be preserved"
        );
    }

    // -----------------------------------------------------------------------
    // Required test (b): error envelopes outlive thinking-out-loud messages
    // -----------------------------------------------------------------------

    #[test]
    fn error_envelopes_outlive_thinking_messages() {
        let mut history = Vec::new();
        history.push(json!({"role": "user", "content": "start task please now"}));

        // Thinking-out-loud assistant block (low score)
        history.push(thinking_msg());

        // Error tool block (high score)
        history.extend(error_tool_block("err1"));

        // More filler to push over budget
        for i in 0..15 {
            history.extend(plain_pair(i));
        }
        history.push(json!({"role": "user", "content": "what next"}));

        // Half budget: forces significant drops
        let total_chars: usize = history.iter().map(estimate_message_chars).sum();
        let half_budget_tokens = total_chars / 8; // aggressive cut

        let out = truncate_by_importance(history, 0, half_budget_tokens);

        // The thinking message content should NOT appear
        let has_thinking = out.iter().any(|m| {
            m["content"]
                .as_str()
                .map(|s| s.contains("Let me think"))
                .unwrap_or(false)
        });

        // The error tool result should appear
        let has_error = out.iter().any(|m| {
            if let Some(arr) = m["content"].as_array() {
                arr.iter().any(|item| {
                    item.get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                })
            } else {
                false
            }
        });

        assert!(
            !has_thinking || has_error,
            "error envelopes must outlive thinking-out-loud messages: has_thinking={has_thinking}, has_error={has_error}"
        );
    }

    // -----------------------------------------------------------------------
    // Required test (c): output is always under budget
    // -----------------------------------------------------------------------

    #[test]
    fn output_is_always_under_budget() {
        let mut history = vec![
            json!({"role": "user", "content": "initial goal for the session"}),
        ];
        for i in 0..30 {
            history.extend(plain_pair(i));
            if i % 5 == 0 {
                history.extend(tool_block("search", &format!("t{i}")));
            }
        }
        history.push(json!({"role": "user", "content": "final question"}));

        let total_chars: usize = history.iter().map(estimate_message_chars).sum();
        // Use a budget that's 40% of full size → forces real truncation
        let budget_tokens = (total_chars / 4) * 2 / 5;

        let out = truncate_by_importance(history, 0, budget_tokens);

        let out_chars: usize = out.iter().map(estimate_message_chars).sum();
        let available = budget_tokens.saturating_mul(4);

        assert!(
            out_chars <= available,
            "output chars {out_chars} must be <= budget chars {available}"
        );
    }

    // -----------------------------------------------------------------------
    // Required test (d): marker message inserted with accurate count
    // -----------------------------------------------------------------------

    #[test]
    fn truncation_marker_inserted_with_accurate_count() {
        let mut history = vec![
            json!({"role": "user", "content": "please help me with the task here"}),
        ];
        // Add filler pairs that will be dropped
        for i in 0..20 {
            history.extend(plain_pair(i));
        }
        history.push(json!({"role": "user", "content": "now what"}));

        let total_chars: usize = history.iter().map(estimate_message_chars).sum();
        let budget_tokens = (total_chars / 4) / 3; // force aggressive cut

        let out = truncate_by_importance(history, 0, budget_tokens);

        // Find any truncation marker
        let marker = out.iter().find(|m| {
            m["content"]
                .as_str()
                .map(|s| s.starts_with("[truncated:"))
                .unwrap_or(false)
        });

        assert!(
            marker.is_some(),
            "at least one truncation marker must be present when context is dropped"
        );

        let marker_text = marker.unwrap()["content"].as_str().unwrap();
        // Verify it contains a message count and token estimate
        assert!(
            marker_text.contains("message"),
            "marker must mention message count: {marker_text}"
        );
        assert!(
            marker_text.contains("tokens"),
            "marker must mention token estimate: {marker_text}"
        );

        // Parse out the message count from the marker and verify it's > 0
        // Format: "[truncated: N message(s), ~T tokens]"
        let count_str = marker_text
            .trim_start_matches("[truncated: ")
            .split_whitespace()
            .next()
            .unwrap_or("0");
        let count: usize = count_str.parse().unwrap_or(0);
        assert!(count > 0, "marker count must be > 0, got: {marker_text}");
    }

    // -----------------------------------------------------------------------
    // Additional: tool_use/tool_result pairs remain atomic
    // -----------------------------------------------------------------------

    #[test]
    fn tool_use_result_pairs_remain_atomic() {
        let mut history = vec![
            json!({"role": "user", "content": "do the task please help me"}),
        ];
        // Many filler pairs to force truncation
        for i in 0..20 {
            history.extend(plain_pair(i));
        }
        // Add a tool block in the middle
        history.extend(tool_block("read_file", "tf1"));
        history.push(json!({"role": "assistant", "content": "final answer here"}));
        history.push(json!({"role": "user", "content": "current"}));

        let out = truncate_by_importance(history, 0, 300);

        // If tool_result appears, tool_use must immediately precede it
        for (i, msg) in out.iter().enumerate() {
            if is_tool_result_message(msg) {
                assert!(
                    i > 0 && is_tool_use_assistant(&out[i - 1]),
                    "tool_result at position {i} must be immediately preceded by tool_use"
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // Additional: noop when under budget
    // -----------------------------------------------------------------------

    #[test]
    fn noop_when_under_budget() {
        let history = vec![
            json!({"role": "user", "content": "hello"}),
            json!({"role": "assistant", "content": "hi there"}),
        ];
        let original = history.clone();
        let out = truncate_by_importance(history, 0, 32_000);
        assert_eq!(out, original);
    }

    // -----------------------------------------------------------------------
    // Additional: repeated tool blocks dropped before unique ones
    // -----------------------------------------------------------------------

    #[test]
    fn repeated_tool_dropped_before_unique() {
        let mut history = vec![
            json!({"role": "user", "content": "start task with repeated tool calls here"}),
        ];
        // Two list_dir calls (second is repeat)
        history.extend(tool_block("list_dir", "ld1"));
        history.extend(tool_block("list_dir", "ld2")); // repeat
        // One unique read_file call
        history.extend(tool_block("read_file", "rf1"));
        // Filler to push over budget
        for i in 0..10 {
            history.extend(plain_pair(i));
        }
        history.push(json!({"role": "user", "content": "current question now"}));

        let total_chars: usize = history.iter().map(estimate_message_chars).sum();
        let budget_tokens = (total_chars / 4) * 3 / 5; // drop ~40%

        let out = truncate_by_importance(history, 0, budget_tokens);

        // If anything was dropped, the repeated list_dir (ld2) should go first
        // Check: ld1 is kept OR ld2 was dropped (ld2 can't outlive ld1 on same name)
        let has_ld1 = out.iter().any(|m| {
            m.get("content")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter().any(|item| {
                        item.get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .map(|id| id == "ld1")
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });
        let has_ld2 = out.iter().any(|m| {
            m.get("content")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter().any(|item| {
                        item.get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .map(|id| id == "ld2")
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });

        // If ld2 was kept, ld1 must also be kept (higher-priority block)
        if has_ld2 {
            assert!(has_ld1, "ld1 (unique) must not be dropped before ld2 (repeat)");
        }
    }
}
