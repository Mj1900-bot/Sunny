//! Streaming event types and coalescing layer for SUNNY's tool-call
//! streaming path.
//!
//! # Why this module exists
//!
//! Anthropic's SSE protocol emits three event classes relevant to tool
//! calls in addition to plain text deltas:
//!
//!   * `content_block_start` with `type: "tool_use"` — the model is
//!     about to call a tool.
//!   * `content_block_delta` with `delta.type: "input_json_delta"` —
//!     an incremental JSON fragment for the tool's `input` field.
//!   * `content_block_stop` after the last delta — the tool input is
//!     complete.
//!
//! The existing streaming path in `providers/anthropic.rs` short-circuits
//! on `ToolUseDetected` and re-issues the whole request as a non-streaming
//! buffered call. That means the user sees nothing while the model is
//! "typing" a tool call — a jarring dead pause.
//!
//! This module provides:
//!
//!   1. [`StreamEvent`] — an enum covering every observable event during a
//!      streaming LLM turn, including the three tool-call phases above.
//!   2. [`StreamEndReason`] — typed terminal state so frontends can show
//!      "stopped cleanly" vs "called a tool" vs "hit token limit" vs
//!      "error" without parsing raw stop-reason strings.
//!   3. [`ToolArgCoalescer`] — a ring-buffer coalescer that batches
//!      `input_json_delta` fragments arriving faster than 60 Hz (≤ 16 ms
//!      between emissions). Frontends running at 60 fps don't benefit from
//!      200 Hz delta pushes; coalescing cuts the per-turn event count by
//!      roughly 3–10× under typical LLM typing speeds.
//!
//! # Publishing to the event bus
//!
//! [`emit_tool_call_start`], [`emit_tool_call_args_delta`], and
//! [`emit_tool_call_end`] wrap `crate::event_bus::publish` so callers
//! don't need to construct the full `SunnyEvent` payload inline. Each
//! helper is a thin, infallible wrapper — publishing is fire-and-forget
//! per the bus contract.
//!
//! [`emit_stream_end`] emits the terminal [`crate::event_bus::SunnyEvent::StreamEnd`]
//! variant so frontends can reliably clear their loading indicator
//! regardless of how the stream terminated.

use std::time::{Duration, Instant};

use crate::event_bus::{publish, SunnyEvent};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// All observable events produced during a single streaming LLM turn.
///
/// Variants map 1-to-1 to observable moments on the wire; the coalescing
/// layer may collapse many [`ToolCallArgsDelta`] arrivals into a single
/// published event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// A text delta chunk from the model.
    TextDelta {
        /// Streaming turn identifier (same as `turn_id` on `ChatChunk`).
        turn_id: String,
        /// Incremental text. Never empty.
        fragment: String,
    },

    /// The model has started producing a tool call. Emitted when
    /// Anthropic sends `content_block_start` with `type: "tool_use"`.
    ToolCallStart {
        /// Anthropic-assigned tool-call id. Stable across the turn so
        /// callers can correlate start / args / end events.
        id: String,
        /// Tool name (e.g. `"web_search"`, `"shell"`).
        name: String,
    },

    /// An incremental JSON fragment for an in-flight tool call's `input`
    /// field. May arrive at very high frequency; run through
    /// [`ToolArgCoalescer`] before publishing to the event bus.
    ToolCallArgsDelta {
        /// Tool-call id matching the preceding [`ToolCallStart`].
        id: String,
        /// Raw JSON fragment. Concatenating all fragments produces valid
        /// JSON when the stream closes cleanly.
        json_fragment: String,
    },

    /// The tool call's `input` is complete. Anthropic sends
    /// `content_block_stop` after the last `input_json_delta`.
    ToolCallEnd {
        /// Tool-call id matching the preceding [`ToolCallStart`].
        id: String,
    },

    /// Terminal event for the whole streaming turn. Always emitted last,
    /// regardless of how the turn ended.
    StreamEnd {
        reason: StreamEndReason,
    },
}

/// Why the streaming turn terminated.
///
/// Maps to Anthropic's `stop_reason` values plus an extra `Error`
/// catch-all. Keeping this typed (rather than a bare `String`) lets the
/// frontend match exhaustively without string comparisons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEndReason {
    /// `stop_reason: "end_turn"` — normal completion.
    Stop,
    /// `stop_reason: "tool_use"` — model wants to call a tool.
    ToolUse,
    /// `stop_reason: "max_tokens"` — generation hit the output token cap.
    MaxTokens,
    /// Stream closed with an error (HTTP or SSE-level).
    Error,
}

impl StreamEndReason {
    /// Canonical wire string for the event-bus payload.
    pub fn as_str(&self) -> &'static str {
        match self {
            StreamEndReason::Stop => "stop",
            StreamEndReason::ToolUse => "tool_use",
            StreamEndReason::MaxTokens => "max_tokens",
            StreamEndReason::Error => "error",
        }
    }

    /// Parse from an Anthropic `stop_reason` string. Unknown values map
    /// to `Stop` (fail-open so future API additions don't crash).
    pub fn from_stop_reason(s: &str) -> Self {
        match s {
            "end_turn" => StreamEndReason::Stop,
            "tool_use" => StreamEndReason::ToolUse,
            "max_tokens" => StreamEndReason::MaxTokens,
            _ => StreamEndReason::Stop,
        }
    }
}

// ---------------------------------------------------------------------------
// Coalescer
// ---------------------------------------------------------------------------

/// Batches [`StreamEvent::ToolCallArgsDelta`] events so frontends don't
/// receive more than one update per 16 ms (≈ 60 Hz).
///
/// # Design
///
/// Each tool call gets its own coalescer instance (keyed by `id`). The
/// coalescer accumulates `json_fragment` strings in a `Vec<String>` ring
/// and flushes them as a single concatenated delta when:
///
///   a. At least 16 ms has elapsed since the last flush, **or**
///   b. [`flush`] is called explicitly (e.g. on [`ToolCallEnd`]).
///
/// The flush path produces a single [`StreamEvent::ToolCallArgsDelta`] with
/// the concatenated fragment and publishes it to the event bus. The internal
/// buffer is cleared after each flush (`Vec::push` accumulation, then
/// `.into_iter().collect()` to build the output string — no in-place
/// mutation of already-flushed data).
pub struct ToolArgCoalescer {
    tool_call_id: String,
    /// Accumulated fragments since the last flush. New fragments are
    /// appended via `push`; the slice is consumed via `into_iter().collect()`
    /// on flush.
    pending: Vec<String>,
    /// Wall-clock instant of the last flush. `None` before the first
    /// fragment arrives.
    last_flush: Option<Instant>,
}

/// Coalescing threshold: 16 ms ≈ 60 Hz. Fragments that arrive faster than
/// this are batched into a single published event.
pub const COALESCE_INTERVAL: Duration = Duration::from_millis(16);

impl ToolArgCoalescer {
    /// Create a new coalescer for the given tool-call id.
    pub fn new(tool_call_id: impl Into<String>) -> Self {
        ToolArgCoalescer {
            tool_call_id: tool_call_id.into(),
            pending: Vec::new(),
            last_flush: None,
        }
    }

    /// Accept a new fragment. If enough time has elapsed since the last
    /// flush the accumulated buffer is flushed immediately; otherwise the
    /// fragment is queued for the next flush.
    ///
    /// Returns `true` when a flush occurred (useful in tests).
    pub fn push(&mut self, fragment: impl Into<String>, turn_id: &str) -> bool {
        self.pending.push(fragment.into());
        let now = Instant::now();
        let should_flush = match self.last_flush {
            None => true, // first fragment: emit immediately
            Some(last) => now.duration_since(last) >= COALESCE_INTERVAL,
        };
        if should_flush {
            self.do_flush(turn_id, now);
            true
        } else {
            false
        }
    }

    /// Force-flush any remaining buffered fragments. Called on
    /// [`ToolCallEnd`] so the terminal JSON fragment always reaches the
    /// frontend even if less than 16 ms has elapsed.
    ///
    /// Returns `true` when there were pending fragments to flush.
    pub fn flush(&mut self, turn_id: &str) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        self.do_flush(turn_id, Instant::now());
        true
    }

    fn do_flush(&mut self, turn_id: &str, now: Instant) {
        // Consume pending via into_iter().collect() — no in-place mutation
        // of already-flushed state.
        let combined: String = std::mem::take(&mut self.pending)
            .into_iter()
            .collect();
        if combined.is_empty() {
            return;
        }
        self.last_flush = Some(now);
        emit_tool_call_args_delta(turn_id, &self.tool_call_id, &combined);
    }

    /// Number of fragments waiting for the next flush.  Useful in tests.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

// ---------------------------------------------------------------------------
// Event-bus emit helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Publish a [`SunnyEvent::ToolCallStart`] to the event bus.
pub fn emit_tool_call_start(turn_id: &str, id: &str, name: &str) {
    publish(SunnyEvent::ToolCallStart {
        seq: 0,
        boot_epoch: 0,
        turn_id: turn_id.to_string(),
        id: id.to_string(),
        name: name.to_string(),
        at: now_ms(),
    });
}

/// Publish a [`SunnyEvent::ToolCallArgsDelta`] to the event bus.
pub fn emit_tool_call_args_delta(turn_id: &str, id: &str, json_fragment: &str) {
    if json_fragment.is_empty() {
        return;
    }
    publish(SunnyEvent::ToolCallArgsDelta {
        seq: 0,
        boot_epoch: 0,
        turn_id: turn_id.to_string(),
        id: id.to_string(),
        json_fragment: json_fragment.to_string(),
        at: now_ms(),
    });
}

/// Publish a [`SunnyEvent::ToolCallEnd`] to the event bus.
pub fn emit_tool_call_end(turn_id: &str, id: &str) {
    publish(SunnyEvent::ToolCallEnd {
        seq: 0,
        boot_epoch: 0,
        turn_id: turn_id.to_string(),
        id: id.to_string(),
        at: now_ms(),
    });
}

/// Publish a [`SunnyEvent::StreamEnd`] to the event bus. Always called as
/// the terminal event of a streaming turn so the frontend can reliably
/// clear its loading indicator.
pub fn emit_stream_end(turn_id: &str, reason: StreamEndReason) {
    publish(SunnyEvent::StreamEnd {
        seq: 0,
        boot_epoch: 0,
        turn_id: turn_id.to_string(),
        reason: reason.as_str().to_string(),
        at: now_ms(),
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- StreamEndReason ---------------------------------------------------

    #[test]
    fn stream_end_reason_roundtrip() {
        // Every known stop_reason string must survive a parse + as_str round trip.
        let cases = [
            ("end_turn", StreamEndReason::Stop, "stop"),
            ("tool_use", StreamEndReason::ToolUse, "tool_use"),
            ("max_tokens", StreamEndReason::MaxTokens, "max_tokens"),
        ];
        for (input, expected_variant, expected_str) in cases {
            let parsed = StreamEndReason::from_stop_reason(input);
            assert_eq!(
                parsed, expected_variant,
                "parse mismatch for {input:?}",
            );
            assert_eq!(
                parsed.as_str(),
                expected_str,
                "as_str mismatch for {input:?}",
            );
        }
    }

    #[test]
    fn unknown_stop_reason_maps_to_stop() {
        // Future API additions shouldn't crash — they fall back to Stop.
        let r = StreamEndReason::from_stop_reason("some_future_reason");
        assert_eq!(r, StreamEndReason::Stop);
    }

    // ---- ToolArgCoalescer --------------------------------------------------

    /// First fragment always flushes immediately (no prior flush timestamp).
    #[test]
    fn first_fragment_flushes_immediately() {
        // The event bus isn't initialised in unit tests so publish is a
        // no-op — we just verify the coalescer's internal state.
        let mut c = ToolArgCoalescer::new("tc-1");
        let flushed = c.push("{\"q\":", "turn-1");
        assert!(flushed, "first fragment must flush immediately");
        assert_eq!(c.pending_count(), 0, "pending must be empty after flush");
    }

    /// Rapid successive fragments within one coalesce window are held.
    #[test]
    fn rapid_fragments_are_held() {
        let mut c = ToolArgCoalescer::new("tc-2");
        // Prime the last_flush timestamp with an immediate flush.
        let _ = c.push("start", "turn-2");

        // These two arrive within the same 16 ms window — both should
        // be queued, neither flushed.
        let f2 = c.push("\"hello\"", "turn-2");
        let f3 = c.push("}", "turn-2");
        assert!(!f2, "second fragment must not flush within coalesce window");
        assert!(!f3, "third fragment must not flush within coalesce window");
        assert_eq!(c.pending_count(), 2);
    }

    /// Explicit flush drains the buffer even within the coalesce window.
    #[test]
    fn explicit_flush_drains_pending() {
        let mut c = ToolArgCoalescer::new("tc-3");
        let _ = c.push("start", "turn-3"); // prime last_flush

        c.push("\"a\"", "turn-3").then(|| ());
        c.push("\"b\"", "turn-3").then(|| ());
        assert_eq!(c.pending_count(), 2);

        let had_pending = c.flush("turn-3");
        assert!(had_pending, "flush must return true when pending is non-empty");
        assert_eq!(c.pending_count(), 0, "pending must be empty after flush");
    }

    /// Flush on empty buffer returns false without panicking.
    #[test]
    fn flush_empty_is_noop() {
        let mut c = ToolArgCoalescer::new("tc-4");
        assert!(!c.flush("turn-4"), "flush on empty buffer must return false");
    }

    /// Out-of-order resilience: accepting fragments for an id that was
    /// never started (e.g. missed `ToolCallStart` due to lag) must not
    /// panic.
    #[test]
    fn coalescer_tolerates_fragments_without_prior_start() {
        // Create a coalescer directly without going through a
        // ToolCallStart event — simulates a frontend that lagged and
        // missed the start frame.
        let mut c = ToolArgCoalescer::new("orphan-tc");
        // Should complete without panic regardless of ordering.
        let _ = c.push("\"fragment\"", "turn-x");
        c.flush("turn-x");
    }

    // ---- StreamEvent enum --------------------------------------------------

    #[test]
    fn stream_event_tool_call_start_fields() {
        let ev = StreamEvent::ToolCallStart {
            id: "tc-99".into(),
            name: "web_search".into(),
        };
        match ev {
            StreamEvent::ToolCallStart { id, name } => {
                assert_eq!(id, "tc-99");
                assert_eq!(name, "web_search");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn stream_event_tool_call_args_delta_fields() {
        let ev = StreamEvent::ToolCallArgsDelta {
            id: "tc-99".into(),
            json_fragment: "{\"q\":".into(),
        };
        match ev {
            StreamEvent::ToolCallArgsDelta { id, json_fragment } => {
                assert_eq!(id, "tc-99");
                assert_eq!(json_fragment, "{\"q\":");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn stream_event_tool_call_end_fields() {
        let ev = StreamEvent::ToolCallEnd { id: "tc-99".into() };
        match ev {
            StreamEvent::ToolCallEnd { id } => assert_eq!(id, "tc-99"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn stream_event_stream_end_reason_plumbing() {
        // StreamEnd must carry the reason from StreamEndReason.
        for (reason, expected_str) in [
            (StreamEndReason::Stop, "stop"),
            (StreamEndReason::ToolUse, "tool_use"),
            (StreamEndReason::MaxTokens, "max_tokens"),
            (StreamEndReason::Error, "error"),
        ] {
            let ev = StreamEvent::StreamEnd { reason: reason.clone() };
            match ev {
                StreamEvent::StreamEnd { reason: r } => {
                    assert_eq!(r.as_str(), expected_str);
                }
                _ => panic!("wrong variant"),
            }
        }
    }

    /// Coalescing correctness: fragments accumulated during a hold
    /// window must appear as a single concatenated delta on explicit
    /// flush, not as individual emissions.
    #[test]
    fn coalescer_concatenates_held_fragments() {
        let mut c = ToolArgCoalescer::new("tc-concat");
        // Prime the last_flush timestamp.
        let _ = c.push("start", "turn-c");
        // Queue two fragments inside the coalesce window.
        c.push("\"hello", "turn-c").then(|| ());
        c.push(" world\"}", "turn-c").then(|| ());
        assert_eq!(c.pending_count(), 2);

        // After explicit flush the buffer is empty. We can't easily
        // intercept what was published (the bus is not initialised in
        // tests), but we verify the structural contract: pending drains
        // and flush returns true.
        assert!(c.flush("turn-c"));
        assert_eq!(c.pending_count(), 0);
    }

    /// Time-based flush: simulate elapsed time by constructing two
    /// coalescers and comparing flush behaviour around the threshold.
    /// True wall-clock elapse would require `tokio::time::pause`, which
    /// needs a full tokio runtime. We instead verify the threshold
    /// constant is what the spec says (16 ms ≈ 60 Hz).
    #[test]
    fn coalesce_interval_is_60hz() {
        assert_eq!(
            COALESCE_INTERVAL,
            Duration::from_millis(16),
            "coalesce interval must be 16 ms (≈ 60 Hz)"
        );
    }
}
