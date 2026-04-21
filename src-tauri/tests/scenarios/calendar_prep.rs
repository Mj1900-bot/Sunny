//! Scenario: "what meetings this week? prep notes for the next one."
//! Steps: fetch 7-day events via osascript → pick first → GLM-5.1 3-para note.
//! Cost ceiling: < $0.003. Run: cargo test --test live -- --ignored calendar_prep --nocapture

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::types::TurnOutcome;
use sunny_lib::telemetry::cost_estimate;
use serial_test::serial;

// ── AppleScript helper ────────────────────────────────────────────────────────

/// Fetch next-7-day calendar events. Returns formatted lines or Err(reason).
async fn fetch_week_events() -> Result<Vec<String>, String> {
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;
    use tokio::time::timeout;

    let script = r#"set rs to (ASCII character 31)
set fs to (ASCII character 30)
set startOfDay to (current date)
set hours of startOfDay to 0
set minutes of startOfDay to 0
set seconds of startOfDay to 0
set endOfRange to startOfDay + (7 + 1) * days
set outLines to {}
tell application "Calendar"
    repeat with cal in calendars
        try
            set calName to (name of cal) as text
            set evs to (every event of cal whose start date >= startOfDay and start date < endOfRange)
            repeat with e in evs
                try
                    set evTitle to (summary of e) as text
                on error
                    set evTitle to "(untitled)"
                end try
                try
                    set evStart to (start date of e) as text
                on error
                    set evStart to ""
                end try
                try
                    set evEnd to (end date of e) as text
                on error
                    set evEnd to ""
                end try
                set end of outLines to evStart & fs & evEnd & fs & evTitle & fs & calName
            end repeat
        end try
    end repeat
end tell
set AppleScript's text item delimiters to rs
set joined to outLines as text
set AppleScript's text item delimiters to ""
return joined
"#;

    let mut child = Command::new("osascript")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes()).await
            .map_err(|e| format!("osascript stdin write: {e}"))?;
    }

    let output = match timeout(Duration::from_secs(30), child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript wait: {e}")),
        Err(_) => return Err("osascript timed out after 30s".to_string()),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lower = stderr.to_lowercase();
        if lower.contains("-1743") || lower.contains("not authorized") || lower.contains("not allowed") {
            return Err(format!("Calendar permission denied (grant Automation in System Settings): {stderr}"));
        }
        return Err(format!("osascript error: {}", stderr.trim()));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim_end_matches('\n').to_string();
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }

    let (rs, fs) = ('\u{1f}', '\u{1e}');
    let lines = raw.split(rs).filter_map(|row| {
        let row = row.trim_matches('\n');
        if row.is_empty() { return None; }
        let parts: Vec<&str> = row.split(fs).collect();
        if parts.len() < 3 { return None; }
        let cal = parts.get(3).unwrap_or(&"").trim();
        Some(format!("{} – {}  {}  ({})", parts[0].trim(), parts[1].trim(), parts[2].trim(), cal))
    }).collect();

    Ok(lines)
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

fn count_paragraphs(text: &str) -> usize {
    text.split("\n\n").filter(|p| !p.trim().is_empty()).count()
}

/// First word of ≥4 chars from the TITLE segment of a formatted event line.
fn first_long_title_word(line: &str) -> Option<String> {
    let after_dash = line.splitn(2, '–').nth(1).unwrap_or(line);
    let title = after_dash.splitn(2, "  ").nth(1).unwrap_or(after_dash)
        .split("  (").next().unwrap_or(after_dash).trim();
    title.split_whitespace().find(|w| w.chars().count() >= 4).map(|w| w.to_lowercase())
}

fn outcome_text(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            eprintln!("  NOTE: GLM issued {} tool call(s)", calls.len());
            thinking.unwrap_or_default()
        }
    }
}

// ── Scenario test ─────────────────────────────────────────────────────────────

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Calendar access + Z.AI key; opt-in with --ignored"]
async fn calendar_prep_next_meeting() {
    if super::should_skip_glm().await { return; }

    // Step 1: fetch this week's events
    let (cal_result, cal_ms) = super::timed(fetch_week_events()).await;
    let event_lines = match cal_result {
        Err(ref e) => {
            eprintln!("SKIP: calendar fetch failed (entitlement/osascript): {e}");
            return;
        }
        Ok(lines) => lines,
    };

    let events_found = event_lines.len();
    eprintln!("  calendar_upcoming(7 days) latency: {cal_ms}ms  events found: {events_found}");

    // Step 2-3: handle empty
    if events_found == 0 {
        eprintln!("  no events this week — test skipping with success");
        return;
    }

    // Step 4: pick first (next) event
    let first_line = &event_lines[0];
    eprintln!("  event picked: {first_line:?}");

    // Step 5: ask GLM for a 3-paragraph prep note
    let prompt = format!(
        "I have an upcoming meeting: \"{first_line}\".\n\
         Produce a 3-paragraph preparation note. \
         Paragraph 1: what this meeting typically involves. \
         Paragraph 2: likely attendees and their goals. \
         Paragraph 3: three sharp questions to ask or answer. \
         Separate paragraphs with a blank line. No bullet points."
    );
    let history = super::single_user_turn(&prompt);
    let system = "You are a concise executive assistant. \
                  Respond with exactly 3 paragraphs separated by blank lines. No bullets.";

    let (glm_result, glm_ms) = super::timed(glm_turn(DEFAULT_GLM_MODEL, system, &history)).await;
    let outcome = match glm_result {
        Ok(o) => o,
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("SKIP: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM call failed: {e}"),
    };

    let note = outcome_text(outcome);

    // Step 6: assertions + metrics
    let char_count = note.chars().count();
    let paragraphs = count_paragraphs(&note);
    let est_input: u64 = (prompt.chars().count() as u64 / 4).saturating_add(60);
    let est_output: u64 = (char_count as u64 / 4).max(1);
    let cost_usd = cost_estimate("glm", est_input, est_output, 0, 0);

    eprintln!(
        "  chars: {char_count}  paragraphs: {paragraphs}  \
         est_tokens: ~{}  est_cost: ~${cost_usd:.6}  glm_latency: {glm_ms}ms",
        est_input + est_output
    );
    eprintln!("  --- PREP NOTE ---\n{note}\n  -----------------");

    assert!(char_count >= 150, "prep note must be ≥150 chars; got {char_count}\n{note}");
    assert!(paragraphs >= 3, "prep note must have ≥3 paragraphs; got {paragraphs}\n{note}");

    if let Some(kw) = first_long_title_word(first_line) {
        assert!(
            note.to_lowercase().contains(&kw),
            "note should mention title keyword {kw:?}\n{note}"
        );
    }

    assert!(cost_usd < 0.003, "cost ${cost_usd:.6} exceeded $0.003 ceiling");
}
