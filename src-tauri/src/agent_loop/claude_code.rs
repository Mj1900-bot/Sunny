//! `claude_code_supervise` — SUNNY drives Claude Code on a loop.
//!
//! Takes a project dir + spec, shells out to the Claude Code CLI
//! (`claude -p "<prompt>" --add-dir <project>` for iteration 1,
//! `claude -p "<next>" -c --add-dir <project>` for continuation),
//! asks SUNNY's own ReAct planner between iterations to decide the next
//! instruction, runs success-criteria checks via the host shell, and
//! stops when either all criteria pass or `max_iterations` is reached.
//!
//! Emits `sunny://claude-supervise.step` events per iteration so the UI
//! can render a live progress feed.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::time::timeout;

use super::helpers::truncate;

/// Wall-clock ceiling for the entire supervise run. The outer timeout is
/// defensive — individual Claude calls are capped separately below.
const TOTAL_TIMEOUT_SECS: u64 = 1800; // 30 min

/// Per-iteration claude CLI call timeout. Claude Code's `-p` mode
/// returns when the assistant finishes; complex refactors can take a
/// couple of minutes. Anything longer than this and we're probably
/// stuck.
const CLAUDE_CALL_TIMEOUT_SECS: u64 = 600; // 10 min

/// Shell command timeout for success-criteria checks.
const CHECK_TIMEOUT_SECS: u64 = 120;

#[derive(Serialize, Debug, Clone)]
struct StepEvent<'a> {
    iteration: u32,
    kind: &'a str, // "instruction" | "claude_output" | "check" | "decision" | "done" | "error"
    content: &'a str,
    elapsed_ms: u128,
}

/// Run the supervise loop. Returns a human-readable report string the
/// parent agent can relay.
pub async fn claude_code_supervise(
    app: &AppHandle,
    project_dir: &str,
    spec: &str,
    success_criteria: &[String],
    max_iterations: u32,
) -> Result<String, String> {
    let started = Instant::now();
    let max = max_iterations.clamp(1, 40);

    // Sanity check: claude CLI must be on PATH. We look it up explicitly
    // because Tauri apps launched from Finder have a stripped PATH and
    // the existing `paths::which` already handles that.
    let claude_bin = crate::paths::which("claude")
        .ok_or_else(|| "claude CLI not found on PATH — install from https://docs.claude.com".to_string())?;

    // Project dir must exist.
    let project_pb = std::path::PathBuf::from(shellexpand_home(project_dir));
    if !project_pb.is_dir() {
        return Err(format!("project_dir does not exist: {}", project_pb.display()));
    }
    let project_abs = project_pb.to_string_lossy().into_owned();

    let mut transcript: Vec<String> = Vec::with_capacity((max as usize) * 2);
    #[allow(unused_assignments)]
    let mut last_claude_output = String::new();
    let mut criteria_pass = vec![false; success_criteria.len()];

    emit_step(app, 0, "start", &format!(
        "supervise starting: {} iterations max, {} criteria, dir={}",
        max, success_criteria.len(), project_abs
    ), started);

    // Iteration 1 gets the raw spec; subsequent iterations get a synthesised
    // instruction from the supervisor (or a default "continue" if we're
    // running without the supervisor hook).
    let mut current_instruction = format!(
        "Task spec:\n\n{spec}\n\nProject directory: {project_abs}\n\n\
         Implement the task. When you're done, say \"READY FOR REVIEW\" \
         on its own line. Work in small, verified steps."
    );

    for iteration in 1..=max {
        // Global budget guard.
        if started.elapsed() >= Duration::from_secs(TOTAL_TIMEOUT_SECS) {
            let report = finalize_report(
                &transcript, &criteria_pass, success_criteria, max, iteration - 1, "timeout"
            );
            emit_step(app, iteration, "done", &report, started);
            return Ok(report);
        }

        emit_step(app, iteration, "instruction",
            &truncate(&current_instruction, 400), started);

        // Build the claude command: first iteration uses --add-dir to give
        // Claude access to the project; subsequent iterations add `-c` to
        // continue the session so history accumulates.
        let mut cmd = Command::new(&claude_bin);
        cmd.arg("-p").arg(&current_instruction);
        cmd.arg("--add-dir").arg(&project_abs);
        if iteration > 1 {
            cmd.arg("-c");
        }
        // Silent hooks, faster startup.
        cmd.arg("--bare");
        // Expose common tools without per-call confirmation.
        cmd.arg("--dangerously-skip-permissions");
        if let Some(p) = crate::paths::fat_path() {
            cmd.env("PATH", p);
        }
        cmd.current_dir(&project_abs);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let claude_started = Instant::now();
        let output = match timeout(
            Duration::from_secs(CLAUDE_CALL_TIMEOUT_SECS),
            cmd.output(),
        ).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                let err = format!("claude spawn: {e}");
                emit_step(app, iteration, "error", &err, started);
                transcript.push(format!("# iteration {iteration}: spawn error\n{err}"));
                break;
            }
            Err(_) => {
                let err = format!("claude timed out after {CLAUDE_CALL_TIMEOUT_SECS}s");
                emit_step(app, iteration, "error", &err, started);
                transcript.push(format!("# iteration {iteration}: timeout\n{err}"));
                break;
            }
        };
        let claude_ms = claude_started.elapsed().as_millis();

        if !output.status.success() {
            let err_tail = String::from_utf8_lossy(&output.stderr);
            let msg = format!(
                "claude exit {}: {}",
                output.status,
                err_tail.lines().rev().take(3).collect::<Vec<_>>().join(" | ")
            );
            emit_step(app, iteration, "error", &msg, started);
            transcript.push(format!("# iteration {iteration}: {msg}"));
            break;
        }

        last_claude_output = String::from_utf8_lossy(&output.stdout).to_string();
        transcript.push(format!(
            "# iteration {iteration} ({} ms):\n{}",
            claude_ms,
            truncate(&last_claude_output, 2000),
        ));
        emit_step(app, iteration, "claude_output",
            &truncate(&last_claude_output, 600), started);

        // Run success criteria checks between iterations.
        let mut all_pass = true;
        for (i, check) in success_criteria.iter().enumerate() {
            let ok = run_check(&project_abs, check).await;
            criteria_pass[i] = ok;
            emit_step(
                app, iteration,
                if ok { "check_pass" } else { "check_fail" },
                check, started,
            );
            if !ok { all_pass = false; }
        }

        if all_pass && !success_criteria.is_empty() {
            let report = finalize_report(
                &transcript, &criteria_pass, success_criteria, max, iteration, "all_criteria_pass"
            );
            emit_step(app, iteration, "done", &report, started);
            return Ok(report);
        }

        // Optional supervisor hook — let SUNNY decide the next instruction.
        // If we can't reach a supervisor (no model), fall back to a simple
        // continuation prompt that includes any failing checks so Claude
        // knows what to fix next.
        let failed_checks: Vec<&str> = success_criteria.iter()
            .zip(criteria_pass.iter())
            .filter_map(|(c, ok)| (!ok).then_some(c.as_str()))
            .collect();
        current_instruction = match supervisor_decide(
            iteration, &last_claude_output, &failed_checks, spec
        ).await {
            Ok(next) => next,
            Err(_) => {
                if failed_checks.is_empty() {
                    format!(
                        "Continue. Previous iteration completed. Check the repo state \
                         and either finish remaining work from the original spec or \
                         polish the implementation. When done, say \"READY FOR REVIEW\"."
                    )
                } else {
                    format!(
                        "Continue. These success checks are still failing:\n- {}\n\n\
                         Fix each of them. When you believe they all pass, say \
                         \"READY FOR REVIEW\" on its own line.",
                        failed_checks.join("\n- ")
                    )
                }
            }
        };

        emit_step(app, iteration, "decision",
            &truncate(&current_instruction, 400), started);
    }

    let report = finalize_report(
        &transcript, &criteria_pass, success_criteria, max, max, "max_iterations"
    );
    emit_step(app, max, "done", &report, started);
    Ok(report)
}

/// Ask SUNNY's local model to pick the next instruction. A thin one-shot
/// call — not a full ReAct loop. Uses ollama directly to avoid recursion
/// into the agent loop.
async fn supervisor_decide(
    iteration: u32,
    claude_output: &str,
    failed_checks: &[&str],
    spec: &str,
) -> Result<String, String> {
    let system = "You are a build supervisor. Your job is to turn the latest Claude Code output \
                  plus a list of still-failing checks into ONE short, concrete instruction for \
                  Claude to execute next. Keep the instruction under 400 characters. If all \
                  checks pass and the work looks complete, reply with just: READY FOR REVIEW";

    let check_block = if failed_checks.is_empty() {
        "(all success criteria are passing)".to_string()
    } else {
        format!("Failing checks:\n- {}", failed_checks.join("\n- "))
    };

    let user = format!(
        "Original spec: {spec}\n\nLatest Claude output (truncated):\n{}\n\n{}\n\n\
         Write ONE instruction for iteration {}. Terse. Action-oriented.",
        truncate(claude_output, 1500),
        check_block,
        iteration + 1,
    );

    let body = json!({
        "model": "qwen3:30b-a3b-thinking-2507-q4_K_M",
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "stream": false,
        "options": { "keep_alive": "30m" }
    });
    let client = crate::http::client();
    let req = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("supervisor http: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("supervisor status: {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("supervisor decode: {e}"))?;
    let msg = v.get("message").and_then(|m| m.as_object());
    let content = msg
        .and_then(|m| m.get("content").and_then(|c| c.as_str()))
        .filter(|s| !s.trim().is_empty())
        .or_else(|| msg.and_then(|m| m.get("thinking").and_then(|c| c.as_str())))
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        Err("supervisor produced empty reply".to_string())
    } else {
        Ok(content)
    }
}

/// Run a success-criteria shell check and return whether it exited 0.
async fn run_check(project_dir: &str, check: &str) -> bool {
    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-lc").arg(check);
    cmd.current_dir(project_dir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    matches!(
        timeout(Duration::from_secs(CHECK_TIMEOUT_SECS), cmd.output()).await,
        Ok(Ok(out)) if out.status.success()
    )
}

/// Emit the progress event to the frontend. Swallows errors — this is
/// telemetry, not critical path.
fn emit_step(
    app: &AppHandle,
    iteration: u32,
    kind: &str,
    content: &str,
    started: Instant,
) {
    let _ = app.emit(
        "sunny://claude-supervise.step",
        StepEvent {
            iteration,
            kind,
            content,
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    log::info!("[claude-supervise] iter={} kind={} elapsed_ms={}", iteration, kind, started.elapsed().as_millis());
}


fn shellexpand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

/// Build the final human-readable report. Kept plain so the parent agent
/// can speak it aloud without Markdown cruft.
fn finalize_report(
    transcript: &[String],
    criteria_pass: &[bool],
    success_criteria: &[String],
    max_iterations: u32,
    iterations_run: u32,
    reason: &str,
) -> String {
    let mut out = String::with_capacity(2000);
    out.push_str(&format!(
        "Claude Code supervise finished — reason: {reason}. Ran {iterations_run}/{max_iterations} iterations.\n\n"
    ));
    if !success_criteria.is_empty() {
        out.push_str("Success criteria:\n");
        for (c, ok) in success_criteria.iter().zip(criteria_pass.iter()) {
            out.push_str(&format!("  [{}] {c}\n", if *ok { "PASS" } else { "FAIL" }));
        }
        out.push('\n');
    }
    out.push_str("Iteration trace (most recent 3):\n");
    for line in transcript.iter().rev().take(3) {
        out.push_str(line);
        out.push('\n');
    }
    out
}
