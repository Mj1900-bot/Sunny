//! # Agent-loop core helpers
//!
//! Small utilities extracted from `core.rs` to keep the state-machine
//! driver tight. These functions are intentionally free of
//! driver state — they take references to `LoopCtx` or plain data and do
//! one well-defined job.
//!
//! * [`drain_dialogue_inbox`] — pull sibling-agent messages into history
//!   before the LLM call so the model reads them in the same window it's
//!   reasoning in.
//! * [`reassemble_tool_results`] — re-order the out-of-order safe /
//!   dangerous partition back into LLM-emitted order, filling any
//!   dropped slot with a synthetic error rather than panicking.
//! * [`is_voice_session`] — voice-path gate shared by `pick_model` and
//!   the critic gating logic.

use serde_json::json;

use super::core::LoopCtx;
use super::helpers::{emit_agent_step, truncate};
use super::types::{ToolCall as ToolCallOwned, ToolOutput};

/// Drain any sibling-agent messages that landed since our last turn and
/// inject them as user-role history entries. Done before the LLM call so
/// the model reads them in the same context window it's reasoning in.
pub(super) fn drain_dialogue_inbox(ctx: &mut LoopCtx, iteration: u32) {
    let pending = super::dialogue::drain_inbox(&ctx.dialogue_id);
    if pending.is_empty() {
        return;
    }
    log::info!(
        "agent_run_inner: draining {} dialogue message(s) for agent {}",
        pending.len(),
        ctx.dialogue_id,
    );
    for msg in &pending {
        emit_agent_step(
            &ctx.app,
            ctx.sub_id.as_deref(),
            &ctx.req.session_id,
            iteration,
            "dialogue_in",
            &format!("from {}: {}", msg.from, truncate(&msg.content, 200)),
        );
        ctx.history.push(super::dialogue::message_to_history_value(msg));
    }
}

/// Reassemble tool-dispatch results back into LLM-emitted order. Any
/// slot that is unexpectedly `None` (e.g. because `is_dangerous` is
/// env-toggleable and flipped answer between partition and
/// reassembly) is filled with a synthetic error ToolOutput so the
/// run can continue — the historical behaviour was to panic, which
/// crashed the whole agent turn and left the UI hanging.
pub(super) fn reassemble_tool_results(
    ordered: Vec<Option<(ToolCallOwned, ToolOutput)>>,
) -> Vec<(ToolCallOwned, ToolOutput)> {
    ordered
        .into_iter()
        .enumerate()
        .map(|(i, slot)| match slot {
            Some(pair) => pair,
            None => {
                log::error!(
                    "tool dispatch slot {} left empty after partition \
                     (likely non-deterministic is_dangerous); \
                     returning synthetic error ToolOutput",
                    i,
                );
                let placeholder_call = ToolCallOwned {
                    id: format!("missing-{i}"),
                    name: "unknown".to_string(),
                    input: json!({}),
                };
                let err_body = json!({
                    "error_kind": "dispatch_dropped",
                    "message": format!(
                        "tool dispatch dropped at slot {} — see logs",
                        i,
                    ),
                    "retriable": true,
                })
                .to_string();
                let out = ToolOutput {
                    ok: false,
                    wrapped: err_body,
                    display: "tool dispatch dropped".to_string(),
                };
                (placeholder_call, out)
            }
        })
        .collect()
}

/// True when the session id marks this run as coming from the voice
/// pipeline. Kept in lockstep with `pick_model`'s voice gate so the
/// critic loop stays off the latency-sensitive path.
pub(super) fn is_voice_session(session_id: Option<&str>) -> bool {
    session_id.is_some_and(|s| s.starts_with("sunny-voice-"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- dispatch-slot reassembly ------------------------------------

    /// Pathological ordering case: the partition step pushed two calls
    /// but only one slot got filled (simulating a non-deterministic
    /// `is_dangerous` flipping answer between partition and reassembly,
    /// or a dispatcher that dropped an entry). The reassembler must
    /// return a synthetic error ToolOutput for the empty slot instead
    /// of panicking.
    #[test]
    fn reassemble_tool_results_fills_empty_slot_with_error_instead_of_panic() {
        let good_call = ToolCallOwned {
            id: "t1".to_string(),
            name: "search".to_string(),
            input: json!({"q": "x"}),
        };
        let good_out = ToolOutput {
            ok: true,
            wrapped: "ok body".to_string(),
            display: "ok".to_string(),
        };
        // slot 0 filled; slot 1 left None (the pathological case).
        let ordered = vec![Some((good_call.clone(), good_out.clone())), None];

        let results = reassemble_tool_results(ordered);
        assert_eq!(results.len(), 2);

        // Slot 0 survives unchanged.
        assert_eq!(results[0].0.id, "t1");
        assert!(results[0].1.ok);

        // Slot 1 is the synthetic error, NOT a panic.
        assert_eq!(results[1].0.id, "missing-1");
        assert_eq!(results[1].0.name, "unknown");
        assert!(!results[1].1.ok);
        assert!(results[1].1.wrapped.contains("dispatch_dropped"));
        assert!(results[1].1.wrapped.contains("retriable"));
        assert_eq!(results[1].1.display, "tool dispatch dropped");
    }

    #[test]
    fn reassemble_tool_results_passes_through_when_all_slots_filled() {
        let call_a = ToolCallOwned {
            id: "a".to_string(),
            name: "one".to_string(),
            input: json!({}),
        };
        let call_b = ToolCallOwned {
            id: "b".to_string(),
            name: "two".to_string(),
            input: json!({}),
        };
        let out_a = ToolOutput {
            ok: true,
            wrapped: "A".to_string(),
            display: "A".to_string(),
        };
        let out_b = ToolOutput {
            ok: false,
            wrapped: "B".to_string(),
            display: "B".to_string(),
        };
        let ordered = vec![
            Some((call_a.clone(), out_a.clone())),
            Some((call_b.clone(), out_b.clone())),
        ];
        let results = reassemble_tool_results(ordered);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0.id, "a");
        assert_eq!(results[1].0.id, "b");
        assert!(results[0].1.ok);
        assert!(!results[1].1.ok);
    }

    #[test]
    fn reassemble_tool_results_handles_all_none_gracefully() {
        // Paranoid edge — in the real world this shouldn't happen, but
        // the function must still produce a full-length vec of errors
        // rather than panic or return a short vec.
        let ordered: Vec<Option<(ToolCallOwned, ToolOutput)>> =
            vec![None, None, None];
        let results = reassemble_tool_results(ordered);
        assert_eq!(results.len(), 3);
        for (i, (call, out)) in results.iter().enumerate() {
            assert_eq!(call.id, format!("missing-{i}"));
            assert!(!out.ok);
            assert!(out.wrapped.contains("dispatch_dropped"));
        }
    }

    // --- is_voice_session ---------------------------------------------
    //
    // The session-id prefix is load-bearing: both the dispatcher's
    // ConfirmGate skip (dispatch/mod.rs) and the critic/refiner skip
    // (critic/mod.rs) key off it. If `useVoiceChat.ts` ever changes the
    // session-id format, these tests fail loudly so the Rust side is
    // updated in the same change.

    #[test]
    fn is_voice_session_detects_sunny_voice_prefix() {
        assert!(is_voice_session(Some("sunny-voice-2026-04-20T21-00")));
        assert!(is_voice_session(Some("sunny-voice-")));
    }

    #[test]
    fn is_voice_session_rejects_non_voice_session_ids() {
        assert!(!is_voice_session(Some("chat-2026-04-20")));
        assert!(!is_voice_session(Some("sunny-chat-abc"))); // not the voice prefix
        assert!(!is_voice_session(Some("")));
    }

    #[test]
    fn is_voice_session_treats_none_as_non_voice() {
        // Sessions without an id default to typed-chat semantics so the
        // ConfirmGate modal still opens — auto-deny only fires for
        // confirmed voice sessions.
        assert!(!is_voice_session(None));
    }
}
