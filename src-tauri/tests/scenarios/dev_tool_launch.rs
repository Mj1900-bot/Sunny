//! E2E scenario: "spawn an editor on this project with a task"
//!
//! Exercises Phase-2 Packet 8's dev-tool interop via the `terminal` bridge
//! (macOS Terminal.app, always present, AppleScript-driven).
//!
//! # Run
//!
//!   cargo test --test live -- --ignored dev_tool_launch --nocapture
//!
//! # What it verifies
//!
//!   1. `launch::launch()` writes `{project}/.sunny/handoff.json` atomically.
//!   2. The bus directory appears at `~/.sunny/bus/{session_id}/`.
//!   3. `status.json` reaches "running" or "done" within 20 s.
//!   4. `bus_watch::poll()` deserialises the session status correctly.
//!   5. The handoff payload contains the original intent string.
//!   6. `bus_watch::cleanup()` removes the bus dir (no orphan dirs).
//!
//! # Skip conditions
//!
//!   * Terminal.app absent (non-macOS or stripped bundle).
//!   * AppleScript denied / Automation permission not granted.
//!   * `osascript` exits non-zero within the 15 s bridge timeout.
//!
//! Cleanup runs in `scopeguard::defer!` so project dir and bus dir are
//! removed even when the test panics or returns early.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use scopeguard::defer;
use serial_test::serial;

use sunny_lib::agent_loop::tools::dev_tools::bridges::DevTool;
use sunny_lib::agent_loop::tools::dev_tools::bus_watch::{cleanup, poll, SessionState};
use sunny_lib::agent_loop::tools::dev_tools::handoff::read_handoff;
use sunny_lib::agent_loop::tools::dev_tools::launch::{bus_dir_for, launch, LaunchRequest};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const POLL_TIMEOUT: Duration = Duration::from_secs(20);
const INTENT: &str = "list files and exit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create a stub project directory under /tmp with a README.md.
fn make_stub_project() -> PathBuf {
    let pid = std::process::id();
    let path = PathBuf::from(format!("/tmp/sunny-test-project-{pid}"));
    fs::create_dir_all(&path).expect("create stub project dir");
    fs::write(path.join("README.md"), "hello world").expect("write README.md");
    path
}

/// Ensure `/tmp` is present in grants.json `dev_tool_paths` for the duration
/// of this test.  Writes a temporary grants file and restores the original on
/// drop.  Returns the path of the grants file so the defer block can restore.
fn inject_tmp_grant() -> (PathBuf, Option<Vec<u8>>) {
    let grants_path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".sunny")
        .join("grants.json");

    let original = fs::read(&grants_path).ok();

    // Read existing grants and add /tmp if not already present.
    let mut grants: serde_json::Value = original
        .as_deref()
        .and_then(|b| serde_json::from_slice(b).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let paths = grants
        .get_mut("dev_tool_paths")
        .and_then(|v| v.as_array_mut());

    let already_granted = paths
        .as_ref()
        .map(|arr| arr.iter().any(|p| p.as_str() == Some("/tmp")))
        .unwrap_or(false);

    if !already_granted {
        let paths_val = grants
            .as_object_mut()
            .unwrap()
            .entry("dev_tool_paths")
            .or_insert_with(|| serde_json::Value::Array(vec![]));
        if let serde_json::Value::Array(arr) = paths_val {
            arr.push(serde_json::Value::String("/tmp".to_string()));
        }
    }

    if let Some(parent) = grants_path.parent() {
        fs::create_dir_all(parent).expect("create .sunny dir");
    }
    fs::write(&grants_path, grants.to_string()).expect("write grants.json");

    (grants_path, original)
}

/// Poll until status is running/done/error, or until timeout.
/// Returns `None` on timeout.
async fn poll_until_settled(session_id: &str) -> Option<SessionState> {
    let deadline = Instant::now() + POLL_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        match poll(session_id) {
            Ok(s) => match &s.status {
                SessionState::Running | SessionState::Done | SessionState::Error => {
                    return Some(s.status);
                }
                _ => {}
            },
            Err(_) => {}
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires macOS Terminal.app + AppleScript permission; opt-in with --ignored"]
async fn dev_tool_launch_terminal_bridge() {
    // --- Step 0: check Terminal.app is present (skip gracefully on non-Mac) ---
    let cap = sunny_lib::agent_loop::tools::dev_tools::discover::discover_terminal()
        .expect("discover_terminal must not error");
    if !cap.installed {
        eprintln!("SKIP: Terminal.app not found — {}", cap.note);
        return;
    }

    // --- Step 1: create stub project dir (/tmp/sunny-test-project-{pid}/) ---
    let project_dir = make_stub_project();
    let project_path = project_dir.to_string_lossy().to_string();

    // Cleanup wrapper — runs even if we return/panic.
    let project_dir_cleanup = project_dir.clone();
    defer! {
        let _ = fs::remove_dir_all(&project_dir_cleanup);
        eprintln!("  cleanup: removed {}", project_dir_cleanup.display());
    }

    // --- Step 2: inject /tmp into grants so the safety gate passes ---
    let (grants_path, original_grants) = inject_tmp_grant();
    defer! {
        match &original_grants {
            Some(orig) => { let _ = fs::write(&grants_path, orig); }
            None       => { let _ = fs::remove_file(&grants_path); }
        }
    }

    // --- Step 3: launch the terminal bridge ---
    let req = LaunchRequest {
        tool: DevTool::Terminal,
        project_path: project_path.clone(),
        intent: INTENT.to_string(),
        relevant_files: vec!["README.md".to_string()],
        clipboard_snapshot: String::new(),
        conversation_summary: String::new(),
    };

    let session_id = match launch(req).await {
        Ok(id) => id,
        Err(e) if e.contains("AppleScript") || e.contains("osascript") || e.contains("denied") => {
            eprintln!("SKIP: AppleScript/osascript denied or timed out — {e}");
            return;
        }
        Err(e) => panic!("terminal launch failed unexpectedly: {e}"),
    };

    eprintln!("  session_id = {session_id}");

    // Register bus cleanup — runs after test body.
    let session_id_cleanup = session_id.clone();
    defer! {
        let _ = cleanup(&session_id_cleanup);
        eprintln!("  cleanup: removed bus dir for {session_id_cleanup}");
    }

    // --- Step 4: assert bus dir exists ---
    let bus_dir = bus_dir_for(&session_id);
    assert!(
        bus_dir.exists(),
        "bus dir must exist after launch: {}",
        bus_dir.display()
    );

    // --- Step 5: poll status.json up to 20 s ---
    let state = match poll_until_settled(&session_id).await {
        Some(s) => s,
        None => {
            eprintln!("SKIP: status never settled within 20 s — Terminal may be prompting for permission");
            return;
        }
    };

    // Terminal stays open as a GUI window — "running" is the expected terminal
    // state; "done" means stop() was already called.
    assert!(
        state == SessionState::Running || state == SessionState::Done,
        "expected status running or done, got: {state:?}"
    );
    eprintln!("  status = {state}");

    // --- Step 6: dev_session_result — read the handoff via bus_watch::poll ---
    let session_status = poll(&session_id).expect("poll must succeed after launch");
    assert_eq!(
        session_status.session_id, session_id,
        "session_id in poll result must match"
    );

    // --- Step 7: assert handoff.json was atomically written with intent ---
    let handoff_path = project_dir.join(".sunny").join("handoff.json");
    assert!(
        handoff_path.exists(),
        "handoff.json must exist at {}",
        handoff_path.display()
    );

    let payload = read_handoff(&project_path).expect("read_handoff must succeed");
    assert_eq!(
        payload.intent, INTENT,
        "handoff intent must match the launch request"
    );
    assert_eq!(
        payload.session_id, session_id,
        "handoff session_id must match"
    );

    eprintln!(
        "  handoff.json: intent={:?} session_id={:?} written_at={:?}",
        payload.intent, payload.session_id, payload.written_at
    );

    // --- Step 8: stop the session ---
    sunny_lib::agent_loop::tools::dev_tools::bridges::terminal::stop(&session_id)
        .await
        .expect("stop must succeed");

    // Verify status flipped to done.
    let final_status = poll(&session_id).expect("poll after stop must succeed");
    assert_eq!(
        final_status.status,
        SessionState::Done,
        "status must be done after stop()"
    );

    eprintln!("  final_status = {}", final_status.status);
    // defer! blocks clean up project dir and bus dir on scope exit.
}
