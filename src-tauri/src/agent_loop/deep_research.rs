//! `deep_research` — four-phase composite research tool.
//!
//! Shape of a call (from R7-2's blueprint):
//!   1. **Planner** sub-agent breaks the user's question into 3-8 sub-questions
//!      returned as a JSON array.
//!   2. **Workers** — one researcher sub-agent per sub-question, fanned out in
//!      parallel with `futures_util::future::join_all`. Each worker has its
//!      own ReAct budget and is expected to use `web_search` + `web_fetch`.
//!   3. **Aggregator** sub-agent (role="summarizer") receives the original
//!      question plus all worker outputs and emits prose with inline `[src-N]`
//!      citations and a trailing `## Sources` table.
//!   4. Guardrails: per-worker timeout (5 min), overall timeout (15 min), at
//!      most 8 workers.
//!
//! Returns a plain-text report. Events are emitted on
//! `sunny://deep-research.step` so a future panel can render progress.

use std::time::{Duration, Instant};

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::helpers::{string_arg, usize_arg, truncate};
use super::subagents::spawn_subagent;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WORKERS: usize = 5;
const MAX_WORKERS: usize = 8;
const MIN_WORKERS: usize = 1;

const DEFAULT_DEPTH_BUDGET: u32 = 8;
const MAX_DEPTH_BUDGET: u32 = 12;
const MIN_DEPTH_BUDGET: u32 = 1;

const OVERALL_TIMEOUT_SECS: u64 = 900; // 15 min
const PER_WORKER_TIMEOUT_SECS: u64 = 300; // 5 min
const PLANNER_TIMEOUT_SECS: u64 = 120;
const AGGREGATOR_TIMEOUT_SECS: u64 = 240;

// ---------------------------------------------------------------------------
// Progress event
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
struct StepEvent<'a> {
    phase: &'a str, // "plan" | "worker" | "aggregate" | "done" | "error"
    kind: &'a str,  // "start" | "result" | "timeout" | "fallback" | "done" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sub_question: Option<String>,
    content: String,
    elapsed_ms: u128,
}

fn emit_step(
    app: &AppHandle,
    started: Instant,
    phase: &str,
    kind: &str,
    worker_index: Option<usize>,
    sub_question: Option<&str>,
    content: &str,
) {
    let _ = app.emit(
        "sunny://deep-research.step",
        StepEvent {
            phase,
            kind,
            worker_index,
            sub_question: sub_question.map(String::from),
            content: content.to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    log::info!(
        "[deep-research] phase={} kind={} w={:?} elapsed_ms={}",
        phase,
        kind,
        worker_index,
        started.elapsed().as_millis()
    );
}

// ---------------------------------------------------------------------------
// Parsed planner output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct SubQuestion {
    id: usize,
    question: String,
    /// "web" | "docs" | "compare" | anything the planner emits. Passed
    /// through to the worker prompt as a hint, not enforced.
    kind: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn deep_research(
    app: &AppHandle,
    question: &str,
    max_workers: usize,
    depth_budget: u32,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("deep_research: 'question' is empty".to_string());
    }

    let max_workers = max_workers.clamp(MIN_WORKERS, MAX_WORKERS);
    let depth_budget = depth_budget.clamp(MIN_DEPTH_BUDGET, MAX_DEPTH_BUDGET);
    let started = Instant::now();
    let overall_deadline = Duration::from_secs(OVERALL_TIMEOUT_SECS);

    emit_step(
        app,
        started,
        "plan",
        "start",
        None,
        None,
        &format!(
            "planning: question={}, max_workers={}, depth_budget={}",
            truncate(question, 160),
            max_workers,
            depth_budget
        ),
    );

    // --- Phase 1: Planner ---------------------------------------------------
    let planner_fut = run_planner(app, question, max_workers, parent_session_id, depth);
    let planner_raw = match tokio::time::timeout(
        Duration::from_secs(PLANNER_TIMEOUT_SECS),
        planner_fut,
    )
    .await
    {
        Ok(Ok(s)) => Some(s),
        Ok(Err(e)) => {
            emit_step(
                app,
                started,
                "plan",
                "error",
                None,
                None,
                &format!("planner error: {e} — falling back to single worker"),
            );
            None
        }
        Err(_) => {
            emit_step(
                app,
                started,
                "plan",
                "timeout",
                None,
                None,
                "planner timeout — falling back to single worker",
            );
            None
        }
    };

    // Defensive parse — on any failure fall back to a single worker that
    // handles the original question directly.
    let sub_questions: Vec<SubQuestion> = planner_raw
        .as_deref()
        .and_then(parse_planner_output)
        .map(|list| {
            list.into_iter()
                .take(max_workers)
                .enumerate()
                .map(|(i, mut sq)| {
                    // Force ids to be 1-based and contiguous so the
                    // worker/aggregator indices line up with citations.
                    sq.id = i + 1;
                    sq
                })
                .collect()
        })
        .filter(|list: &Vec<SubQuestion>| !list.is_empty())
        .unwrap_or_else(|| {
            emit_step(
                app,
                started,
                "plan",
                "fallback",
                None,
                None,
                "planner produced no usable sub-questions — using original question as sole worker",
            );
            vec![SubQuestion {
                id: 1,
                question: question.to_string(),
                kind: "web".to_string(),
            }]
        });

    emit_step(
        app,
        started,
        "plan",
        "result",
        None,
        None,
        &format!("planner produced {} sub-question(s)", sub_questions.len()),
    );

    // --- Phase 2: Workers ---------------------------------------------------
    let remaining = overall_deadline
        .checked_sub(started.elapsed())
        .unwrap_or_else(|| Duration::from_secs(0));
    if remaining.is_zero() {
        return Err("deep_research: overall timeout exhausted before workers started".to_string());
    }

    let worker_futs: Vec<_> = sub_questions
        .iter()
        .cloned()
        .map(|sq| {
            let app = app.clone();
            let parent_session_id = parent_session_id.map(String::from);
            let idx = sq.id;
            let sub_q_for_event = sq.question.clone();
            async move {
                emit_step(
                    &app,
                    started,
                    "worker",
                    "start",
                    Some(idx),
                    Some(&sub_q_for_event),
                    &format!("worker {idx} dispatched"),
                );

                let per_worker_cap =
                    remaining.min(Duration::from_secs(PER_WORKER_TIMEOUT_SECS));

                let res = tokio::time::timeout(
                    per_worker_cap,
                    run_worker(
                        &app,
                        &sq,
                        depth_budget,
                        parent_session_id.as_deref(),
                        depth,
                    ),
                )
                .await;

                match res {
                    Ok(Ok(output)) => {
                        emit_step(
                            &app,
                            started,
                            "worker",
                            "result",
                            Some(idx),
                            Some(&sub_q_for_event),
                            &format!("worker {idx} returned {} chars", output.len()),
                        );
                        (sq, Ok(output))
                    }
                    Ok(Err(e)) => {
                        emit_step(
                            &app,
                            started,
                            "worker",
                            "error",
                            Some(idx),
                            Some(&sub_q_for_event),
                            &format!("worker {idx} error: {e}"),
                        );
                        (sq, Err(e))
                    }
                    Err(_) => {
                        let msg = format!(
                            "worker {idx} timeout after {}s",
                            per_worker_cap.as_secs()
                        );
                        emit_step(
                            &app,
                            started,
                            "worker",
                            "timeout",
                            Some(idx),
                            Some(&sub_q_for_event),
                            &msg,
                        );
                        (sq, Err(msg))
                    }
                }
            }
        })
        .collect();

    let worker_results: Vec<(SubQuestion, Result<String, String>)> = join_all(worker_futs).await;

    let successes: Vec<(SubQuestion, String)> = worker_results
        .iter()
        .filter_map(|(sq, r)| r.as_ref().ok().map(|o| (sq.clone(), o.clone())))
        .collect();

    if successes.is_empty() {
        let failure_note = worker_results
            .iter()
            .map(|(sq, r)| {
                let err = r.as_ref().err().map(String::as_str).unwrap_or("unknown");
                format!("  - [{}] {}: {}", sq.id, truncate(&sq.question, 80), err)
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "deep_research: every worker failed, no material to aggregate.\n{failure_note}"
        ));
    }

    // --- Phase 3: Aggregator ------------------------------------------------
    emit_step(
        app,
        started,
        "aggregate",
        "start",
        None,
        None,
        &format!("aggregating {} worker output(s)", successes.len()),
    );

    let aggregator_fut = run_aggregator(
        app,
        question,
        &successes,
        parent_session_id,
        depth,
    );
    let report = match tokio::time::timeout(
        Duration::from_secs(AGGREGATOR_TIMEOUT_SECS),
        aggregator_fut,
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            emit_step(
                app,
                started,
                "aggregate",
                "error",
                None,
                None,
                &format!("aggregator error: {e} — returning raw worker output"),
            );
            assemble_fallback_report(question, &successes)
        }
        Err(_) => {
            emit_step(
                app,
                started,
                "aggregate",
                "timeout",
                None,
                None,
                "aggregator timeout — returning raw worker output",
            );
            assemble_fallback_report(question, &successes)
        }
    };

    emit_step(
        app,
        started,
        "done",
        "done",
        None,
        None,
        &format!("report {} chars", report.len()),
    );

    Ok(report)
}

// ---------------------------------------------------------------------------
// Phase 1 — Planner
// ---------------------------------------------------------------------------

async fn run_planner(
    app: &AppHandle,
    question: &str,
    max_workers: usize,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    // Deterministic 5-step prompt per R7-2. We want raw JSON only — the
    // parse layer below is defensive either way.
    let task = format!(
        "You are the research planner.\n\n\
         Step 1. Read the user's research question below.\n\
         Step 2. Decide whether it decomposes into distinct sub-questions or \
         is already atomic. Aim for 3 to {max_workers} sub-questions; never more than {max_workers}.\n\
         Step 3. For each sub-question, pick a type: \"web\" (general web research), \
         \"docs\" (technical documentation / specs), or \"compare\" (side-by-side feature/price comparison).\n\
         Step 4. Write each sub-question as a complete, self-contained query a researcher \
         could hand to web_search verbatim — do not rely on context from other sub-questions.\n\
         Step 5. Output ONLY a JSON array, no prose, no markdown fences, no \"Sure, here is\". \
         Schema: [{{\"id\":1,\"question\":\"…\",\"type\":\"web|docs|compare\"}}, …]\n\n\
         RESEARCH QUESTION:\n{question}\n\n\
         Return the JSON array now."
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

/// Defensive parser: scan for the first balanced `[...]` array and decode
/// it. Returns `None` on any failure — caller falls back to a single-worker
/// pass. Accepts objects that omit `type` (default "web") or use odd
/// casings; filters out empty/missing `question`.
fn parse_planner_output(raw: &str) -> Option<Vec<SubQuestion>> {
    // Strip the `[sub-agent planner answer] ` prefix that `spawn_subagent`
    // adds on success.
    let trimmed = raw
        .trim()
        .strip_prefix("[sub-agent planner answer]")
        .unwrap_or(raw)
        .trim();

    // Remove common wrappers (markdown fences, leading "json" labels).
    let cleaned = strip_markdown_fence(trimmed);

    // Find the first top-level JSON array by bracket balancing. The
    // planner sometimes spits "Sure, here is the plan:\n[...]\nLet me know…"
    // even though we asked for JSON only.
    let slice = extract_first_array(&cleaned)?;
    let value: Value = serde_json::from_str(slice).ok()?;
    let arr = value.as_array()?;

    let out: Vec<SubQuestion> = arr
        .iter()
        .filter_map(|v| {
            let obj = v.as_object()?;
            let question = obj
                .get("question")
                .and_then(|q| q.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let id = obj
                .get("id")
                .and_then(|i| i.as_u64())
                .map(|n| n as usize)
                .unwrap_or(0);
            let kind = obj
                .get("type")
                .and_then(|t| t.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("web")
                .to_string();
            Some(SubQuestion { id, question, kind })
        })
        .collect();

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn strip_markdown_fence(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("```json").unwrap_or(s).trim_start();
    let s = s.strip_prefix("```").unwrap_or(s);
    let s = s.trim_end().strip_suffix("```").unwrap_or(s);
    s.to_string()
}

/// Walk through `s` and return the slice covering the first top-level
/// JSON array. Ignores brackets that appear inside quoted strings.
fn extract_first_array(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut depth: i32 = 0;
    let mut start: Option<usize> = None;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            b']' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(s_i) = start {
                        return Some(&s[s_i..=i]);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Phase 2 — Worker
// ---------------------------------------------------------------------------

async fn run_worker(
    app: &AppHandle,
    sq: &SubQuestion,
    depth_budget: u32,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let kind_hint = match sq.kind.to_ascii_lowercase().as_str() {
        "docs" => "Prefer official documentation, changelogs, and spec pages.",
        "compare" => {
            "Gather comparable attributes from at least two named alternatives; \
             if prices or feature matrices are available, pull exact numbers."
        }
        _ => "Use general web research; prefer primary sources and recent articles.",
    };

    let task = format!(
        "You are a research worker. Your budget is {depth_budget} ReAct iterations total — \
         use them wisely.\n\n\
         SUB-QUESTION: {}\n\nGUIDANCE: {kind_hint}\n\n\
         You MUST call web_search at least once and web_fetch on at least one promising \
         result. Do not invent facts. If you cannot find a reliable answer, say so and \
         return whatever partial evidence you have.\n\n\
         Return your answer as structured plain text in EXACTLY this shape:\n\n\
         CLAIM: <one-sentence answer to the sub-question>\n\
         SOURCES:\n\
         - <full URL> — <one-line summary plus a short excerpt from the page>\n\
         - <full URL> — <one-line summary plus a short excerpt from the page>\n\n\
         Give at least one source, up to five. No markdown headings, no preamble.",
        sq.question,
    );

    spawn_subagent(
        app,
        "researcher",
        &task,
        None,
        parent_session_id.map(String::from),
        depth,
    )
    .await
}

// ---------------------------------------------------------------------------
// Phase 3 — Aggregator
// ---------------------------------------------------------------------------

async fn run_aggregator(
    app: &AppHandle,
    question: &str,
    worker_results: &[(SubQuestion, String)],
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let mut buf = String::with_capacity(
        worker_results.iter().map(|(_, o)| o.len() + 80).sum::<usize>() + 512,
    );
    for (sq, output) in worker_results {
        buf.push_str(&format!(
            "----- WORKER {} (type={}) -----\nSUB-QUESTION: {}\n{}\n\n",
            sq.id,
            sq.kind,
            sq.question,
            output.trim()
        ));
    }

    let task = format!(
        "You are the research aggregator. You received the user's original question plus \
         outputs from several research workers. Each worker's output contains CLAIM + SOURCES.\n\n\
         Your job:\n\
         1. Read all worker outputs below.\n\
         2. Write a cohesive prose report answering the original question. \
         Use inline citations in the form [src-N] immediately after any claim that \
         traces to a specific URL. Number sources sequentially starting at src-1 as \
         they first appear in your prose — do NOT reuse the worker ids.\n\
         3. At the end append a section exactly titled \"## Sources\" containing a \
         numbered list mapping each [src-N] tag to its URL plus a one-line description. \
         Format: \"[src-N] <URL> — <description>\".\n\
         4. If two workers contradict each other, note the disagreement briefly.\n\
         5. Keep the prose under 700 words. No emoji, no marketing fluff.\n\n\
         ORIGINAL QUESTION:\n{question}\n\n\
         WORKER OUTPUTS:\n{buf}\n\n\
         Write the report now.",
    );

    spawn_subagent(
        app,
        "summarizer",
        &task,
        None,
        parent_session_id.map(String::from),
        depth,
    )
    .await
}

/// If the aggregator fails, stitch together the worker output raw so
/// Sunny still gets something useful instead of an error.
fn assemble_fallback_report(question: &str, worker_results: &[(SubQuestion, String)]) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str("# Deep research (aggregator unavailable — raw worker output)\n\n");
    out.push_str(&format!("Question: {question}\n\n"));
    for (sq, output) in worker_results {
        out.push_str(&format!(
            "## Sub-question {}: {}\n{}\n\n",
            sq.id,
            sq.question,
            output.trim()
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Input parsing + misc helpers
// ---------------------------------------------------------------------------

/// Parse the tool-call input. Split out so dispatch.rs stays terse.
pub fn parse_input(input: &Value) -> Result<(String, usize, u32), String> {
    let question = string_arg(input, "question")?;
    let max_workers = usize_arg(input, "max_workers").unwrap_or(DEFAULT_WORKERS);
    let depth_budget = input
        .get("depth_budget")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(DEFAULT_DEPTH_BUDGET);
    Ok((question, max_workers, depth_budget))
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json_array() {
        let raw = r#"[{"id":1,"question":"What is X?","type":"web"},
                      {"id":2,"question":"How does Y compare?","type":"compare"}]"#;
        let parsed = parse_planner_output(raw).expect("should parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].question, "What is X?");
        assert_eq!(parsed[1].kind, "compare");
    }

    #[test]
    fn parses_array_wrapped_in_prose() {
        let raw = "Sure, here is the plan:\n[{\"id\":1,\"question\":\"Q1\",\"type\":\"web\"}]\nHope that helps!";
        let parsed = parse_planner_output(raw).expect("should find array");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].question, "Q1");
    }

    #[test]
    fn parses_json_in_markdown_fence() {
        let raw = "```json\n[{\"id\":1,\"question\":\"Q1\"}]\n```";
        let parsed = parse_planner_output(raw).expect("should strip fence");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].kind, "web"); // default
    }

    #[test]
    fn returns_none_for_malformed() {
        assert!(parse_planner_output("not json at all").is_none());
        assert!(parse_planner_output("[").is_none());
        assert!(parse_planner_output("[{\"no_question\":\"x\"}]").is_none());
    }

    #[test]
    fn strips_sub_agent_prefix() {
        let raw = "[sub-agent planner answer] [{\"id\":1,\"question\":\"Q\"}]";
        let parsed = parse_planner_output(raw).expect("should parse");
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn extract_first_array_ignores_brackets_in_strings() {
        let s = r#"prefix "[fake]" [{"x":1}] trailing"#;
        let slice = extract_first_array(s).expect("found");
        assert_eq!(slice, "[{\"x\":1}]");
    }
}
