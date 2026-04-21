//! Live integration test: "what's on my calendar tomorrow, and write prep notes
//! for the first meeting."
//!
//! # What this test does
//!
//! 1. Queries Calendar.app via osascript for tomorrow's events
//!    (2026-04-21 00:00 → 23:59 local).
//! 2. If the calendar is empty it creates a test event via AppleScript
//!    ("Test Meeting with Sunny", tomorrow 10:00–11:00), runs the scenario,
//!    then **deletes** the event in a scopeguard so cleanup is guaranteed
//!    even on panic.
//! 3. Picks the earliest event.
//! 4. Calls GLM-5.1 via the Z.AI Coding Plan endpoint directly (no Tauri
//!    runtime) and requests prep notes with three sections:
//!    (a) context summary, (b) 3 likely topics, (c) 3 questions to ask.
//! 5. Asserts the response is non-empty, ≥ 150 chars, and references the
//!    event title.
//! 6. Checks that the API cost is below $0.005.
//!
//! # Skipping
//!
//! * If Calendar access is denied by the OS the test prints a CLEAR skip
//!   message and exits cleanly (no panic, no failure).
//! * If ZAI_API_KEY (or the macOS Keychain entry) is absent the test is
//!   skipped gracefully.
//!
//! # Running
//!
//! ```sh
//! cargo test --test live -- --ignored user_calendar_prep --nocapture
//! ```
//!
//! Mark: `#[tokio::test] #[ignore] #[serial(live_llm)]`

use std::time::{Duration, Instant};

use reqwest::Client;
use scopeguard::defer;
use serde::Deserialize;
use serde_json::json;
use serial_test::serial;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Tomorrow's date (hardcoded to the current "today" = 2026-04-20).
const TOMORROW_DATE: &str = "2026-04-21";
const TOMORROW_START_AS: &str = "2026-04-21 00:00:00";
const TOMORROW_END_AS: &str = "2026-04-21 23:59:59";

const TEST_EVENT_TITLE: &str = "Test Meeting with Sunny";
const TEST_EVENT_START: &str = "2026-04-21 10:00:00";
const TEST_EVENT_END: &str = "2026-04-21 11:00:00";

const GLM_URL: &str = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const GLM_MODEL: &str = "glm-5.1";

/// Cost ceiling per assertion: $0.005.
const MAX_COST_USD: f64 = 0.005;

// GLM-5.1 rates (Z.AI Coding Plan, per-million tokens).
const GLM_INPUT_PER_M: f64 = 0.40;
const GLM_OUTPUT_PER_M: f64 = 1.20;

// ---------------------------------------------------------------------------
// Wire types for GLM response
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
struct GlmUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
}

#[derive(Deserialize, Debug)]
struct GlmChoice {
    #[serde(default)]
    message: Option<GlmMessage>,
}

#[derive(Deserialize, Debug, Default)]
struct GlmMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GlmResponse {
    #[serde(default)]
    choices: Vec<GlmChoice>,
    #[serde(default)]
    usage: Option<GlmUsage>,
}

// ---------------------------------------------------------------------------
// Simple CalendarEvent for this test (mirrors crate::calendar::CalendarEvent)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CalEvent {
    id: String,
    title: String,
    start: String,
    end: String,
    location: String,
    calendar: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Run an AppleScript snippet via `osascript -e`. Returns `Err` on OS/timeout
/// failures and also maps the Calendar-permission error to a clear message.
async fn osascript(script: &str) -> Result<String, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "osascript timed out".to_string())?
    .map_err(|e| format!("osascript spawn failed: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        let lower = err.to_lowercase();
        if lower.contains("-1743")
            || lower.contains("not authorized")
            || lower.contains("not allowed")
            || lower.contains("doesn't have permission")
            || lower.contains("privacy")
        {
            return Err(format!(
                "CALENDAR_PERMISSION_DENIED: grant Calendar access in \
                 System Settings → Privacy & Security → Calendars → add Sunny"
            ));
        }
        return Err(format!("osascript: {}", err.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_string())
}

/// Parse the `|||`-separated event stream from our AppleScript emitter.
/// Field order: id ||| title ||| start ||| end ||| location ||| notes ||| calendar ||| allDay
fn parse_events(raw: &str) -> Vec<CalEvent> {
    raw.split("---EVTSEP---")
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let parts: Vec<&str> = line.split("|||").collect();
            if parts.len() < 7 {
                return None;
            }
            Some(CalEvent {
                id: parts[0].trim().to_string(),
                title: parts[1].trim().to_string(),
                start: parts[2].trim().to_string(),
                end: parts[3].trim().to_string(),
                location: parts[4].trim().to_string(),
                calendar: parts[6].trim().to_string(),
            })
        })
        .collect()
}

/// Filter events that start within tomorrow's date range (lexicographic on
/// the YYYY-MM-DD prefix — safe because the AppleScript helpers emit ISO-8601).
fn filter_tomorrow(events: &[CalEvent]) -> Vec<CalEvent> {
    events
        .iter()
        .filter(|e| e.start.starts_with(TOMORROW_DATE))
        .cloned()
        .collect()
}

/// Sort by start time (lexicographic ISO-8601 is chronological).
fn earliest_first(mut events: Vec<CalEvent>) -> Vec<CalEvent> {
    events.sort_by(|a, b| a.start.cmp(&b.start));
    events
}

/// Fetch tomorrow's events from Calendar.app.
async fn query_tomorrow() -> Result<Vec<CalEvent>, String> {
    // The AppleScript below uses the same helpers / separator scheme as
    // `calendar.rs` so the output is parseable by `parse_events`.
    let script = format!(
        r#"on _pad2(n)
    set n to n as integer
    if n < 10 then
        return "0" & (n as string)
    else
        return (n as string)
    end if
end _pad2

on _isoFromDate(d)
    set y to year of d
    set m to (month of d) as integer
    set dd to day of d
    set hh to hours of d
    set mm to minutes of d
    set ss to seconds of d
    return (y as string) & "-" & my _pad2(m) & "-" & my _pad2(dd) & "T" & my _pad2(hh) & ":" & my _pad2(mm) & ":" & my _pad2(ss)
end _isoFromDate

on _safe(s)
    try
        set t to s as string
    on error
        return ""
    end try
    set AppleScript's text item delimiters to {{return, linefeed, tab, "|||", "---EVTSEP---"}}
    set parts to text items of t
    set AppleScript's text item delimiters to " "
    set cleaned to parts as string
    set AppleScript's text item delimiters to ""
    return cleaned
end _safe

tell application "Calendar"
    set startBound to date "{start}"
    set endBound to date "{end}"
    set calList to calendars
    set outParts to {{}}
    repeat with c in calList
        set calName to (name of c as string)
        try
            set evs to (every event of c whose start date is greater than or equal to startBound and start date is less than or equal to endBound)
        on error
            set evs to {{}}
        end try
        repeat with ev in evs
            set evId to (uid of ev as string)
            set evTitle to my _safe(summary of ev)
            set evStart to my _isoFromDate(start date of ev)
            set evEnd to my _isoFromDate(end date of ev)
            set evLoc to my _safe(location of ev)
            set evNotes to my _safe(description of ev)
            set evAllDay to allday event of ev
            if evAllDay then
                set adFlag to "true"
            else
                set adFlag to "false"
            end if
            set evLine to evId & "|||" & evTitle & "|||" & evStart & "|||" & evEnd & "|||" & evLoc & "|||" & evNotes & "|||" & calName & "|||" & adFlag
            set end of outParts to evLine
        end repeat
    end repeat
    set AppleScript's text item delimiters to "---EVTSEP---"
    set outText to outParts as string
    set AppleScript's text item delimiters to ""
    return outText
end tell"#,
        start = TOMORROW_START_AS,
        end = TOMORROW_END_AS,
    );

    let raw = osascript(&script).await?;
    let all = parse_events(&raw);
    let tomorrow = filter_tomorrow(&all);
    Ok(tomorrow)
}

/// Create a test event on the first writable calendar, return its UID.
async fn create_test_event() -> Result<String, String> {
    let script = format!(
        r#"tell application "Calendar"
    set targetCal to (first calendar whose writable is true)
    set newEv to make new event at end of events of targetCal with properties {{summary:"{title}", start date: date "{start}", end date: date "{end}"}}
    return (uid of newEv as string)
end tell"#,
        title = TEST_EVENT_TITLE,
        start = TEST_EVENT_START,
        end = TEST_EVENT_END,
    );
    osascript(&script).await
}

/// Delete an event by UID.
async fn delete_event(uid: &str) -> Result<(), String> {
    let uid_escaped = uid.replace('"', "\\\"");
    let script = format!(
        r#"tell application "Calendar"
    set calList to calendars
    set didDelete to false
    repeat with c in calList
        if didDelete then exit repeat
        try
            set matches to (every event of c whose uid is "{uid}")
        on error
            set matches to {{}}
        end try
        repeat with ev in matches
            delete ev
            set didDelete to true
            exit repeat
        end repeat
    end repeat
    if didDelete then
        return "ok"
    else
        error "event not found: {uid}"
    end if
end tell"#,
        uid = uid_escaped,
    );
    osascript(&script).await.map(|_| ())
}

/// Resolve the ZAI API key from environment or macOS Keychain.
async fn resolve_zai_key() -> Option<String> {
    // 1. Check env var (works in CI / cargo test from terminal)
    if let Ok(k) = std::env::var("ZAI_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    // 2. Keychain (mirrors crate::secrets Keychain lookup)
    let output = tokio::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "sunny.zai",
            "-a",
            "sunny",
            "-w",
        ])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let key = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    None
}

/// Call GLM-5.1 for prep notes. Returns (prep_text, cost_usd).
async fn generate_prep_notes(
    api_key: &str,
    event: &CalEvent,
) -> Result<(String, f64), String> {
    let prompt = format!(
        "You're Sunny. For this meeting, produce \
        (a) a 1-paragraph context summary, \
        (b) 3 likely topics, \
        (c) 3 questions to ask. \
        Meeting: {title}, {start} – {end}, \
        attendees: (unknown), location: {loc}.",
        title = event.title,
        start = event.start,
        end = event.end,
        loc = if event.location.is_empty() {
            "not specified"
        } else {
            &event.location
        },
    );

    let body = json!({
        "model": GLM_MODEL,
        "messages": [
            {"role": "system", "content": "You are Sunny, a helpful AI assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 1024,
        "stream": false,
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;

    let started = Instant::now();
    let resp = client
        .post(GLM_URL)
        .header("authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("glm connect: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("glm http {status}: {text}"));
    }

    let parsed: GlmResponse = resp
        .json()
        .await
        .map_err(|e| format!("glm decode: {e}"))?;

    let elapsed = started.elapsed();

    let usage = parsed.usage.unwrap_or_default();
    let cost_usd = (usage.prompt_tokens as f64 / 1_000_000.0) * GLM_INPUT_PER_M
        + (usage.completion_tokens as f64 / 1_000_000.0) * GLM_OUTPUT_PER_M;

    let msg = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message)
        .unwrap_or_default();

    let text = msg
        .content
        .filter(|s| !s.trim().is_empty())
        .or(msg.reasoning_content)
        .unwrap_or_default();

    println!(
        "[glm] tokens: in={} out={} cost=${:.6} duration={}ms",
        usage.prompt_tokens,
        usage.completion_tokens,
        cost_usd,
        elapsed.as_millis()
    );

    Ok((text, cost_usd))
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
#[serial(live_llm)]
async fn user_calendar_prep() {
    // ── 1. Resolve ZAI key ─────────────────────────────────────────────────
    let api_key = match resolve_zai_key().await {
        Some(k) => k,
        None => {
            println!("SKIP: ZAI_API_KEY not found in env or Keychain — skipping test");
            return;
        }
    };

    // ── 2. Query calendar for tomorrow ────────────────────────────────────
    let mut tomorrow_events = match query_tomorrow().await {
        Ok(evts) => evts,
        Err(e) if e.starts_with("CALENDAR_PERMISSION_DENIED") => {
            println!("SKIP: {e}");
            return;
        }
        Err(e) => {
            panic!("calendar query failed: {e}");
        }
    };

    // ── 3. Create test event if calendar is empty ──────────────────────────
    let mut test_event_uid: Option<String> = None;

    if tomorrow_events.is_empty() {
        println!("Calendar is empty for tomorrow — creating test event");
        match create_test_event().await {
            Ok(uid) => {
                println!("Created test event UID: {uid}");
                test_event_uid = Some(uid.clone());

                // Re-query to pick up the newly created event.
                tokio::time::sleep(Duration::from_millis(500)).await;
                match query_tomorrow().await {
                    Ok(evts) => tomorrow_events = evts,
                    Err(e) => {
                        // Clean up before failing.
                        let _ = delete_event(&uid).await;
                        panic!("calendar re-query failed after create: {e}");
                    }
                }
            }
            Err(e) if e.starts_with("CALENDAR_PERMISSION_DENIED") => {
                println!("SKIP: {e}");
                return;
            }
            Err(e) => {
                panic!("create_test_event failed: {e}");
            }
        }
    }

    // Ensure cleanup runs even if the test panics below.
    let uid_for_cleanup = test_event_uid.clone();
    defer! {
        if let Some(uid) = uid_for_cleanup {
            // Spawn a blocking cleanup — defer runs synchronously so we
            // use std::process::Command as a fallback.
            let script = format!(
                r#"tell application "Calendar"
    set calList to calendars
    repeat with c in calList
        try
            set matches to (every event of c whose uid is "{uid}")
        on error
            set matches to {{}}
        end try
        repeat with ev in matches
            delete ev
            exit repeat
        end repeat
    end repeat
end tell"#,
                uid = uid.replace('"', "\\\""),
            );
            let _ = std::process::Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .status();
            println!("Deleted test event UID: {uid}");
        }
    }

    // ── 4. Display all tomorrow events ────────────────────────────────────
    let sorted = earliest_first(tomorrow_events);

    println!("\n=== Tomorrow's Events ({TOMORROW_DATE}) ===");
    if sorted.is_empty() {
        println!("  (none — calendar may have denied access or event creation failed)");
        println!("SKIP: no events to prep for");
        return;
    }

    println!("{:<30} {:<20} {:<20} {}", "Title", "Start", "End", "Calendar");
    println!("{}", "-".repeat(80));
    for ev in &sorted {
        println!(
            "{:<30} {:<20} {:<20} {}",
            ev.title, ev.start, ev.end, ev.calendar
        );
    }

    // ── 5. Pick earliest event ────────────────────────────────────────────
    let first = &sorted[0];
    println!("\nFirst event picked: \"{}\" at {}", first.title, first.start);

    // ── 6. Generate prep notes via GLM-5.1 ───────────────────────────────
    println!("\nCalling GLM-5.1 for prep notes…");
    let (prep_notes, cost_usd) = match generate_prep_notes(&api_key, first).await {
        Ok(result) => result,
        Err(e) => panic!("GLM call failed: {e}"),
    };

    // ── 7. Print prep notes ───────────────────────────────────────────────
    println!("\n=== Prep Notes ===");
    println!("{prep_notes}");
    println!("\nCost: ${cost_usd:.6}");

    // ── 8. Assertions ─────────────────────────────────────────────────────
    // Calendar query returned Vec<CalEvent> (may be empty — handled above)
    assert!(
        !sorted.is_empty(),
        "Expected at least one tomorrow event after create_test_event"
    );

    // Prep notes must be non-empty and ≥ 150 chars
    assert!(
        !prep_notes.trim().is_empty(),
        "Prep notes must be non-empty"
    );
    assert!(
        prep_notes.len() >= 150,
        "Prep notes too short ({} chars, need ≥ 150): {prep_notes}",
        prep_notes.len()
    );

    // Prep notes must reference the event title (case-insensitive)
    let title_lower = first.title.to_lowercase();
    // Allow partial match for longer titles; check first 20 chars
    let title_fragment: String = title_lower.chars().take(20).collect();
    assert!(
        prep_notes.to_lowercase().contains(&title_fragment),
        "Prep notes don't reference the event title '{}': {prep_notes}",
        first.title
    );

    // Cost must be < $0.005
    assert!(
        cost_usd < MAX_COST_USD,
        "Cost ${cost_usd:.6} exceeds ceiling ${MAX_COST_USD}"
    );

    // ── 9. Async cleanup (belt-and-suspenders; defer handles the sync path) ──
    if let Some(uid) = test_event_uid {
        match delete_event(&uid).await {
            Ok(()) => println!("Test event deleted cleanly (async path)"),
            Err(e) => println!("Warning: async delete failed ({e}); sync defer will retry"),
        }
    }
}
