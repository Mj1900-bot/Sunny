//! Scenario: "remind me in 30 minutes to take a break"
//!
//! End-to-end exercise of the L9 scheduler path:
//!   1. Parse "in 30 minutes" via `parse_natural_time`.
//!   2. Persist a `ScheduleEntry` to a temp `~/.sunny`-shaped dir.
//!   3. Verify `fire_at` ≈ now + 1800 s and the file contains the new entry.
//!   4. Simulate firing: call `advance_after_fire` with synthetic_now = fire_at + 1.
//!   5. Emit a real macOS notification via `osascript display notification`.
//!   6. Clean up: remove the synthetic entry.
//!
//! No `#[ignore]` — pure local, no LLM, no external services.
//! Run: cargo test --test live user_reminder_30min --nocapture

use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::time::timeout;

use sunny_lib::agent_loop::tools::scheduler::parse_time::parse_natural_time;
use sunny_lib::agent_loop::tools::scheduler::store::{
    advance_after_fire, load_from, new_id, save_to, ScheduleEntry, ScheduleKind,
};

// ---------------------------------------------------------------------------
// Temp scratch directory — auto-cleaned on drop
// ---------------------------------------------------------------------------

struct ScratchDir {
    path: std::path::PathBuf,
}

impl ScratchDir {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sunny-reminder-test-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create scratch dir");
        Self { path }
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// ---------------------------------------------------------------------------
// Helper: emit macOS notification via osascript (no Tauri required)
// ---------------------------------------------------------------------------

async fn emit_notification(title: &str, body: &str) -> Result<String, String> {
    let script = format!(
        r#"display notification "{body}" with title "{title}""#,
        body = body.replace('"', "\\\""),
        title = title.replace('"', "\\\""),
    );
    let output = timeout(
        Duration::from_secs(10),
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output(),
    )
    .await
    .map_err(|_| "osascript timed out".to_string())?
    .map_err(|e| format!("osascript spawn failed: {e}"))?;

    if output.status.success() {
        Ok(format!("osascript display notification OK (exit 0) — title={title:?} body={body:?}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("osascript failed: {stderr}"))
    }
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

#[tokio::test]
async fn user_reminder_30min() {
    // ── Step 1: classify + parse NL time ─────────────────────────────────────
    // The user command "remind me in 30 minutes to take a break" maps to a
    // SchedulingRequest. We parse the time component directly.

    let now_unix: i64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_secs() as i64;

    let fire_at = parse_natural_time("in 30 minutes", now_unix)
        .expect("parse_natural_time('in 30 minutes') must succeed");

    let expected_fire_at = now_unix + 30 * 60;
    let delta = (fire_at - expected_fire_at).abs();
    assert!(
        delta <= 2,
        "fire_at={fire_at} expected≈{expected_fire_at} delta={delta}s (must be ≤2)"
    );

    println!("PARSE  fire_at={fire_at}  now={now_unix}  offset={}s", fire_at - now_unix);

    // ── Step 2: build ScheduleEntry and persist ───────────────────────────────

    let scratch = ScratchDir::new();
    let sched_id = new_id();

    let entry = ScheduleEntry {
        id: sched_id.clone(),
        title: "take a break reminder".to_string(),
        prompt: "remind me to take a break".to_string(),
        kind: ScheduleKind::Once,
        cron_wire: None,
        fire_at: Some(fire_at),
        next_fire: Some(fire_at),
        enabled: true,
        fail_count: 0,
        dead_letter: false,
        daemon_id: format!("synthetic-daemon-{sched_id}"),
        requires_confirm: false,
        history: vec![],
        created_at: now_unix,
    };

    // Capture file size before write.
    let file_path = scratch.path.join("schedules.json");
    let size_before = if file_path.exists() {
        file_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    save_to(&scratch.path, &[entry.clone()]).expect("save_to must succeed (atomic write)");

    let size_after = file_path
        .metadata()
        .expect("schedules.json must exist after save")
        .len();

    println!(
        "PERSIST schedule_id={sched_id}  file_before={size_before}B  file_after={size_after}B"
    );

    assert!(
        size_after > size_before,
        "schedules.json should grow after writing entry (before={size_before} after={size_after})"
    );

    // ── Step 3: reload and verify entry ──────────────────────────────────────

    let loaded = load_from(&scratch.path).expect("load_from must succeed");
    assert_eq!(loaded.len(), 1, "exactly one entry expected; got {}", loaded.len());

    let loaded_entry = &loaded[0];
    assert_eq!(loaded_entry.id, sched_id, "schedule id round-trips correctly");
    assert_eq!(
        loaded_entry.fire_at,
        Some(fire_at),
        "fire_at persists correctly"
    );
    assert_eq!(loaded_entry.enabled, true);
    assert_eq!(loaded_entry.kind, ScheduleKind::Once);

    // ── Step 4: simulate firing (synthetic_now = fire_at + 1) ────────────────

    let synthetic_now = fire_at + 1;
    let updated = advance_after_fire(
        loaded_entry,
        synthetic_now,
        "ok",
        "Reminder fired: take a break",
    );

    // Once-shots must be disabled after any fire attempt.
    assert!(
        !updated.enabled,
        "once-shot must be disabled after fire; enabled={}",
        updated.enabled
    );
    assert!(
        updated.next_fire.is_none(),
        "next_fire must be None after once-shot fires"
    );
    assert_eq!(
        updated.history.len(),
        1,
        "history must have exactly one record"
    );
    assert_eq!(updated.history[0].status, "ok");
    assert_eq!(updated.history[0].fired_at, synthetic_now);

    println!(
        "SIMULATE synthetic_now={synthetic_now}  enabled={}  next_fire={:?}  history_len={}",
        updated.enabled,
        updated.next_fire,
        updated.history.len()
    );

    // ── Step 5: emit macOS notification via osascript ─────────────────────────

    let notif_result = emit_notification("Sunny Reminder", "Take a break").await;
    match &notif_result {
        Ok(msg) => println!("NOTIFY {msg}"),
        Err(e) => println!("NOTIFY skipped (non-fatal): {e}"),
    }
    // Notification failure is non-fatal — some CI environments lack a
    // notification daemon.  The important path is the schedule logic above.

    // ── Step 6: clean up ─────────────────────────────────────────────────────
    // scratch.drop() removes the temp dir, but we also persist the updated
    // (fired/disabled) state to demonstrate that atomic-write cleanup works.

    save_to(&scratch.path, &[updated]).expect("save updated (fired) entry must succeed");
    let final_loaded = load_from(&scratch.path).expect("final load must succeed");
    assert_eq!(
        final_loaded.len(),
        1,
        "one entry (disabled) after cleanup write"
    );
    assert!(
        !final_loaded[0].enabled,
        "persisted entry must still be disabled"
    );

    println!(
        "CLEANUP final schedule file has {} entry/entries; entry enabled={}",
        final_loaded.len(),
        final_loaded[0].enabled
    );

    // ScratchDir drop removes the temp directory — synthetic schedule entry gone.
    drop(scratch);

    println!("DONE  schedule_id={sched_id}  fire_at={fire_at}  delta_from_expected={delta}s");
}
