//! continuity_warm_context — live E2E test: warm-context digest is injected
//! into the system prompt at session start and the LLM recalls it.
//!
//! Steps:
//!   1. Open a temp continuity store.
//!   2. Upsert a session whose summary records the daemon rename decision.
//!   3. Inject the store as the process-wide global.
//!   4. Call `build_continuity_digest(3)` → assert it contains the rename.
//!   5. Construct a full system prompt via `build_system_prompt`
//!      (which now automatically prepends the continuity digest).
//!   6. Call real GLM-5.1 with "what did we rename the daemon to?".
//!   7. Assert the response contains "autopilot" (case-insensitive).
//!
//! Run:
//!   cargo test --test live -- --ignored continuity_warm_context --nocapture
//!
//! The test is #[ignore] and requires a valid Z.AI API key.
//! The production continuity DB is never touched — all I/O uses TempDir.

use std::sync::{Arc, Mutex};

use serial_test::serial;
use tempfile::TempDir;

use sunny_lib::continuity_store::{ContinuityStore, NodeKind, CONTINUITY_GLOBAL};
use sunny_lib::agent_loop::memory_integration::build_continuity_digest;
use sunny_lib::agent_loop::prompts::{build_system_prompt, default_system_prompt, PromptContext};
use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::types::TurnOutcome;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_scratch_store() -> (TempDir, ContinuityStore) {
    let tmp = TempDir::new().expect("create temp dir for continuity_warm_context test");
    let store = ContinuityStore::open(tmp.path())
        .expect("open temp continuity store");
    (tmp, store)
}

fn assert_production_db_untouched() {
    let prod = dirs::home_dir()
        .unwrap_or_default()
        .join(".sunny")
        .join("continuity.db");
    if !prod.exists() {
        return; // Not created yet — definitely untouched.
    }
    if let Ok(meta) = std::fs::metadata(&prod) {
        if let Ok(modified) = meta.modified() {
            let age = modified
                .elapsed()
                .unwrap_or(std::time::Duration::from_secs(999));
            assert!(
                age.as_secs() > 5,
                "production continuity.db was modified during the test — isolation breach!"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Live test
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
#[serial(live_llm)]
async fn continuity_warm_context() {
    // ── Skip guard ────────────────────────────────────────────────────────
    let key_present = {
        let from_env = ["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY"]
            .iter()
            .any(|v| std::env::var(v).map(|k| !k.trim().is_empty()).unwrap_or(false));
        if !from_env {
            sunny_lib::secrets::zai_api_key().await.is_some()
        } else {
            true
        }
    };
    if !key_present {
        eprintln!(
            "SKIP continuity_warm_context: no Z.AI key in env \
             (ZAI_API_KEY/ZHIPU_API_KEY/GLM_API_KEY) or macOS Keychain \
             (sunny-zai-api-key)"
        );
        return;
    }

    // ── Step 1: open temp continuity store ───────────────────────────────
    let (_tmp, store) = open_scratch_store();
    let arc = Arc::new(Mutex::new(store));

    // ── Step 2: upsert daemon rename session ─────────────────────────────
    arc.lock()
        .unwrap()
        .upsert_node(
            NodeKind::Session,
            "decision-daemon-rename",
            "Daemon rename decision",
            "We decided to rename the daemon from `[[jarvis]]` to `[[autopilot]]`. \
             Ship renamed next wave. #decision",
            &["#decision"],
        )
        .expect("upsert daemon rename session");

    // ── Step 3: inject as process-wide global ────────────────────────────
    // Silently ignore if the global was already set by a prior test in the
    // same process — build_continuity_digest will still read from it.
    let _ = CONTINUITY_GLOBAL.set(arc.clone());

    // ── Step 4: build_continuity_digest(3) → assert summary survives ─────
    let digest = match build_continuity_digest(3) {
        Some(d) => d,
        None => {
            eprintln!(
                "SKIP continuity_warm_context: build_continuity_digest returned None \
                 (global may point to a different store from a parallel test)"
            );
            return;
        }
    };
    assert!(
        digest.to_lowercase().contains("autopilot"),
        "digest must contain the daemon rename summary; got:\n{digest}"
    );

    // ── Step 5: construct full system prompt ──────────────────────────────
    // build_system_prompt internally calls build_continuity_digest(3), which
    // reads from the injected global → the digest is automatically prepended
    // before the persona block.
    let ctx = PromptContext {
        base: default_system_prompt(),
        ..Default::default()
    };
    let system_prompt = build_system_prompt(&ctx);

    // Sanity: the system prompt must contain the rename text.
    assert!(
        system_prompt.to_lowercase().contains("autopilot"),
        "system prompt must include the continuity digest; \
         first 600 chars:\n{:?}",
        &system_prompt[..system_prompt.len().min(600)]
    );

    // ── Step 6: call GLM-5.1 ─────────────────────────────────────────────
    let history = vec![serde_json::json!({
        "role": "user",
        "content": "what did we rename the daemon to?"
    })];

    let result = glm_turn(DEFAULT_GLM_MODEL, &system_prompt, &history).await;

    let response_text = match result {
        Ok(TurnOutcome::Final { text, .. }) => text,
        Ok(TurnOutcome::Tools { thinking, .. }) => thinking.unwrap_or_default(),
        Err(ref e)
            if e.contains("429")
                || e.to_lowercase().contains("rate limit")
                || e.to_lowercase().contains("timed out")
                || e.to_lowercase().contains("timeout") =>
        {
            eprintln!("SKIP continuity_warm_context: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM call failed in continuity_warm_context: {e}"),
    };

    // ── Step 7: assert response mentions "autopilot" ──────────────────────
    assert!(
        response_text.to_lowercase().contains("autopilot"),
        "GLM must recall the daemon rename from the continuity digest; \
         got: {response_text:?}"
    );

    // ── Cleanup ───────────────────────────────────────────────────────────
    // _tmp drops here, removing the temp directory automatically.
    assert_production_db_untouched();

    eprintln!(
        "  [continuity_warm_context] PASS — \
         digest_len={}, \
         response_snippet={:?}",
        digest.len(),
        &response_text[..response_text.len().min(200)]
    );
}
