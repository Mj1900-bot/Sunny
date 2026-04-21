//! `plan_execute` — classic plan-then-execute composite.
//!
//! Shape of a call (companion to `deep_research`, but sequential
//! rather than fan-out):
//!   1. **Planner** sub-agent decomposes `goal` into at most N numbered
//!      steps. Each step is `N. tool_name | reasoning` on its own line.
//!   2. **Executor** — for each step in order, spawn a sub-agent scoped
//!      to that single step. Its ReAct loop is instructed to make ONE
//!      tool call (plus a confirmation turn) and return a short summary.
//!   3. **Recovery** — if a step errors, ask the planner whether to
//!      continue or abort. On abort, stop; on continue, move on.
//!   4. Returns a markdown report with every step's outcome.
//!
//! Events land on `sunny://plan-execute.step` so a future panel can render
//! progress in real time. Nothing is gated by ConfirmGate at the
//! composite level; each step's tools are individually gated downstream.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::helpers::{string_arg, usize_arg, truncate};
use super::subagents::spawn_subagent;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS: usize = 8;
const HARD_MAX_STEPS: usize = 15;
const MIN_MAX_STEPS: usize = 1;

const OVERALL_TIMEOUT_SECS: u64 = 900; // 15 min budget for the whole run
const PLANNER_TIMEOUT_SECS: u64 = 120;
const PER_STEP_TIMEOUT_SECS: u64 = 180;
const RECOVERY_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Progress event
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
struct StepEvent<'a> {
    phase: &'a str, // "plan" | "step" | "recover" | "done" | "error"
    kind: &'a str,  // "start" | "result" | "timeout" | "fallback" | "done" | "error" | "abort"
    #[serde(skip_serializing_if = "Option::is_none")]
    step_n: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    elapsed_ms: u128,
}

#[allow(clippy::too_many_arguments)]
fn emit_step(
    app: &AppHandle,
    started: Instant,
    phase: &str,
    kind: &str,
    step_n: Option<usize>,
    total: Option<usize>,
    tool_name: Option<&str>,
    summary: &str,
    result: Option<&str>,
) {
    let _ = app.emit(
        "sunny://plan-execute.step",
        StepEvent {
            phase,
            kind,
            step_n,
            total,
            tool_name: tool_name.map(String::from),
            summary: summary.to_string(),
            result: result.map(String::from),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    log::info!(
        "[plan-execute] phase={} kind={} step={:?}/{:?} elapsed_ms={}",
        phase,
        kind,
        step_n,
        total,
        started.elapsed().as_millis()
    );
}

// ---------------------------------------------------------------------------
// Parsed planner output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Step {
    pub n: usize,
    pub tool_name: String,
    pub reasoning: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RecoveryVerdict {
    Continue,
    Abort,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn plan_execute(
    app: &AppHandle,
    goal: &str,
    max_steps: Option<usize>,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("plan_execute: 'goal' is empty".to_string());
    }

    let cap = max_steps
        .unwrap_or(DEFAULT_MAX_STEPS)
        .clamp(MIN_MAX_STEPS, HARD_MAX_STEPS);
    let started = Instant::now();
    let overall_deadline = Duration::from_secs(OVERALL_TIMEOUT_SECS);

    emit_step(
        app,
        started,
        "plan",
        "start",
        None,
        None,
        None,
        &format!("planning: goal={}, max_steps={cap}", truncate(goal, 160)),
        None,
    );

    // --- Phase 1: Planner ---------------------------------------------------
    let planner_fut = run_planner(app, goal, cap, parent_session_id, depth);
    let planner_raw = match tokio::time::timeout(
        Duration::from_secs(PLANNER_TIMEOUT_SECS),
        planner_fut,
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            emit_step(
                app,
                started,
                "plan",
                "error",
                None,
                None,
                None,
                &format!("planner error: {e}"),
                None,
            );
            return Err(format!("plan_execute: planner failed: {e}"));
        }
        Err(_) => {
            emit_step(
                app,
                started,
                "plan",
                "timeout",
                None,
                None,
                None,
                "planner timeout",
                None,
            );
            return Err(format!(
                "plan_execute: planner timed out after {PLANNER_TIMEOUT_SECS}s"
            ));
        }
    };

    let steps = parse_plan(&planner_raw, cap).ok_or_else(|| {
        emit_step(
            app,
            started,
            "plan",
            "fallback",
            None,
            None,
            None,
            "planner output unparseable",
            Some(&truncate(&planner_raw, 400)),
        );
        format!(
            "plan_execute: could not parse planner output. Raw: {}",
            truncate(&planner_raw, 400)
        )
    })?;

    if steps.is_empty() {
        return Err("plan_execute: planner produced zero steps".to_string());
    }

    let total = steps.len();
    emit_step(
        app,
        started,
        "plan",
        "result",
        None,
        Some(total),
        None,
        &format!("planner produced {total} step(s)"),
        Some(&format_plan_for_event(&steps)),
    );

    // --- Phase 2: Execute each step sequentially -----------------------------
    let mut outcomes: Vec<StepOutcome> = Vec::with_capacity(total);
    let mut aborted = false;

    for step in &steps {
        // Overall-budget guard: bail early if we've blown the wall clock.
        let remaining = overall_deadline
            .checked_sub(started.elapsed())
            .unwrap_or_else(|| Duration::from_secs(0));
        if remaining.is_zero() {
            emit_step(
                app,
                started,
                "step",
                "timeout",
                Some(step.n),
                Some(total),
                Some(&step.tool_name),
                "overall timeout — aborting remaining steps",
                None,
            );
            outcomes.push(StepOutcome {
                step: step.clone(),
                result: Err("overall plan_execute timeout".to_string()),
            });
            aborted = true;
            break;
        }

        let per_step_cap = remaining.min(Duration::from_secs(PER_STEP_TIMEOUT_SECS));

        emit_step(
            app,
            started,
            "step",
            "start",
            Some(step.n),
            Some(total),
            Some(&step.tool_name),
            &format!(
                "step {}/{}: {} — {}",
                step.n,
                total,
                step.tool_name,
                truncate(&step.reasoning, 120)
            ),
            None,
        );

        let exec_fut = run_step(app, step, goal, parent_session_id, depth);
        let res = tokio::time::timeout(per_step_cap, exec_fut).await;

        let step_result: Result<String, String> = match res {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(format!(
                "step {} timeout after {}s",
                step.n,
                per_step_cap.as_secs()
            )),
        };

        match &step_result {
            Ok(out) => {
                emit_step(
                    app,
                    started,
                    "step",
                    "result",
                    Some(step.n),
                    Some(total),
                    Some(&step.tool_name),
                    &format!("step {} ok", step.n),
                    Some(&truncate(out, 400)),
                );
                outcomes.push(StepOutcome {
                    step: step.clone(),
                    result: Ok(out.clone()),
                });
            }
            Err(e) => {
                emit_step(
                    app,
                    started,
                    "step",
                    "error",
                    Some(step.n),
                    Some(total),
                    Some(&step.tool_name),
                    &format!("step {} error: {}", step.n, truncate(e, 160)),
                    None,
                );
                outcomes.push(StepOutcome {
                    step: step.clone(),
                    result: Err(e.clone()),
                });

                // Recovery: ask planner whether to continue or abort.
                let verdict = run_recovery(
                    app,
                    goal,
                    step,
                    e,
                    &outcomes,
                    parent_session_id,
                    depth,
                    started,
                )
                .await;
                match verdict {
                    RecoveryVerdict::Continue => {
                        emit_step(
                            app,
                            started,
                            "recover",
                            "result",
                            Some(step.n),
                            Some(total),
                            None,
                            "recovery: continue with remaining steps",
                            None,
                        );
                    }
                    RecoveryVerdict::Abort => {
                        emit_step(
                            app,
                            started,
                            "recover",
                            "abort",
                            Some(step.n),
                            Some(total),
                            None,
                            "recovery: abort remaining steps",
                            None,
                        );
                        aborted = true;
                        break;
                    }
                }
            }
        }
    }

    // --- Phase 3: Report ----------------------------------------------------
    let report = assemble_report(goal, &outcomes, total, aborted);
    emit_step(
        app,
        started,
        "done",
        "done",
        None,
        Some(total),
        None,
        &format!(
            "plan_execute {} — {}/{} step(s) ok",
            if aborted { "aborted" } else { "complete" },
            outcomes.iter().filter(|o| o.result.is_ok()).count(),
            total
        ),
        None,
    );
    Ok(report)
}

// ---------------------------------------------------------------------------
// Phase 1 — Planner
// ---------------------------------------------------------------------------

async fn run_planner(
    app: &AppHandle,
    goal: &str,
    max_steps: usize,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let task = format!(
        "You are the plan-execute planner.\n\n\
         Step 1. Read the user's goal below.\n\
         Step 2. Decompose it into AT MOST {max_steps} concrete executable steps, \
         in strict order. Fewer is better.\n\
         Step 3. Each step MUST be ONE tool call plus specific args. No generic \
         \"think about it\" or \"decide what to do\" steps.\n\
         Step 4. Pick tools from the SUNNY catalog. Common choices:\n\
           - py_run (run a Python script, e.g. `os.makedirs`, file writes)\n\
           - code_edit (rewrite an existing source file)\n\
           - web_search / web_fetch (look things up)\n\
           - notes_create / notes_append (write to Apple Notes)\n\
           - memory_remember (persist a fact)\n\
           - reminders_add / calendar_create_event\n\
           - web_browse (drive Safari)\n\
         Step 5. Output ONLY a numbered list, one step per line, in EXACTLY \
         this format (no markdown fences, no prose):\n\n\
           1. tool_name | one-sentence reasoning with the specific args\n\
           2. tool_name | one-sentence reasoning with the specific args\n\n\
         Do not number past {max_steps}. Do not skip numbers. Each line must \
         start with the number, a period, a space, then the tool name, then \
         ` | `, then the reasoning.\n\n\
         GOAL:\n{goal}\n\n\
         Return the numbered plan now."
    );

    spawn_subagent(
        app,
        "planner",
        &task,
        None,
        parent_session_id.map(String::from),
        depth,
    )
    .await
}

/// Parse `N. tool_name | reasoning` lines. Tolerant of:
///   - `[sub-agent planner answer] ` prefix
///   - leading/trailing prose
///   - markdown fences
///   - en-dashes or `-` instead of `|`
///   - alternate punctuation after the number (`1)`, `1:`, `1 -`)
///
/// Returns `None` when no usable line is found.
pub(crate) fn parse_plan(raw: &str, cap: usize) -> Option<Vec<Step>> {
    let body = strip_agent_prefix(raw);
    let body = strip_markdown_fence(&body);

    let mut out: Vec<Step> = Vec::new();
    for line in body.lines() {
        if let Some(step) = parse_plan_line(line) {
            out.push(Step {
                // Renumber contiguously so caller logic is simple; preserve
                // planner's order.
                n: out.len() + 1,
                tool_name: step.tool_name,
                reasoning: step.reasoning,
            });
            if out.len() >= cap {
                break;
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn parse_plan_line(line: &str) -> Option<Step> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Must start with a digit.
    let first = trimmed.chars().next()?;
    if !first.is_ascii_digit() {
        return None;
    }
    // Split off the leading "N." / "N)" / "N:" / "N -".
    let (num_part, rest) = split_leading_number(trimmed)?;
    // Validate the number parsed.
    num_part.parse::<usize>().ok()?;

    // Split on the separator — accept `|`, ` — `, ` - `, ` : `, or ` · `.
    let rest = rest.trim();
    let (tool_name, reasoning) = split_tool_and_reasoning(rest)?;
    let tool_name = tool_name.trim().trim_matches(|c: char| {
        c == '*' || c == '`' || c == '"' || c == '\'' || c.is_whitespace()
    });
    if tool_name.is_empty() {
        return None;
    }
    Some(Step {
        n: 0, // overwritten by caller
        tool_name: tool_name.to_string(),
        reasoning: reasoning.trim().to_string(),
    })
}

fn split_leading_number(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    let mut end = 0;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == 0 {
        return None;
    }
    let num = &s[..end];
    let after = &s[end..];
    // Strip one of the common separators: `.`, `)`, `:`.
    let after = after
        .strip_prefix('.')
        .or_else(|| after.strip_prefix(')'))
        .or_else(|| after.strip_prefix(':'))
        .unwrap_or(after);
    Some((num, after))
}

fn split_tool_and_reasoning(rest: &str) -> Option<(&str, &str)> {
    // Prefer `|` because the prompt specifies it; fall back to em-dash /
    // hyphen / colon when the LLM gets creative.
    let seps = ["|", " — ", " -- ", " - ", " : ", "·"];
    for sep in seps {
        if let Some(idx) = rest.find(sep) {
            let left = &rest[..idx];
            let right = &rest[idx + sep.len()..];
            let left_trim = left.trim();
            if !left_trim.is_empty() {
                return Some((left_trim, right));
            }
        }
    }
    // Degenerate case: a single word with no reasoning. Treat the whole
    // line as the tool name; reasoning empty.
    if !rest.trim().is_empty() && !rest.contains(char::is_whitespace) {
        return Some((rest.trim(), ""));
    }
    None
}

fn strip_agent_prefix(raw: &str) -> String {
    raw.trim()
        .strip_prefix("[sub-agent planner answer]")
        .unwrap_or(raw)
        .trim()
        .to_string()
}

fn strip_markdown_fence(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("```markdown").unwrap_or(s).trim_start();
    let s = s.strip_prefix("```md").unwrap_or(s).trim_start();
    let s = s.strip_prefix("```").unwrap_or(s).trim_start();
    let s = s.trim_end();
    let s = s.strip_suffix("```").unwrap_or(s);
    s.trim().to_string()
}

fn format_plan_for_event(steps: &[Step]) -> String {
    steps
        .iter()
        .map(|s| format!("{}. {} | {}", s.n, s.tool_name, truncate(&s.reasoning, 80)))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Phase 2 — Execute a single step
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct StepOutcome {
    step: Step,
    result: Result<String, String>,
}

async fn run_step(
    app: &AppHandle,
    step: &Step,
    goal: &str,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let role = role_for_tool(&step.tool_name);

    let task = format!(
        "You are executing step {} of a multi-step plan. Your only job is \
         this single step — not the whole plan.\n\n\
         OVERALL GOAL: {goal}\n\n\
         THIS STEP:\n  {}. {} | {}\n\n\
         RULES:\n\
         1. Make AT MOST ONE tool call (the one named above — {}). Do not \
            chain further tool calls. After the single call, write your \
            final answer.\n\
         2. If you can answer without any tool call, do so directly.\n\
         3. Your final answer MUST be a one-paragraph summary of what you \
            did and the outcome — no markdown headings, no bullet lists.\n\
         4. If the tool call fails, say so plainly in your summary. Do not \
            retry or swap in a different tool.\n\n\
         Begin.",
        step.n, step.n, step.tool_name, step.reasoning, step.tool_name
    );

    spawn_subagent(
        app,
        role,
        &task,
        None,
        parent_session_id.map(String::from),
        depth,
    )
    .await
}

/// Map a tool name to the most suitable sub-agent role so the scope
/// allowlist (when policy enforcement is on) doesn't refuse the call.
/// Unknowns fall through to `"planner"` which has the broadest
/// read + web + spawn permissions without being coder-specific.
fn role_for_tool(tool_name: &str) -> &'static str {
    match tool_name {
        // Code / scripting
        "py_run" | "code_edit" | "claude_code_supervise" => "coder",
        // Browser driving
        "browser_open" | "browser_read_page_text" | "web_browse" => "browser_driver",
        // Web research
        "web_search" | "web_fetch" | "web_extract_links" | "deep_research" => "researcher",
        // Writing-shaped actions (notes, memory, summaries)
        "notes_create" | "notes_append" | "memory_remember" | "summarize_pdf" => "writer",
        // Critique / review
        "critic" => "critic",
        // Default: planner role has spawn + reading + web, broad enough
        // to cover scheduler_add, calendar_*, reminders_*, etc. when the
        // scope policy is strict. When scope enforcement is OFF, the role
        // doesn't matter — the sub-agent sees the full catalog either way.
        _ => "planner",
    }
}

// ---------------------------------------------------------------------------
// Phase 3 — Recovery
// ---------------------------------------------------------------------------

async fn run_recovery(
    app: &AppHandle,
    goal: &str,
    failed_step: &Step,
    error: &str,
    prior: &[StepOutcome],
    parent_session_id: Option<&str>,
    depth: u32,
    started: Instant,
) -> RecoveryVerdict {
    let prior_summary: String = prior
        .iter()
        .map(|o| {
            let verdict = match &o.result {
                Ok(_) => "ok",
                Err(_) => "error",
            };
            format!("  - step {} ({}): {}", o.step.n, o.step.tool_name, verdict)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let task = format!(
        "You are the plan-execute recovery planner. A step has failed and you \
         must decide whether to continue or abort the remaining plan.\n\n\
         OVERALL GOAL: {goal}\n\n\
         PRIOR STEPS:\n{prior_summary}\n\n\
         FAILED STEP: {}. {} | {}\n\
         ERROR: {}\n\n\
         Answer in ONE WORD only — exactly \"CONTINUE\" or \"ABORT\" (all caps). \
         No explanation, no punctuation.\n\n\
         - CONTINUE if the remaining steps can still make meaningful progress \
           toward the goal without the failed step.\n\
         - ABORT if later steps depend on this one, or the failure suggests a \
           deeper problem.",
        failed_step.n, failed_step.tool_name, failed_step.reasoning, truncate(error, 400)
    );

    let fut = spawn_subagent(
        app,
        "planner",
        &task,
        None,
        parent_session_id.map(String::from),
        depth,
    );

    let raw = match tokio::time::timeout(Duration::from_secs(RECOVERY_TIMEOUT_SECS), fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            emit_step(
                app,
                started,
                "recover",
                "error",
                Some(failed_step.n),
                None,
                None,
                &format!("recovery planner error: {} — defaulting to abort", truncate(&e, 160)),
                None,
            );
            return RecoveryVerdict::Abort;
        }
        Err(_) => {
            emit_step(
                app,
                started,
                "recover",
                "timeout",
                Some(failed_step.n),
                None,
                None,
                "recovery planner timeout — defaulting to abort",
                None,
            );
            return RecoveryVerdict::Abort;
        }
    };

    parse_recovery_verdict(&raw)
}

fn parse_recovery_verdict(raw: &str) -> RecoveryVerdict {
    let upper = raw.to_ascii_uppercase();
    // "CONTINUE" / "ABORT" — look for the tokens anywhere, but prefer
    // "ABORT" when both appear (safer default).
    let has_abort = upper.contains("ABORT");
    let has_continue = upper.contains("CONTINUE");
    if has_abort {
        RecoveryVerdict::Abort
    } else if has_continue {
        RecoveryVerdict::Continue
    } else {
        // Ambiguous output — be safe, stop.
        RecoveryVerdict::Abort
    }
}

// ---------------------------------------------------------------------------
// Phase 4 — Report
// ---------------------------------------------------------------------------

fn assemble_report(
    goal: &str,
    outcomes: &[StepOutcome],
    total_planned: usize,
    aborted: bool,
) -> String {
    let ok_count = outcomes.iter().filter(|o| o.result.is_ok()).count();
    let err_count = outcomes.len() - ok_count;
    let status = if aborted {
        "aborted (recovery)"
    } else if err_count > 0 {
        "complete with errors"
    } else {
        "complete"
    };

    let mut out = String::with_capacity(2048);
    out.push_str("# plan_execute report\n\n");
    out.push_str(&format!("Goal: {goal}\n\n"));
    out.push_str(&format!(
        "Status: {status} — {ok_count}/{total_planned} step(s) ok",
    ));
    if err_count > 0 {
        out.push_str(&format!(", {err_count} error(s)"));
    }
    out.push_str("\n\n## Steps\n\n");

    for outcome in outcomes {
        let verdict = match &outcome.result {
            Ok(_) => "ok",
            Err(_) => "error",
        };
        out.push_str(&format!(
            "### Step {} — {} ({})\n\n",
            outcome.step.n, outcome.step.tool_name, verdict
        ));
        out.push_str(&format!("Reasoning: {}\n\n", outcome.step.reasoning));
        match &outcome.result {
            Ok(ans) => {
                out.push_str("Outcome:\n");
                out.push_str(ans.trim());
                out.push_str("\n\n");
            }
            Err(e) => {
                out.push_str(&format!("Error: {e}\n\n"));
            }
        }
    }
    if aborted {
        let skipped = total_planned.saturating_sub(outcomes.len());
        if skipped > 0 {
            out.push_str(&format!(
                "> {skipped} planned step(s) were skipped after recovery chose to abort.\n"
            ));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

pub fn parse_input(input: &Value) -> Result<(String, Option<usize>), String> {
    let goal = string_arg(input, "goal")?;
    let max_steps = usize_arg(input, "max_steps");
    Ok((goal, max_steps))
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_plan_happy_path() {
        let raw = "1. py_run | create the folder via os.makedirs\n\
                   2. code_edit | write a starter README.md\n\
                   3. notes_create | save a project summary note";
        let plan = parse_plan(raw, 8).expect("parse");
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].tool_name, "py_run");
        assert_eq!(plan[1].tool_name, "code_edit");
        assert_eq!(plan[2].n, 3);
        assert!(plan[0].reasoning.contains("os.makedirs"));
    }

    #[test]
    fn parse_plan_strips_agent_prefix_and_fence() {
        let raw = "[sub-agent planner answer] ```markdown\n\
                   1. web_search | look up Rust async traits\n\
                   2. web_fetch | fetch the top result\n\
                   ```";
        let plan = parse_plan(raw, 8).expect("parse");
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].tool_name, "web_search");
    }

    #[test]
    fn parse_plan_tolerates_em_dash_separator() {
        let raw = "1. py_run — create the folder\n2. notes_create — write a note";
        let plan = parse_plan(raw, 8).expect("parse");
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[1].tool_name, "notes_create");
    }

    #[test]
    fn parse_plan_ignores_non_numbered_lines() {
        let raw = "Here is the plan:\n\
                   1. py_run | init\n\
                   Just a note line\n\
                   2. code_edit | write readme\n\
                   That's it.";
        let plan = parse_plan(raw, 8).expect("parse");
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].tool_name, "py_run");
        assert_eq!(plan[1].tool_name, "code_edit");
    }

    #[test]
    fn parse_plan_caps_at_max_steps() {
        let raw = "1. a | x\n2. b | x\n3. c | x\n4. d | x\n5. e | x";
        let plan = parse_plan(raw, 3).expect("parse");
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[2].tool_name, "c");
    }

    #[test]
    fn parse_plan_returns_none_on_empty() {
        assert!(parse_plan("", 8).is_none());
        assert!(parse_plan("no numbered lines at all", 8).is_none());
    }

    #[test]
    fn parse_plan_strips_markdown_bullets_around_tool_name() {
        let raw = "1. **py_run** | do the thing";
        let plan = parse_plan(raw, 8).expect("parse");
        assert_eq!(plan[0].tool_name, "py_run");
    }

    #[test]
    fn recovery_parses_abort() {
        assert_eq!(parse_recovery_verdict("ABORT"), RecoveryVerdict::Abort);
        assert_eq!(parse_recovery_verdict("abort\n"), RecoveryVerdict::Abort);
    }

    #[test]
    fn recovery_parses_continue() {
        assert_eq!(
            parse_recovery_verdict("CONTINUE"),
            RecoveryVerdict::Continue
        );
        assert_eq!(
            parse_recovery_verdict("continue please"),
            RecoveryVerdict::Continue
        );
    }

    #[test]
    fn recovery_prefers_abort_on_conflict() {
        // If both tokens appear (LLM hedged), pick the safer verdict.
        assert_eq!(
            parse_recovery_verdict("CONTINUE but also ABORT"),
            RecoveryVerdict::Abort
        );
    }

    #[test]
    fn recovery_unknown_defaults_to_abort() {
        assert_eq!(parse_recovery_verdict("maybe?"), RecoveryVerdict::Abort);
        assert_eq!(parse_recovery_verdict(""), RecoveryVerdict::Abort);
    }

    #[test]
    fn role_for_tool_routes_to_expected_scope() {
        assert_eq!(role_for_tool("py_run"), "coder");
        assert_eq!(role_for_tool("code_edit"), "coder");
        assert_eq!(role_for_tool("web_search"), "researcher");
        assert_eq!(role_for_tool("browser_open"), "browser_driver");
        assert_eq!(role_for_tool("notes_create"), "writer");
        assert_eq!(role_for_tool("something_unknown"), "planner");
    }

    #[test]
    fn parse_input_requires_goal() {
        assert!(parse_input(&json!({})).is_err());
        let (g, m) = parse_input(&json!({"goal": "ship it"})).unwrap();
        assert_eq!(g, "ship it");
        assert!(m.is_none());
    }

    #[test]
    fn parse_input_reads_max_steps() {
        let (_g, m) = parse_input(&json!({"goal":"g","max_steps":3})).unwrap();
        assert_eq!(m, Some(3));
    }

    #[test]
    fn assemble_report_renders_ok_and_error_sections() {
        let outcomes = vec![
            StepOutcome {
                step: Step {
                    n: 1,
                    tool_name: "py_run".into(),
                    reasoning: "create dir".into(),
                },
                result: Ok("done".into()),
            },
            StepOutcome {
                step: Step {
                    n: 2,
                    tool_name: "code_edit".into(),
                    reasoning: "write readme".into(),
                },
                result: Err("permission denied".into()),
            },
        ];
        let report = assemble_report("set up project", &outcomes, 2, false);
        assert!(report.contains("# plan_execute report"));
        assert!(report.contains("Step 1 — py_run (ok)"));
        assert!(report.contains("Step 2 — code_edit (error)"));
        assert!(report.contains("permission denied"));
        assert!(report.contains("complete with errors"));
    }

    #[test]
    fn assemble_report_marks_aborted_and_counts_skipped() {
        let outcomes = vec![StepOutcome {
            step: Step {
                n: 1,
                tool_name: "py_run".into(),
                reasoning: "x".into(),
            },
            result: Err("boom".into()),
        }];
        let report = assemble_report("g", &outcomes, 3, true);
        assert!(report.contains("aborted (recovery)"));
        assert!(report.contains("2 planned step(s) were skipped"));
    }
}
