//! `agent_reflect` — periodic self-reflection loop.
//!
//! Canonical use: the weekly `agent-self-reflect` scheduler template
//! fires this tool with the default window. The composite tool:
//!   1. Pulls the last N `agent_step` episodic rows and the last N
//!      `tool_usage` rows.
//!   2. Hands them to a `critic` sub-agent (cheap qwen2.5 model) with a
//!      strict JSON output prompt.
//!   3. Parses 3-5 lessons from the critic and writes each one to
//!      semantic memory (via `semantic_add`) plus an episodic note
//!      (via `note_add`) — tagged `self-reflection`, `lesson`, and
//!      `<severity>`.
//!   4. Returns a human-readable summary string.
//!
//! Safety: this tool only writes to memory, never calls outbound side
//! effects. It is NOT flagged dangerous — no ConfirmGate gate.
//!
//! Budget: the entire call is time-boxed to 60 seconds via
//! `tokio::time::timeout` around the critic invocation. A timeout
//! surfaces as an error the scheduler logs but does not panic on.

use std::time::Duration;

use rusqlite::params;
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use super::helpers::usize_arg;
use super::subagents::spawn_subagent;

const DEFAULT_WINDOW: usize = 20;
const MAX_WINDOW: usize = 100;
const REFLECT_TIMEOUT_SECS: u64 = 60;
/// Cheap critic model — reflection is short-form; no need for a 30B.
/// Falls back to the role's default if this tag isn't present locally.
const CRITIC_MODEL: &str = "qwen2.5:7b-instruct-q4_0";

// ---------------------------------------------------------------------------
// Public entry — called from dispatch.rs
// ---------------------------------------------------------------------------

pub async fn agent_reflect(
    app: &AppHandle,
    window_size: Option<usize>,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let window = window_size
        .unwrap_or(DEFAULT_WINDOW)
        .clamp(1, MAX_WINDOW);

    // 1. Pull the raw evidence — last N agent_step rows + last N tool_usage rows.
    let steps = recent_agent_steps(window)?;
    let tools = recent_tool_usage(window)?;

    if steps.is_empty() && tools.is_empty() {
        return Ok(
            "agent_reflect: no recent agent_step or tool_usage rows to review — nothing to reflect on.".to_string(),
        );
    }

    // 2. Build the critic prompt. Keep it short; the sub-agent is
    //    running on a 7B model with a narrow context window.
    let prompt = build_critic_prompt(window, &steps, &tools);

    // 3. Spawn critic sub-agent, time-boxed to 60s total.
    let spawn_fut = spawn_subagent(
        app,
        "critic",
        &prompt,
        Some(CRITIC_MODEL.to_string()),
        parent_session_id.map(String::from),
        depth,
    );
    let raw = tokio::time::timeout(Duration::from_secs(REFLECT_TIMEOUT_SECS), spawn_fut)
        .await
        .map_err(|_| {
            format!("agent_reflect: critic sub-agent timed out after {REFLECT_TIMEOUT_SECS}s")
        })?
        .map_err(|e| format!("agent_reflect: critic sub-agent failed: {e}"))?;

    // 4. Parse lessons out of the critic's answer. Tolerant to prefixes
    //    like "[sub-agent critic answer] …" and to prose wrappers
    //    around the JSON array.
    let lessons = parse_lessons(&raw)?;
    if lessons.is_empty() {
        return Ok(format!(
            "agent_reflect: critic returned no lessons. Raw head: {}",
            raw.chars().take(200).collect::<String>()
        ));
    }

    // 5. Persist each lesson to semantic + episodic memory.
    let mut written = 0usize;
    let mut summary_lines: Vec<String> = Vec::new();
    for lesson in &lessons {
        let sev = normalise_severity(&lesson.severity);
        let tags = vec![
            "self-reflection".to_string(),
            "lesson".to_string(),
            sev.to_string(),
        ];
        let text = if lesson.evidence.trim().is_empty() {
            lesson.lesson.clone()
        } else {
            format!("{} (evidence: {})", lesson.lesson, lesson.evidence)
        };

        // Semantic — durable fact the agent can recall in future.
        if let Err(e) = crate::memory::semantic_add(
            "self.lesson".to_string(),
            text.clone(),
            tags.clone(),
            Some(0.85),
            Some("self-reflection".to_string()),
        ) {
            log::debug!("agent_reflect: semantic_add failed ({e})");
        } else {
            written += 1;
        }

        // Episodic — a note row so the lessons surface in the timeline too.
        let _ = crate::memory::note_add(text.clone(), tags.clone());
        summary_lines.push(format!("  • [{sev}] {}", lesson.lesson));
    }

    // Invalidate the parent session's digest so the next turn picks up
    // the freshly-written lessons. `parent_session_id` may be None for
    // legacy callers — in which case we have nothing to key on.
    if written > 0 {
        if let Some(sid) = parent_session_id {
            super::session_cache::invalidate_digest(sid).await;
        }
    }

    Ok(format!(
        "Self-reflection complete. Reviewed {n_steps} agent steps + {n_tools} tool calls, wrote {written} lesson(s):\n{bullets}",
        n_steps = steps.len(),
        n_tools = tools.len(),
        written = written,
        bullets = summary_lines.join("\n"),
    ))
}

pub fn parse_input(input: &Value) -> Result<Option<usize>, String> {
    Ok(usize_arg(input, "window_size"))
}

// ---------------------------------------------------------------------------
// Evidence gathering
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct AgentStepRow {
    id: String,
    text: String,
    /// Kept for future "window age" heuristics and round-trip tests;
    /// the critic prompt itself only needs id + text today.
    #[allow(dead_code)]
    created_at: i64,
}

#[derive(Clone, Debug)]
struct ToolUsageRow {
    id: i64,
    tool_name: String,
    ok: bool,
    latency_ms: i64,
    error_msg: Option<String>,
    /// Kept for future "window age" heuristics; the critic prompt
    /// doesn't currently render it inline.
    #[allow(dead_code)]
    created_at: i64,
}

fn recent_agent_steps(n: usize) -> Result<Vec<AgentStepRow>, String> {
    crate::memory::db::with_conn(|c| {
        let mut stmt = c
            .prepare(
                "SELECT id, text, created_at FROM episodic
                 WHERE kind = 'agent_step'
                 ORDER BY created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("agent_reflect: prep agent_step query: {e}"))?;
        let rows = stmt
            .query_map(params![n as i64], |r| {
                Ok(AgentStepRow {
                    id: r.get(0)?,
                    text: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })
            .map_err(|e| format!("agent_reflect: query agent_step: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("agent_reflect: collect agent_step: {e}"))?;
        Ok(rows)
    })
}

fn recent_tool_usage(n: usize) -> Result<Vec<ToolUsageRow>, String> {
    crate::memory::db::with_conn(|c| {
        let mut stmt = c
            .prepare(
                "SELECT id, tool_name, ok, latency_ms, error_msg, created_at
                 FROM tool_usage
                 ORDER BY created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("agent_reflect: prep tool_usage query: {e}"))?;
        let rows = stmt
            .query_map(params![n as i64], |r| {
                Ok(ToolUsageRow {
                    id: r.get(0)?,
                    tool_name: r.get(1)?,
                    ok: r.get::<_, i64>(2)? == 1,
                    latency_ms: r.get(3)?,
                    error_msg: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| format!("agent_reflect: query tool_usage: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("agent_reflect: collect tool_usage: {e}"))?;
        Ok(rows)
    })
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const STEP_BODY_CAP: usize = 400;

fn build_critic_prompt(
    window: usize,
    steps: &[AgentStepRow],
    tools: &[ToolUsageRow],
) -> String {
    // Format agent_step rows compactly — one per line, with turn id
    // truncated so the critic can reference it as "evidence".
    let step_lines: Vec<String> = steps
        .iter()
        .map(|s| {
            let short_id = s.id.chars().take(8).collect::<String>();
            let body: String = s.text.chars().take(STEP_BODY_CAP).collect();
            format!("[turn {short_id}] {body}")
        })
        .collect();

    let tool_lines: Vec<String> = tools
        .iter()
        .map(|t| {
            let err = t
                .error_msg
                .as_deref()
                .map(|e| e.chars().take(160).collect::<String>())
                .unwrap_or_default();
            let status = if t.ok { "ok" } else { "ERR" };
            format!(
                "[tool#{id}] {name} {status} {lat}ms{err}",
                id = t.id,
                name = t.tool_name,
                status = status,
                lat = t.latency_ms,
                err = if err.is_empty() {
                    String::new()
                } else {
                    format!(" · {err}")
                },
            )
        })
        .collect();

    format!(
        "Review SUNNY's last {window} interactions. Look for: \
(a) patterns of tool-call errors, \
(b) user corrections or expressions of frustration, \
(c) repeated questions SUNNY answered awkwardly.\n\n\
Output a single JSON array of 3-5 lessons. Each lesson is an object with keys:\n\
  - lesson: short imperative sentence (≤140 chars)\n\
  - severity: one of 'low', 'med', 'high'\n\
  - evidence: the tool id (e.g. 'tool#42') or turn id (e.g. 'turn abc12345') that supports it\n\n\
Return ONLY the JSON array, no prose before or after, no markdown fences.\n\n\
--- AGENT STEPS (newest first, {n_steps} rows) ---\n{steps}\n\n\
--- TOOL USAGE (newest first, {n_tools} rows) ---\n{tools}\n",
        window = window,
        n_steps = steps.len(),
        n_tools = tools.len(),
        steps = if step_lines.is_empty() {
            "(none)".to_string()
        } else {
            step_lines.join("\n")
        },
        tools = if tool_lines.is_empty() {
            "(none)".to_string()
        } else {
            tool_lines.join("\n")
        },
    )
}

// ---------------------------------------------------------------------------
// Lesson parsing
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
struct Lesson {
    #[serde(default)]
    lesson: String,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    evidence: String,
}

/// Tolerant JSON-array extractor. Strips the `[sub-agent critic answer]`
/// prefix `spawn_subagent` adds, peels markdown fences, and locates the
/// first top-level `[ ... ]` slice before `serde_json::from_str`.
fn parse_lessons(raw: &str) -> Result<Vec<Lesson>, String> {
    let cleaned = strip_prefix_and_fences(raw);
    let slice = find_json_array(&cleaned).unwrap_or(cleaned.as_str());
    let parsed: Vec<Lesson> = serde_json::from_str(slice).map_err(|e| {
        format!(
            "agent_reflect: could not parse critic output as JSON array ({e}); head: {}",
            cleaned.chars().take(240).collect::<String>()
        )
    })?;
    // Keep non-empty lessons, cap at 5.
    let lessons: Vec<Lesson> = parsed
        .into_iter()
        .filter(|l| !l.lesson.trim().is_empty())
        .take(5)
        .collect();
    Ok(lessons)
}

fn strip_prefix_and_fences(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // `spawn_subagent` wraps the answer in "[sub-agent critic answer] …"
    if let Some(idx) = s.find("] ") {
        if s.starts_with("[sub-agent ") {
            s = s[idx + 2..].to_string();
        }
    }
    // Strip ```json or ``` fences.
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        s = rest.trim_start().trim_end_matches("```").trim().to_string();
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        s = rest.trim_start().trim_end_matches("```").trim().to_string();
    }
    s
}

fn find_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end > start {
        Some(&s[start..=end])
    } else {
        None
    }
}

fn normalise_severity(s: &str) -> &'static str {
    match s.trim().to_ascii_lowercase().as_str() {
        "high" | "h" | "critical" | "crit" => "high",
        "med" | "medium" | "m" | "mid" => "med",
        _ => "low",
    }
}

// ---------------------------------------------------------------------------
// Tests — parse helpers + prompt construction are pure and unit-testable.
// The full dispatch path needs a running AppHandle + DB + Ollama, which
// belongs in an integration test.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_input_defaults_to_none() {
        let v = serde_json::json!({});
        assert_eq!(parse_input(&v).unwrap(), None);
    }

    #[test]
    fn parse_input_reads_window_size() {
        let v = serde_json::json!({"window_size": 42});
        assert_eq!(parse_input(&v).unwrap(), Some(42));
    }

    #[test]
    fn normalise_severity_maps_variants() {
        assert_eq!(normalise_severity("HIGH"), "high");
        assert_eq!(normalise_severity("medium"), "med");
        assert_eq!(normalise_severity("m"), "med");
        assert_eq!(normalise_severity("  low  "), "low");
        assert_eq!(normalise_severity("gibberish"), "low");
    }

    #[test]
    fn parse_lessons_accepts_plain_json_array() {
        let raw = r#"[
            {"lesson":"Stop retrying timeouts past 3 attempts","severity":"med","evidence":"tool#17"},
            {"lesson":"Confirm before sending mail","severity":"high","evidence":"turn abc12345"}
        ]"#;
        let out = parse_lessons(raw).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].severity, "med");
        assert!(out[1].lesson.contains("Confirm"));
    }

    #[test]
    fn parse_lessons_handles_subagent_prefix_and_fences() {
        let raw = "[sub-agent critic answer] ```json\n[{\"lesson\":\"x\",\"severity\":\"low\",\"evidence\":\"turn 1\"}]\n```";
        let out = parse_lessons(raw).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].lesson, "x");
    }

    #[test]
    fn parse_lessons_tolerates_prose_wrapping_the_array() {
        let raw = "Here are the lessons I found:\n\n[{\"lesson\":\"foo\",\"severity\":\"high\",\"evidence\":\"tool#9\"}]\n\nThanks.";
        let out = parse_lessons(raw).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].lesson, "foo");
    }

    #[test]
    fn parse_lessons_caps_at_five() {
        let raw = r#"[
            {"lesson":"a","severity":"low","evidence":"x"},
            {"lesson":"b","severity":"low","evidence":"x"},
            {"lesson":"c","severity":"low","evidence":"x"},
            {"lesson":"d","severity":"low","evidence":"x"},
            {"lesson":"e","severity":"low","evidence":"x"},
            {"lesson":"f","severity":"low","evidence":"x"},
            {"lesson":"g","severity":"low","evidence":"x"}
        ]"#;
        let out = parse_lessons(raw).unwrap();
        assert_eq!(out.len(), 5);
    }

    #[test]
    fn parse_lessons_errors_on_non_json() {
        let raw = "I have no idea";
        assert!(parse_lessons(raw).is_err());
    }

    #[test]
    fn build_critic_prompt_mentions_window_and_counts() {
        let steps = vec![AgentStepRow {
            id: "abcdefgh1234".into(),
            text: "did a thing".into(),
            created_at: 0,
        }];
        let tools = vec![ToolUsageRow {
            id: 7,
            tool_name: "web_search".into(),
            ok: false,
            latency_ms: 1234,
            error_msg: Some("timeout".into()),
            created_at: 0,
        }];
        let prompt = build_critic_prompt(20, &steps, &tools);
        assert!(prompt.contains("last 20 interactions"));
        assert!(prompt.contains("turn abcdefgh"));
        assert!(prompt.contains("tool#7"));
        assert!(prompt.contains("web_search ERR"));
        assert!(prompt.contains("JSON array"));
    }

    #[test]
    fn build_critic_prompt_handles_empty_inputs() {
        let prompt = build_critic_prompt(5, &[], &[]);
        assert!(prompt.contains("(none)"));
    }
}
