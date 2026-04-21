//! # ReplanTrigger — discrete reasons to throw away the current plan
//!
//! The critic emits zero or more of these alongside its quality score.
//! `reflexion.rs` inspects the set and biases the next generator prompt
//! (hard-reset phrasing for `UserCorrection`, extra diversity pressure for
//! `LoopDetected`, etc.).
//!
//! All detection functions are pure transforms over immutable slices — no
//! internal state, easy to unit-test.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};

// ---------------------------------------------------------------------------
// Public enum
// ---------------------------------------------------------------------------

/// Discrete reasons the agent loop should scrap its current plan and start
/// fresh rather than extending it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ReplanTrigger {
    /// The same tool was invoked with identical arguments ≥ N times — the
    /// model is stuck in an unproductive loop.
    LoopDetected,

    /// The user's latest message contains correction/negation markers
    /// ("no", "actually", "that's wrong", "undo", etc.).
    UserCorrection,

    /// The same tool failed with the same error kind ≥ 2 times.
    RepeatedToolError,

    /// The assistant called a tool that was not part of the stated plan ≥ 3
    /// times.
    PlanDeviation,

    /// The critic's quality score fell below the `LOW_CONFIDENCE_THRESHOLD`.
    LowConfidence,
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// Minimum repeat count before `LoopDetected` fires.
pub const LOOP_DETECT_MIN_REPEATS: usize = 3;

/// Window of recent tool calls scanned for `LoopDetected`.
pub const LOOP_DETECT_WINDOW: usize = 20;

/// Minimum identical-error repeat count before `RepeatedToolError` fires.
pub const REPEATED_ERROR_MIN: usize = 2;

/// Minimum off-plan tool calls before `PlanDeviation` fires.
pub const PLAN_DEVIATION_MIN: usize = 3;

/// Critic score strictly below this value emits `LowConfidence`.
pub const LOW_CONFIDENCE_THRESHOLD: f32 = 0.4;

// ---------------------------------------------------------------------------
// A minimal view of a tool call — enough for detection without pulling in
// the full `ToolCall` / `ToolOutput` types from `types.rs`.
// ---------------------------------------------------------------------------

/// Lightweight record of one tool invocation the agent made.
#[derive(Debug, Clone)]
pub struct ToolRecord {
    /// The tool's name (e.g. `"web_search"`).
    pub name: String,
    /// A stable hash of the call's serialised arguments, produced by the
    /// caller. Use `arg_hash` below.
    pub arg_hash: u64,
}

/// Lightweight record of one tool failure.
#[derive(Debug, Clone)]
pub struct ToolErrorRecord {
    /// The tool's name.
    pub name: String,
    /// Machine-parseable error kind string (matches `ToolError::error_kind`).
    pub error_kind: String,
}

// ---------------------------------------------------------------------------
// Detection helpers — pure, no mutation
// ---------------------------------------------------------------------------

/// Stable 64-bit hash of an arbitrary string (the serialised tool args).
/// Deterministic within a process; not cryptographic.
pub fn arg_hash(args_json: &str) -> u64 {
    let mut h = DefaultHasher::new();
    args_json.hash(&mut h);
    h.finish()
}

/// `LoopDetected`: scan the last `LOOP_DETECT_WINDOW` records; if any
/// `(name, arg_hash)` pair appears ≥ `LOOP_DETECT_MIN_REPEATS` times,
/// return `true`.
pub fn detect_loop(history: &[ToolRecord]) -> bool {
    let window = history
        .iter()
        .rev()
        .take(LOOP_DETECT_WINDOW)
        .collect::<Vec<_>>();

    let mut counts: HashMap<(&str, u64), usize> = HashMap::new();
    for rec in &window {
        let entry = counts.entry((rec.name.as_str(), rec.arg_hash)).or_insert(0);
        *entry += 1;
        if *entry >= LOOP_DETECT_MIN_REPEATS {
            return true;
        }
    }
    false
}

/// `UserCorrection`: scan the latest user message for correction/negation
/// markers (case-insensitive word boundary match).
pub fn detect_user_correction(latest_user_message: &str) -> bool {
    let lower = latest_user_message.to_ascii_lowercase();
    // Word-boundary-ish check: marker must not be in the middle of another word.
    const MARKERS: &[&str] = &[
        "no,",
        "no.",
        "no!",
        " no ",
        "that's wrong",
        "thats wrong",
        "actually",
        "undo",
        "revert",
        "not what i",
        "wrong answer",
        "incorrect",
        "stop,",
        "stop.",
        "wait,",
        "wait.",
    ];
    MARKERS.iter().any(|m| lower.contains(m))
        || lower.starts_with("no ")
        || lower == "no"
}

/// `RepeatedToolError`: if the same `(name, error_kind)` pair appears ≥
/// `REPEATED_ERROR_MIN` times in `errors`, return `true`.
pub fn detect_repeated_tool_error(errors: &[ToolErrorRecord]) -> bool {
    let mut counts: HashMap<(&str, &str), usize> = HashMap::new();
    for rec in errors {
        let entry = counts
            .entry((rec.name.as_str(), rec.error_kind.as_str()))
            .or_insert(0);
        *entry += 1;
        if *entry >= REPEATED_ERROR_MIN {
            return true;
        }
    }
    false
}

/// `PlanDeviation`: count how many tool calls in `history` have a name not
/// in `plan_tools`. If ≥ `PLAN_DEVIATION_MIN`, return `true`.
pub fn detect_plan_deviation(history: &[ToolRecord], plan_tools: &[&str]) -> bool {
    if plan_tools.is_empty() {
        // No stated plan → deviation detection is meaningless.
        return false;
    }
    let off_plan = history
        .iter()
        .filter(|r| !plan_tools.contains(&r.name.as_str()))
        .count();
    off_plan >= PLAN_DEVIATION_MIN
}

/// `LowConfidence`: returns `true` when `score < LOW_CONFIDENCE_THRESHOLD`.
pub fn detect_low_confidence(score: f32) -> bool {
    score < LOW_CONFIDENCE_THRESHOLD
}

/// Collect all active triggers from the available signals. Returns an
/// immutable `Vec<ReplanTrigger>` — the empty vec means "no replan needed".
pub fn collect_triggers(
    tool_history: &[ToolRecord],
    error_history: &[ToolErrorRecord],
    plan_tools: &[&str],
    latest_user_message: &str,
    critic_score: Option<f32>,
) -> Vec<ReplanTrigger> {
    let mut triggers = Vec::new();
    if detect_loop(tool_history) {
        triggers.push(ReplanTrigger::LoopDetected);
    }
    if detect_user_correction(latest_user_message) {
        triggers.push(ReplanTrigger::UserCorrection);
    }
    if detect_repeated_tool_error(error_history) {
        triggers.push(ReplanTrigger::RepeatedToolError);
    }
    if detect_plan_deviation(tool_history, plan_tools) {
        triggers.push(ReplanTrigger::PlanDeviation);
    }
    if let Some(s) = critic_score {
        if detect_low_confidence(s) {
            triggers.push(ReplanTrigger::LowConfidence);
        }
    }
    triggers
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(name: &str, args: &str) -> ToolRecord {
        ToolRecord {
            name: name.to_string(),
            arg_hash: arg_hash(args),
        }
    }

    fn err_rec(name: &str, kind: &str) -> ToolErrorRecord {
        ToolErrorRecord {
            name: name.to_string(),
            error_kind: kind.to_string(),
        }
    }

    // LoopDetected -----------------------------------------------------------

    #[test]
    fn loop_detected_fires_after_three_identical_calls() {
        // Scenario: agent calls web_search("cats") three times in a row.
        let history = vec![
            rec("web_search", r#"{"q":"cats"}"#),
            rec("web_search", r#"{"q":"cats"}"#),
            rec("web_search", r#"{"q":"cats"}"#),
        ];
        assert!(detect_loop(&history));
    }

    #[test]
    fn loop_detected_does_not_fire_for_two_identical_calls() {
        let history = vec![
            rec("web_search", r#"{"q":"cats"}"#),
            rec("web_search", r#"{"q":"cats"}"#),
        ];
        assert!(!detect_loop(&history));
    }

    #[test]
    fn loop_detected_ignores_different_args() {
        // Same tool, different args — not a loop.
        let history = vec![
            rec("web_search", r#"{"q":"cats"}"#),
            rec("web_search", r#"{"q":"dogs"}"#),
            rec("web_search", r#"{"q":"fish"}"#),
        ];
        assert!(!detect_loop(&history));
    }

    #[test]
    fn loop_detected_only_looks_at_last_window_entries() {
        // 3 repeats before the window, then 19 diverse calls — no loop.
        let mut history: Vec<ToolRecord> = (0..19)
            .map(|i| rec("tool", &format!("{}", i)))
            .collect();
        // These three are outside the 20-entry window.
        let prefix = vec![
            rec("stuck", "{}"),
            rec("stuck", "{}"),
            rec("stuck", "{}"),
        ];
        let mut full = prefix;
        full.append(&mut history);
        assert!(!detect_loop(&full));
    }

    // UserCorrection ---------------------------------------------------------

    #[test]
    fn user_correction_fires_on_negation_markers() {
        // Scenario: user says "no, that's wrong, undo that".
        assert!(detect_user_correction("no, that's wrong, undo that"));
        assert!(detect_user_correction("Actually I meant something else"));
        assert!(detect_user_correction("No"));
        assert!(detect_user_correction("no."));
        assert!(detect_user_correction("Wait, stop. Revert please."));
    }

    #[test]
    fn user_correction_does_not_fire_on_affirmative() {
        assert!(!detect_user_correction("Yes please do that"));
        assert!(!detect_user_correction("That looks great, continue!"));
        assert!(!detect_user_correction("Now search for knowledge"));
    }

    // RepeatedToolError ------------------------------------------------------

    #[test]
    fn repeated_tool_error_fires_after_two_same_failures() {
        // Scenario: fetch_url fails twice with "network_error".
        let errors = vec![
            err_rec("fetch_url", "network_error"),
            err_rec("fetch_url", "network_error"),
        ];
        assert!(detect_repeated_tool_error(&errors));
    }

    #[test]
    fn repeated_tool_error_does_not_fire_for_different_error_kinds() {
        let errors = vec![
            err_rec("fetch_url", "network_error"),
            err_rec("fetch_url", "timeout"),
        ];
        assert!(!detect_repeated_tool_error(&errors));
    }

    #[test]
    fn repeated_tool_error_does_not_fire_for_single_failure() {
        let errors = vec![err_rec("fetch_url", "network_error")];
        assert!(!detect_repeated_tool_error(&errors));
    }

    // PlanDeviation ----------------------------------------------------------

    #[test]
    fn plan_deviation_fires_after_three_off_plan_calls() {
        // Scenario: plan says ["web_search"], but agent calls "read_file" 3 times.
        let history = vec![
            rec("web_search", "{}"),
            rec("read_file", r#"{"path":"/a"}"#),
            rec("read_file", r#"{"path":"/b"}"#),
            rec("read_file", r#"{"path":"/c"}"#),
        ];
        assert!(detect_plan_deviation(&history, &["web_search"]));
    }

    #[test]
    fn plan_deviation_does_not_fire_when_all_tools_are_in_plan() {
        let history = vec![
            rec("web_search", "{}"),
            rec("web_search", r#"{"q":"x"}"#),
        ];
        assert!(!detect_plan_deviation(&history, &["web_search"]));
    }

    #[test]
    fn plan_deviation_skips_empty_plan() {
        // No plan tools stated → deviation detection is off.
        let history = vec![
            rec("anything", "{}"),
            rec("anything", "{}"),
            rec("anything", "{}"),
        ];
        assert!(!detect_plan_deviation(&history, &[]));
    }

    // LowConfidence ----------------------------------------------------------

    #[test]
    fn low_confidence_fires_below_threshold() {
        // Scenario: critic returns score 0.3.
        assert!(detect_low_confidence(0.3));
        assert!(detect_low_confidence(0.0));
        assert!(!detect_low_confidence(LOW_CONFIDENCE_THRESHOLD));
        assert!(!detect_low_confidence(0.9));
    }

    // collect_triggers -------------------------------------------------------

    #[test]
    fn collect_triggers_returns_multiple_active_triggers() {
        let tool_history = vec![
            rec("web_search", "{}"),
            rec("web_search", "{}"),
            rec("web_search", "{}"),
        ];
        let triggers = collect_triggers(
            &tool_history,
            &[],
            &[],
            "No, actually that is wrong",
            Some(0.2),
        );
        assert!(triggers.contains(&ReplanTrigger::LoopDetected));
        assert!(triggers.contains(&ReplanTrigger::UserCorrection));
        assert!(triggers.contains(&ReplanTrigger::LowConfidence));
    }

    #[test]
    fn collect_triggers_empty_when_no_signals() {
        let triggers = collect_triggers(&[], &[], &[], "Please continue", Some(0.9));
        assert!(triggers.is_empty());
    }
}
