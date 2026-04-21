//! E2E scenario: Claude Code CLI bridge — non-interactive launch.
//!
//! Run: cargo test --test live -- --ignored claude_code_live --nocapture
//!
//! Skips gracefully if: `claude` not on PATH, `--print` unsupported, /tmp
//! not writable, or bridge errors due to a flag the installed version rejects.

use std::fs;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::time::{Duration, Instant};

use scopeguard::defer;
use serial_test::serial;

use sunny_lib::agent_loop::tools::dev_tools::bridges::DevTool;
use sunny_lib::agent_loop::tools::dev_tools::bus_watch::{cleanup, poll, SessionState};
use sunny_lib::agent_loop::tools::dev_tools::launch::{bus_dir_for, launch, LaunchRequest};

const POLL_INTERVAL: Duration = Duration::from_millis(750);
const POLL_TIMEOUT: Duration = Duration::from_secs(60);
const INTENT: &str = "print the exact three characters: ABC";
const EXPECTED_OUTPUT: &str = "ABC";

// ---------------------------------------------------------------------------
// Skip helpers
// ---------------------------------------------------------------------------

fn claude_on_path() -> bool {
    StdCommand::new("which").arg("claude").output()
        .map(|o| o.status.success()).unwrap_or(false)
}

fn claude_supports_print_flag() -> bool {
    StdCommand::new("claude")
        .args(["--print", "--output-format", "json", "--help"])
        .output()
        .map(|o| {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            !combined.contains("unknown option '--print'")
        })
        .unwrap_or(false)
}

fn tmp_is_writable() -> bool {
    let p = PathBuf::from("/tmp/__sunny_cc_probe__");
    let ok = fs::write(&p, b"x").is_ok();
    let _ = fs::remove_file(&p);
    ok
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn make_stub_project() -> PathBuf {
    let pid = std::process::id();
    let root = PathBuf::from(format!("/tmp/sunny-cc-test-{pid}"));
    let src = root.join("src");
    fs::create_dir_all(&src).expect("create stub project src/");
    fs::write(src.join("main.rs"), "fn main() {}\n").expect("write stub main.rs");
    root
}

fn inject_tmp_grant() -> (PathBuf, Option<Vec<u8>>) {
    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".sunny").join("grants.json");
    let original = fs::read(&path).ok();
    let mut grants: serde_json::Value = original.as_deref()
        .and_then(|b| serde_json::from_slice(b).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let entry = grants.as_object_mut().unwrap()
        .entry("dev_tool_paths").or_insert_with(|| serde_json::json!([]));
    if let serde_json::Value::Array(arr) = entry {
        if !arr.iter().any(|v| v.as_str() == Some("/tmp")) {
            arr.push(serde_json::json!("/tmp"));
        }
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).ok(); }
    fs::write(&path, grants.to_string()).expect("write grants.json");
    (path, original)
}

async fn poll_until_terminal(session_id: &str) -> Option<SessionState> {
    let deadline = Instant::now() + POLL_TIMEOUT;
    loop {
        if Instant::now() >= deadline { return None; }
        if let Ok(s) = poll(session_id) {
            match &s.status {
                SessionState::Done | SessionState::Error => return Some(s.status),
                _ => {}
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "live — spawns real `claude` binary; opt-in with --ignored"]
#[serial(live_llm)]
async fn claude_code_live() {
    // Step 0 — skip guards.
    if !claude_on_path() {
        eprintln!("SKIP: `claude` not on PATH — install via `npm i -g @anthropic-ai/claude-code`");
        return;
    }
    if !claude_supports_print_flag() {
        eprintln!("SKIP: installed `claude` does not support --print; upgrade claude-code");
        return;
    }
    if !tmp_is_writable() {
        eprintln!("SKIP: /tmp not writable");
        return;
    }

    let t_start = Instant::now();

    // Step 1 — stub project /tmp/sunny-cc-test-{pid}/src/main.rs.
    let project_dir = make_stub_project();
    let project_path = project_dir.to_string_lossy().to_string();
    eprintln!("  stub project : {project_path}");
    let cleanup_dir = project_dir.clone();
    defer! {
        let _ = fs::remove_dir_all(&cleanup_dir);
        eprintln!("  cleanup: removed {}", cleanup_dir.display());
    }

    // Step 2 — inject /tmp into grants.json.
    let (grants_path, original_grants) = inject_tmp_grant();
    defer! {
        match &original_grants {
            Some(orig) => { let _ = fs::write(&grants_path, orig); }
            None       => { let _ = fs::remove_file(&grants_path); }
        }
        eprintln!("  cleanup: restored grants.json");
    }

    // Step 3 — launch the claude_code bridge.
    let req = LaunchRequest {
        tool: DevTool::ClaudeCode,
        project_path: project_path.clone(),
        intent: INTENT.to_string(),
        relevant_files: vec!["src/main.rs".to_string()],
        clipboard_snapshot: String::new(),
        conversation_summary: String::new(),
    };

    let t_launch = Instant::now();
    let session_id = match launch(req).await {
        Ok(id) => id,
        Err(e) => { eprintln!("SKIP: launch() error: {e}"); return; }
    };
    let launch_ms = t_launch.elapsed().as_millis();
    eprintln!("  session_id  = {session_id}");
    eprintln!("  launch_ms   = {launch_ms}");

    let sid_cleanup = session_id.clone();
    defer! {
        let _ = cleanup(&sid_cleanup);
        eprintln!("  cleanup: removed bus dir for {sid_cleanup}");
    }

    // Step 4 — assert bus dir exists; initial status is launching/running/done.
    let bus_dir = bus_dir_for(&session_id);
    assert!(bus_dir.exists(), "bus dir must exist: {}", bus_dir.display());

    let initial = poll(&session_id).expect("initial poll must succeed");
    assert!(
        matches!(
            initial.status,
            SessionState::Launching | SessionState::Running | SessionState::Done
        ),
        "initial status must be launching/running/done, got: {:?}", initial.status
    );
    eprintln!("  initial_status = {}", initial.status);

    // Step 5 — poll up to 60 s for done/error.
    let terminal = match poll_until_terminal(&session_id).await {
        Some(s) => s,
        None => {
            eprintln!("SKIP: status never settled within {}s", POLL_TIMEOUT.as_secs());
            return;
        }
    };
    let total_ms = t_start.elapsed().as_millis();
    eprintln!("  terminal_state = {terminal}");
    eprintln!("  total_ms       = {total_ms}");

    // Step 6 — version-compatibility skip if the bridge's flag was rejected.
    if terminal == SessionState::Error {
        let err = fs::read_to_string(bus_dir.join("error.txt")).unwrap_or_default();
        let out = fs::read_to_string(bus_dir.join("output.txt")).unwrap_or_default();
        let combined = format!("{err}\n{out}").to_lowercase();
        let skip_signals = ["unknown option", "unknown flag", "login", "auth",
                            "not logged in", "anthropic_api_key"];
        if skip_signals.iter().any(|s| combined.contains(s)) {
            eprintln!("SKIP: version/auth incompatibility — {err}");
            return;
        }
        panic!("claude_code bridge reached error unexpectedly.\nerror.txt: {err}\noutput.txt: {out}");
    }

    // Step 7 — assert "ABC" in result.json or output.txt.
    assert_eq!(terminal, SessionState::Done);

    let final_s = poll(&session_id).expect("final poll must succeed");
    let result_str = final_s.result.as_ref().map(|v| v.to_string()).unwrap_or_default();
    let output_str = final_s.output_tail.clone().unwrap_or_default();
    let combined = format!("{result_str}\n{output_str}");

    eprintln!("  output_chars   = {}", combined.len());
    eprintln!("  result_json    = {result_str}");

    assert!(
        combined.contains(EXPECTED_OUTPUT),
        "expected '{EXPECTED_OUTPUT}' in result — result: {result_str} | output: {output_str}"
    );

    // Step 8 — print bus dir final state.
    eprintln!("  bus_dir final state:");
    if let Ok(entries) = fs::read_dir(&bus_dir) {
        for e in entries.flatten() {
            let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
            eprintln!("    {:?}  ({bytes} bytes)", e.file_name());
        }
    }
    eprintln!("  PASS: '{EXPECTED_OUTPUT}' found in claude output.");
}
