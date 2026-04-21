//! `reflexion_answer` — iterative multi-agent self-critique.
//!
//! Research-backed pattern (Shinn et al. 2023, "Reflexion"): a generator
//! produces a draft, a critic scores it, and a refiner rewrites the draft
//! to address the critic's issues. We loop until the critic's score
//! clears a threshold OR the iteration cap runs out.
//!
//! Flavours (different "styles" stand in for the different temperatures
//! called out in the pattern paper — our sub-agent plumbing doesn't
//! expose a `temperature` dial, so we bake the style into each role's
//! task prompt instead):
//!   * **generator** (style=creative, temp≈0.7) — draft the initial answer
//!     thoroughly.
//!   * **critic**    (style=conservative, temp≈0.2) — rate the draft 0–1
//!     and list concrete issues + suggestions as structured JSON.
//!   * **refiner**   (style=pragmatic, temp≈0.5) — apply the critic's
//!     feedback to produce an improved draft.
//!
//! Loop:
//!   1. generator → draft_0
//!   2. critic    → {score, issues, suggestions}
//!   3. if score ≥ threshold OR iter == max → RETURN draft
//!   4. refiner(draft, issues, suggestions) → draft_{n+1}
//!   5. back to (2)
//!
//! `ReplanTrigger` integration
//! ---------------------------
//! The caller may pass a slice of `ReplanTrigger` values produced by
//! `critic::collect_triggers`. When present they are injected as a
//! **hard preamble** in the generator and refiner prompts so the model
//! knows *why* the previous plan failed.
//!
//! Submodules
//! ----------
//! * `prompts` — pure prompt-construction functions for generator, critic, refiner.
//!
//! Budget: 180s overall, 60s per iteration. Events on `sunny://reflexion.step`.

pub mod prompts;

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::critic::trigger::ReplanTrigger;
use super::helpers::{string_arg, truncate, usize_arg};
use super::subagents::spawn_subagent;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS: usize = 3;
const HARD_MAX_ITERATIONS: usize = 5;
const MIN_MAX_ITERATIONS: usize = 1;

const DEFAULT_THRESHOLD: f32 = 0.8;
const MIN_THRESHOLD: f32 = 0.0;
const MAX_THRESHOLD: f32 = 1.0;

const OVERALL_TIMEOUT_SECS: u64 = 180;
const PER_ITERATION_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Progress event
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
struct StepEvent<'a> {
    phase: &'a str,
    kind: &'a str,
    iteration: usize,
    max_iterations: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    score: Option<f32>,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    elapsed_ms: u128,
}

#[allow(clippy::too_many_arguments)]
fn emit_step(
    app: &AppHandle,
    started: Instant,
    phase: &str,
    kind: &str,
    iteration: usize,
    max_iterations: usize,
    score: Option<f32>,
    summary: &str,
    preview: Option<&str>,
) {
    let _ = app.emit(
        "sunny://reflexion.step",
        StepEvent {
            phase,
            kind,
            iteration,
            max_iterations,
            score,
            summary: summary.to_string(),
            preview: preview.map(String::from),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    log::info!(
        "[reflexion] phase={} kind={} iter={}/{} score={:?} elapsed_ms={}",
        phase,
        kind,
        iteration,
        max_iterations,
        score,
        started.elapsed().as_millis()
    );
}

// ---------------------------------------------------------------------------
// Structured critique
// ---------------------------------------------------------------------------

/// Shape the critic is instructed to emit:
///   { "score": 0.0..1.0, "issues": ["..."], "suggestions": ["..."] }
#[derive(Deserialize, Serialize, Debug, Clone, Default, PartialEq)]
pub(crate) struct Critique {
    #[serde(default)]
    pub score: f32,
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub suggestions: Vec<String>,
}

// ---------------------------------------------------------------------------
// ReplanTrigger → prompt preamble
// ---------------------------------------------------------------------------

/// Convert active `ReplanTrigger` values into a preamble string prepended
/// to the generator / refiner task. Returns an empty string when the slice
/// is empty so callers can concatenate unconditionally.
///
/// `UserCorrection` is always first — it is the strongest signal (explicit
/// user feedback) and must dominate over the softer warnings.
pub(crate) fn triggers_preamble(triggers: &[ReplanTrigger]) -> String {
    if triggers.is_empty() {
        return String::new();
    }

    let mut lines: Vec<&str> = Vec::new();
    if triggers.contains(&ReplanTrigger::UserCorrection) {
        lines.push(
            "HARD RESET: the user explicitly rejected the previous answer. \
             Start completely from scratch — do NOT extend or patch the prior draft.",
        );
    }
    if triggers.contains(&ReplanTrigger::LoopDetected) {
        lines.push(
            "WARNING: the previous plan looped on the same tool call. \
             Use a different tool or approach — do not repeat the same call.",
        );
    }
    if triggers.contains(&ReplanTrigger::RepeatedToolError) {
        lines.push(
            "WARNING: a tool failed repeatedly with the same error. \
             Avoid calling that tool again; find an alternative.",
        );
    }
    if triggers.contains(&ReplanTrigger::PlanDeviation) {
        lines.push(
            "NOTE: the previous execution strayed from the stated plan. \
             Stick strictly to the tools listed in your plan this time.",
        );
    }
    if triggers.contains(&ReplanTrigger::LowConfidence) {
        lines.push(
            "NOTE: the critic scored the last draft below the confidence threshold. \
             Be more specific, concrete, and commit to a clear answer.",
        );
    }

    if lines.is_empty() {
        return String::new();
    }

    format!(
        "=== REPLAN CONTEXT ===\n{}\n=== END REPLAN CONTEXT ===\n\n",
        lines.join("\n")
    )
}

// ---------------------------------------------------------------------------
// Public entries — called from tools/composite/reflexion_answer.rs
// ---------------------------------------------------------------------------

/// Backward-compatible entry point used by the existing tool-registry adapter.
/// Runs the Reflexion loop with no active replan triggers.
///
/// New callers that have trigger context should use
/// [`reflexion_answer_with_triggers`] directly.
pub async fn reflexion_answer(
    app: &AppHandle,
    question: &str,
    max_iterations: Option<usize>,
    consensus_threshold: Option<f32>,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    reflexion_answer_with_triggers(
        app,
        question,
        max_iterations,
        consensus_threshold,
        parent_session_id,
        depth,
        &[],
    )
    .await
}

/// Full entry point. `replan_triggers` biases the generator and refiner
/// prompts but does not alter loop mechanics.
pub async fn reflexion_answer_with_triggers(
    app: &AppHandle,
    question: &str,
    max_iterations: Option<usize>,
    consensus_threshold: Option<f32>,
    parent_session_id: Option<&str>,
    depth: u32,
    replan_triggers: &[ReplanTrigger],
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("reflexion_answer: 'question' is empty".to_string());
    }

    let max_iter = max_iterations
        .unwrap_or(DEFAULT_MAX_ITERATIONS)
        .clamp(MIN_MAX_ITERATIONS, HARD_MAX_ITERATIONS);
    let threshold = consensus_threshold
        .unwrap_or(DEFAULT_THRESHOLD)
        .clamp(MIN_THRESHOLD, MAX_THRESHOLD);

    let started = Instant::now();
    let overall_deadline = Duration::from_secs(OVERALL_TIMEOUT_SECS);

    if !replan_triggers.is_empty() {
        log::info!(
            "[reflexion] active replan triggers: {:?}",
            replan_triggers
        );
    }

    emit_step(
        app,
        started,
        "generate",
        "start",
        0,
        max_iter,
        None,
        &format!(
            "reflexion start: max_iter={}, threshold={:.2}, triggers={:?}",
            max_iter, threshold, replan_triggers
        ),
        Some(&truncate(question, 200)),
    );

    // --- Iteration 0: initial draft -----------------------------------------
    let remaining = remaining_budget(started, overall_deadline)?;
    let gen_cap = remaining.min(Duration::from_secs(PER_ITERATION_TIMEOUT_SECS));
    let mut draft = match tokio::time::timeout(
        gen_cap,
        run_generator(app, question, parent_session_id, depth, replan_triggers),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            emit_step(app, started, "generate", "error", 0, max_iter, None,
                &format!("generator error: {e}"), None);
            return Err(format!("reflexion_answer: generator failed: {e}"));
        }
        Err(_) => {
            emit_step(app, started, "generate", "timeout", 0, max_iter, None,
                "generator timeout", None);
            return Err(format!(
                "reflexion_answer: generator timed out after {}s",
                gen_cap.as_secs()
            ));
        }
    };
    draft = strip_agent_prefix(&draft);

    emit_step(app, started, "generate", "result", 0, max_iter, None,
        "initial draft produced", Some(&truncate(&draft, 400)));

    // --- Critique-refine loop -----------------------------------------------
    let mut last_score: Option<f32> = None;
    for iter in 1..=max_iter {
        if started.elapsed() >= overall_deadline {
            emit_step(app, started, "critique", "timeout", iter, max_iter, last_score,
                "overall timeout — returning best draft", None);
            return Ok(finalize(&draft, iter - 1, max_iter, last_score, "timeout"));
        }

        emit_step(app, started, "critique", "start", iter, max_iter, None,
            &format!("critiquing draft (iter {iter}/{max_iter})"), None);

        let remaining = remaining_budget(started, overall_deadline)?;
        let crit_cap = remaining.min(Duration::from_secs(PER_ITERATION_TIMEOUT_SECS));
        let critic_raw = match tokio::time::timeout(
            crit_cap,
            run_critic(app, question, &draft, parent_session_id, depth),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                emit_step(app, started, "critique", "error", iter, max_iter, None,
                    &format!("critic error: {e} — returning draft"), None);
                return Ok(finalize(&draft, iter - 1, max_iter, last_score, "critic_error"));
            }
            Err(_) => {
                emit_step(app, started, "critique", "timeout", iter, max_iter, None,
                    "critic timeout — returning draft", None);
                return Ok(finalize(&draft, iter - 1, max_iter, last_score, "critic_timeout"));
            }
        };

        let critique = match parse_critique(&critic_raw) {
            Ok(c) => c,
            Err(e) => {
                emit_step(app, started, "critique", "fallback", iter, max_iter, None,
                    &format!("critic output unparseable: {e} — returning draft"),
                    Some(&truncate(&critic_raw, 400)));
                return Ok(finalize(&draft, iter - 1, max_iter, last_score, "parse_fail"));
            }
        };
        last_score = Some(critique.score);

        emit_step(
            app, started, "critique", "result", iter, max_iter, Some(critique.score),
            &format!(
                "critique: score={:.2}, issues={}, suggestions={}",
                critique.score, critique.issues.len(), critique.suggestions.len()
            ),
            Some(&truncate(&critic_raw, 400)),
        );

        if critique.score >= threshold {
            emit_step(
                app, started, "done", "converged", iter, max_iter, Some(critique.score),
                &format!(
                    "converged at iter {iter}/{max_iter} (score {:.2} ≥ threshold {:.2})",
                    critique.score, threshold
                ),
                None,
            );
            return Ok(finalize(&draft, iter, max_iter, last_score, "converged"));
        }

        if iter == max_iter {
            emit_step(
                app, started, "done", "exhausted", iter, max_iter, Some(critique.score),
                &format!(
                    "iterations exhausted (score {:.2} < threshold {:.2}) — returning last draft",
                    critique.score, threshold
                ),
                None,
            );
            return Ok(finalize(&draft, iter, max_iter, last_score, "exhausted"));
        }

        emit_step(app, started, "refine", "start", iter, max_iter, Some(critique.score),
            &format!("refining draft against {} issue(s)", critique.issues.len()), None);

        let remaining = remaining_budget(started, overall_deadline)?;
        let refine_cap = remaining.min(Duration::from_secs(PER_ITERATION_TIMEOUT_SECS));
        let refined_raw = match tokio::time::timeout(
            refine_cap,
            run_refiner(app, question, &draft, &critique, parent_session_id, depth, replan_triggers),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                emit_step(app, started, "refine", "error", iter, max_iter, Some(critique.score),
                    &format!("refiner error: {e} — keeping prior draft"), None);
                return Ok(finalize(&draft, iter, max_iter, last_score, "refiner_error"));
            }
            Err(_) => {
                emit_step(app, started, "refine", "timeout", iter, max_iter, Some(critique.score),
                    "refiner timeout — keeping prior draft", None);
                return Ok(finalize(&draft, iter, max_iter, last_score, "refiner_timeout"));
            }
        };
        let refined = strip_agent_prefix(&refined_raw);
        if refined.trim().is_empty() {
            emit_step(app, started, "refine", "fallback", iter, max_iter, Some(critique.score),
                "refiner returned empty — keeping prior draft", None);
            return Ok(finalize(&draft, iter, max_iter, last_score, "empty_refine"));
        }

        emit_step(app, started, "refine", "result", iter, max_iter, Some(critique.score),
            "refined draft produced", Some(&truncate(&refined, 400)));

        draft = refined;
    }

    Ok(finalize(&draft, max_iter, max_iter, last_score, "exhausted"))
}

// ---------------------------------------------------------------------------
// Input parsing — called from tools/composite/reflexion_answer.rs
// ---------------------------------------------------------------------------

pub fn parse_input(input: &Value) -> Result<(String, Option<usize>, Option<f32>), String> {
    let question = string_arg(input, "question")?;
    let max_iter = usize_arg(input, "max_iterations");
    let threshold = input
        .get("consensus_threshold")
        .and_then(|v| v.as_f64())
        .map(|f| f as f32);
    Ok((question, max_iter, threshold))
}

// ---------------------------------------------------------------------------
// Phase runners
// ---------------------------------------------------------------------------

async fn run_generator(
    app: &AppHandle,
    question: &str,
    parent_session_id: Option<&str>,
    depth: u32,
    replan_triggers: &[ReplanTrigger],
) -> Result<String, String> {
    let task = prompts::build_generator_task(question, replan_triggers);
    let fut: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
    > = Box::pin(spawn_subagent(
        app, "writer", &task, None, parent_session_id.map(String::from), depth,
    ));
    fut.await
}

async fn run_critic(
    app: &AppHandle,
    question: &str,
    draft: &str,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let task = prompts::build_critic_task(question, draft);
    let fut: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
    > = Box::pin(spawn_subagent(
        app, "critic", &task, None, parent_session_id.map(String::from), depth,
    ));
    fut.await
}

async fn run_refiner(
    app: &AppHandle,
    question: &str,
    prior_draft: &str,
    critique: &Critique,
    parent_session_id: Option<&str>,
    depth: u32,
    replan_triggers: &[ReplanTrigger],
) -> Result<String, String> {
    let task = prompts::build_refiner_task(question, prior_draft, critique, replan_triggers);
    let fut: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
    > = Box::pin(spawn_subagent(
        app, "writer", &task, None, parent_session_id.map(String::from), depth,
    ));
    fut.await
}

// ---------------------------------------------------------------------------
// Critique parsing
// ---------------------------------------------------------------------------

pub(crate) fn parse_critique(raw: &str) -> Result<Critique, String> {
    let cleaned = strip_prefix_and_fences(raw);
    let slice = find_json_object(&cleaned).unwrap_or(cleaned.as_str());
    let mut parsed: Critique = serde_json::from_str(slice).map_err(|e| {
        format!(
            "could not parse critique as JSON object ({e}); head: {}",
            cleaned.chars().take(240).collect::<String>()
        )
    })?;
    if !parsed.score.is_finite() {
        parsed.score = 0.0;
    }
    parsed.score = parsed.score.clamp(0.0, 1.0);
    parsed.issues.retain(|s| !s.trim().is_empty());
    parsed.suggestions.retain(|s| !s.trim().is_empty());
    Ok(parsed)
}

fn strip_prefix_and_fences(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if s.starts_with("[sub-agent ") {
        if let Some(idx) = s.find("] ") {
            s = s[idx + 2..].to_string();
        }
    }
    let trimmed = s.trim().to_string();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        s = rest.trim_start().trim_end_matches("```").trim().to_string();
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        s = rest.trim_start().trim_end_matches("```").trim().to_string();
    } else {
        s = trimmed;
    }
    s
}

fn find_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end > start { Some(&s[start..=end]) } else { None }
}

fn strip_agent_prefix(raw: &str) -> String {
    let s = raw.trim();
    if s.starts_with("[sub-agent ") {
        if let Some(idx) = s.find("] ") {
            return s[idx + 2..].trim().to_string();
        }
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

fn finalize(
    draft: &str,
    iterations_used: usize,
    max_iter: usize,
    last_score: Option<f32>,
    reason: &str,
) -> String {
    let score_line = match last_score {
        Some(s) => format!("final score: {s:.2}"),
        None => "final score: n/a".to_string(),
    };
    format!(
        "{draft}\n\n---\n[reflexion] iterations: {iterations_used}/{max_iter} · {score} · exit: {reason}",
        draft = draft.trim(),
        iterations_used = iterations_used,
        max_iter = max_iter,
        score = score_line,
        reason = reason,
    )
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

fn remaining_budget(started: Instant, total: Duration) -> Result<Duration, String> {
    total.checked_sub(started.elapsed()).ok_or_else(|| {
        format!("reflexion_answer: overall {OVERALL_TIMEOUT_SECS}s budget exhausted")
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- parse_input --------------------------------------------------------

    #[test]
    fn parse_input_requires_question() {
        let err = parse_input(&json!({})).unwrap_err();
        assert!(err.contains("question"), "err was: {err}");
    }

    #[test]
    fn parse_input_reads_all_fields() {
        let (q, it, th) = parse_input(&json!({
            "question": "what is 2+2",
            "max_iterations": 4,
            "consensus_threshold": 0.9,
        }))
        .unwrap();
        assert_eq!(q, "what is 2+2");
        assert_eq!(it, Some(4));
        assert!((th.unwrap() - 0.9).abs() < 1e-6);
    }

    #[test]
    fn parse_input_allows_optional_fields_absent() {
        let (q, it, th) = parse_input(&json!({"question": "x"})).unwrap();
        assert_eq!(q, "x");
        assert_eq!(it, None);
        assert_eq!(th, None);
    }

    // --- parse_critique -----------------------------------------------------

    #[test]
    fn parse_critique_accepts_plain_json_object() {
        let raw = r#"{"score":0.85,"issues":["too vague"],"suggestions":["add an example"]}"#;
        let c = parse_critique(raw).unwrap();
        assert!((c.score - 0.85).abs() < 1e-6);
        assert_eq!(c.issues, vec!["too vague".to_string()]);
        assert_eq!(c.suggestions, vec!["add an example".to_string()]);
    }

    #[test]
    fn parse_critique_handles_subagent_prefix_and_fences() {
        let raw = "[sub-agent critic answer] ```json\n{\"score\": 0.4, \"issues\": [\"a\"], \"suggestions\": [\"b\"]}\n```";
        let c = parse_critique(raw).unwrap();
        assert!((c.score - 0.4).abs() < 1e-6);
        assert_eq!(c.issues.len(), 1);
        assert_eq!(c.suggestions.len(), 1);
    }

    #[test]
    fn parse_critique_tolerates_prose_wrapping_the_object() {
        let raw = "Here is my critique:\n\n{\"score\":0.6,\"issues\":[\"x\"],\"suggestions\":[]}\n\nHope that helps.";
        let c = parse_critique(raw).unwrap();
        assert!((c.score - 0.6).abs() < 1e-6);
        assert_eq!(c.issues, vec!["x".to_string()]);
        assert!(c.suggestions.is_empty());
    }

    #[test]
    fn parse_critique_clamps_out_of_range_score() {
        let c = parse_critique(r#"{"score": 1.8, "issues": [], "suggestions": []}"#).unwrap();
        assert!((c.score - 1.0).abs() < 1e-6);
        let c2 = parse_critique(r#"{"score": -0.3, "issues": [], "suggestions": []}"#).unwrap();
        assert!((c2.score - 0.0).abs() < 1e-6);
    }

    #[test]
    fn parse_critique_drops_empty_list_entries() {
        let raw = r#"{"score":0.5,"issues":["", "real issue", "   "],"suggestions":[]}"#;
        let c = parse_critique(raw).unwrap();
        assert_eq!(c.issues, vec!["real issue".to_string()]);
    }

    #[test]
    fn parse_critique_errors_on_non_json() {
        assert!(parse_critique("this is definitely not JSON at all").is_err());
    }

    #[test]
    fn parse_critique_accepts_missing_fields_with_defaults() {
        let c = parse_critique(r#"{"score":0.72}"#).unwrap();
        assert!((c.score - 0.72).abs() < 1e-6);
        assert!(c.issues.is_empty());
        assert!(c.suggestions.is_empty());
    }

    // --- triggers_preamble --------------------------------------------------

    #[test]
    fn triggers_preamble_empty_when_no_triggers() {
        assert_eq!(triggers_preamble(&[]), "");
    }

    #[test]
    fn triggers_preamble_user_correction_is_hard_reset() {
        let p = triggers_preamble(&[ReplanTrigger::UserCorrection]);
        assert!(p.contains("HARD RESET"));
        assert!(p.contains("=== REPLAN CONTEXT ==="));
    }

    #[test]
    fn triggers_preamble_user_correction_appears_first_in_multi_trigger() {
        let p = triggers_preamble(&[ReplanTrigger::LoopDetected, ReplanTrigger::UserCorrection]);
        let hard_reset_pos = p.find("HARD RESET").unwrap();
        let loop_pos = p.find("WARNING: the previous plan looped").unwrap();
        assert!(hard_reset_pos < loop_pos);
    }

    #[test]
    fn triggers_preamble_loop_detected_warns_about_tool_loop() {
        let p = triggers_preamble(&[ReplanTrigger::LoopDetected]);
        assert!(p.contains("looped"));
    }

    #[test]
    fn triggers_preamble_repeated_tool_error_warns_to_avoid_tool() {
        let p = triggers_preamble(&[ReplanTrigger::RepeatedToolError]);
        assert!(p.contains("failed repeatedly"));
    }

    #[test]
    fn triggers_preamble_plan_deviation_warns_to_stick_to_plan() {
        let p = triggers_preamble(&[ReplanTrigger::PlanDeviation]);
        assert!(p.contains("strayed from the stated plan"));
    }

    #[test]
    fn triggers_preamble_low_confidence_urges_specificity() {
        let p = triggers_preamble(&[ReplanTrigger::LowConfidence]);
        assert!(p.contains("confidence threshold"));
    }

    // --- finalize -----------------------------------------------------------

    #[test]
    fn finalize_includes_iteration_and_score_suffix() {
        let out = finalize("the answer", 2, 3, Some(0.85), "converged");
        assert!(out.starts_with("the answer"));
        assert!(out.contains("iterations: 2/3"));
        assert!(out.contains("0.85"));
        assert!(out.contains("converged"));
    }

    #[test]
    fn finalize_handles_missing_score() {
        let out = finalize("x", 0, 3, None, "exhausted");
        assert!(out.contains("n/a"));
        assert!(out.contains("exhausted"));
    }

    // --- strip helpers ------------------------------------------------------

    #[test]
    fn strip_agent_prefix_handles_wrapped_answers() {
        assert_eq!(strip_agent_prefix("[sub-agent writer answer] hello"), "hello");
        assert_eq!(strip_agent_prefix("plain answer"), "plain answer");
    }

    #[test]
    fn truncate_keeps_short_strings_intact() {
        assert_eq!(truncate("hi", 10), "hi");
        let long = truncate("abcdefghij", 5);
        assert!(long.ends_with('…'));
        assert_eq!(long.chars().count(), 6);
    }
}
