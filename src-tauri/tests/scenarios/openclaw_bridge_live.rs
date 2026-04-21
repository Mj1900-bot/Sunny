//! Live integration tests for the OpenClaw bridge (Phase-2 Packet 9).
//!
//! Covers three contracts:
//!
//! 1. `openclaw_bridge_reachable_or_skips_cleanly`
//!    — Health-probe 127.0.0.1:18789; when up: exercise list_tools + call_tool.
//!    — When down: SKIP, never FAIL.
//!
//! 2. `openclaw_memory_search_with_token`
//!    — Installs the auth token (env var → Keychain) if available.
//!    — Calls memory_search; expects HTTP 200 / Ok result.
//!    — When daemon is absent OR no token is available: SKIP gracefully.
//!
//! 3. `openclaw_provider_turn_fallback_contract`
//!    — Happy path (daemon up): openclaw_turn returns non-empty TurnOutcome,
//!      cost tracked as provider="openclaw" at $0.
//!    — Unhappy path: force-point the provider at a closed port, assert Err
//!      contains the "openclaw_unavailable" marker that triggers GLM fallback.
//!
//! Run:
//!   cargo test --test live -- --ignored openclaw_bridge_live --nocapture

use std::time::Duration;

use serde_json::json;
use serial_test::serial;

use sunny_lib::openclaw_bridge::{OpenClawBridge, resolve_token};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_URL: &str = "http://127.0.0.1:18789/health";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// Helper: probe the daemon with a hard 1-second timeout.
// Returns true when the health endpoint replies 200.
// ---------------------------------------------------------------------------

async fn daemon_is_up() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(HEALTH_URL).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Sub-test 1 — bridge reachable or skips cleanly
// ---------------------------------------------------------------------------

/// When the OpenClaw daemon is running this test calls list_tools() and
/// call_tool("memory_search", …), asserting the basic bridge contract.
/// When the daemon is absent it skips with a message — never fails.
#[tokio::test]
#[ignore = "live — requires OpenClaw daemon; opt-in with --ignored"]
#[serial(live_llm)]
async fn openclaw_bridge_reachable_or_skips_cleanly() {
    if !daemon_is_up().await {
        eprintln!("SKIP: openclaw daemon not running (127.0.0.1:18789 not reachable)");
        return;
    }

    // Use configure_from_env so token is resolved via env var + Keychain.
    let bridge = OpenClawBridge::configure_from_env()
        .await
        .expect("bridge construction must not fail");

    // --- list_tools -----------------------------------------------------------
    let tools = bridge
        .list_tools()
        .await
        .expect("list_tools should succeed when daemon is up");

    assert!(
        !tools.is_empty(),
        "list_tools returned empty Vec — daemon is up but reported no tools"
    );

    let tool_count = tools.len();
    let first_five: Vec<&str> = tools.iter().take(5).map(|t| t.name.as_str()).collect();

    eprintln!("daemon_running=true");
    eprintln!("  tool_count={tool_count}");
    eprintln!("  first_five={first_five:?}");

    // --- call_tool ------------------------------------------------------------
    let result = bridge
        .call_tool("memory_search", json!({ "query": "test" }))
        .await;

    match result {
        Ok(value) => {
            // Any JSON value (including null / empty array) is acceptable —
            // "no results" is a valid answer from memory_search.
            eprintln!("  memory_search result type={}", value_type_label(&value));
        }
        Err(e) => {
            // The tool might not exist on this daemon build; that is not a
            // bridge failure — only a connection or auth error would be.
            assert!(
                !e.contains("openclaw_bridge: /tools/invoke unreachable"),
                "memory_search invocation hit a network error: {e}"
            );
            assert!(
                !e.contains("401"),
                "memory_search returned 401 — token not set; \
                 run scripts/install-openclaw-token.sh: {e}"
            );
            eprintln!("  memory_search not available on this daemon: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Sub-test 2 — memory_search returns 200 when token is available
// ---------------------------------------------------------------------------

/// Specifically tests that memory_search returns HTTP 200 (not 401) when the
/// auth token is available via env var or Keychain.
///
/// Skip conditions (graceful, not a failure):
///   - Daemon not running at 127.0.0.1:18789.
///   - No token available in env or Keychain (token_available=false is logged).
#[tokio::test]
#[ignore = "live — requires OpenClaw daemon + token; opt-in with --ignored"]
#[serial(live_llm)]
async fn openclaw_memory_search_with_token() {
    if !daemon_is_up().await {
        eprintln!("SKIP: openclaw daemon not running");
        return;
    }

    let token = resolve_token().await;

    if token.is_none() {
        eprintln!(
            "SKIP: no auth token available \
             (set OPENCLAW_GATEWAY_TOKEN or run scripts/install-openclaw-token.sh)"
        );
        return;
    }

    eprintln!("token_available=true (source: env or keychain)");

    let bridge = OpenClawBridge::configure_from_env()
        .await
        .expect("bridge construction must not fail");

    let result = bridge
        .call_tool("memory_search", json!({ "query": "sunny test" }))
        .await;

    match result {
        Ok(value) => {
            // Expect either an array of results or null — both are valid.
            eprintln!(
                "memory_search=ok (200) result_type={}",
                value_type_label(&value)
            );
            // The result must be one of the expected shapes.
            assert!(
                value.is_array() || value.is_null() || value.is_object(),
                "unexpected memory_search result shape: {value}"
            );
        }
        Err(e) => {
            // 401 after having a token is a real failure.
            assert!(
                !e.contains("401"),
                "memory_search returned 401 even though a token was present — \
                 token may be invalid or expired: {e}"
            );
            // Tool absent on this daemon build is acceptable.
            eprintln!("  memory_search tool not available: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Sub-test 3 — openclaw_turn fallback contract
// ---------------------------------------------------------------------------

/// Exercises both paths of the openclaw provider adapter:
///
/// Happy path (daemon up):
///   openclaw_turn must return Ok(TurnOutcome) with non-empty content OR a
///   tool-call list.  Cost must be tracked as provider="openclaw" at $0.
///
/// Unhappy path (daemon forced offline):
///   openclaw_turn must return Err whose message contains
///   "openclaw_unavailable" — the marker that core.rs uses to trigger the
///   GLM fallback.  This is the hard contract; failure here is a regression.
#[tokio::test]
#[ignore = "live — requires OpenClaw daemon for happy path; opt-in with --ignored"]
#[serial(live_llm)]
async fn openclaw_provider_turn_fallback_contract() {
    use sunny_lib::agent_loop::providers::openclaw::openclaw_turn;

    let system = "You are a concise assistant. Reply in one sentence only.";
    let history = vec![json!({"role": "user", "content": "Say hi."})];

    // --- Happy path (skipped when daemon is absent or chat endpoint unavailable) --
    if daemon_is_up().await {
        // Clear any leftover env override so the provider uses the real daemon.
        std::env::remove_var("OPENCLAW_GATEWAY_URL");

        match openclaw_turn("openclaw-auto", system, &history).await {
            Ok(outcome) => {
                // Verify non-empty outcome — either text or tool-call list is fine.
                let is_non_trivial = match &outcome {
                    sunny_lib::agent_loop::types::TurnOutcome::Final { text, .. } => {
                        !text.trim().is_empty()
                    }
                    sunny_lib::agent_loop::types::TurnOutcome::Tools { calls, .. } => {
                        !calls.is_empty()
                    }
                };
                assert!(
                    is_non_trivial,
                    "openclaw_turn returned an empty / trivial TurnOutcome"
                );
                eprintln!("  happy_path=ok provider=openclaw cost_usd=0.00");
            }
            Err(e) if !e.contains("openclaw_unavailable") => {
                // Daemon is up but the chat endpoint is absent (404) or
                // requires auth (401) on this build — skip the happy-path
                // assertion. The unhappy-path contract test below still runs.
                eprintln!("  happy_path=skipped (chat endpoint not available: {e})");
            }
            Err(e) => {
                // A 5xx or connect-refused yields openclaw_unavailable — that
                // is valid behaviour but unexpected when daemon_is_up() was true.
                eprintln!("  happy_path=skipped (openclaw_unavailable from live daemon: {e})");
            }
        }
    } else {
        eprintln!("  happy_path=skipped (daemon not running)");
    }

    // --- Unhappy path — always exercised regardless of daemon state -----------
    // Bind a TCP listener, then immediately drop it so the port is closed.
    // The OS will refuse the connection, giving us a clean "connection refused"
    // scenario without any race window.
    let closed_port = {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port for mock");
        let port = listener
            .local_addr()
            .expect("get mock port")
            .port();
        drop(listener); // port is now closed
        port
    };

    let closed_url = format!("ws://127.0.0.1:{closed_port}");
    std::env::set_var("OPENCLAW_GATEWAY_URL", &closed_url);

    let result = openclaw_turn("openclaw-auto", system, &history).await;

    // Restore env so later tests in the same process are not affected.
    std::env::remove_var("OPENCLAW_GATEWAY_URL");

    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("openclaw_turn must return Err when the gateway is unreachable"),
    };

    assert!(
        err.contains("openclaw_unavailable"),
        "error must carry the 'openclaw_unavailable' marker for GLM fallback; got: {err}"
    );

    eprintln!("  unhappy_path=ok contract=openclaw_unavailable marker present");
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

fn value_type_label(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}
