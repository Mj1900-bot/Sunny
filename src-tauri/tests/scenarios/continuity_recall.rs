//! continuity_recall — E2E scenario: Obsidian-style continuity graph (Phase-2 Packet 3).
//!
//! 1. `continuity_graph_self_test` — graph-only, NO GLM, always runs (no #[ignore]).
//! 2. `continuity_glm_integration` — GLM conditioned on recent_context, #[ignore],
//!    skips silently when no Z.AI key is available.
//!
//! Run: cargo test --test live continuity_graph_self_test --nocapture
//!      cargo test --test live -- --ignored continuity_glm_integration --nocapture
//!
//! The test NEVER touches ~/.sunny/continuity.db — all I/O uses tempfile::TempDir.

use sunny_lib::continuity_store::{ContinuityStore, NodeKind};
use serial_test::serial;

// ---------------------------------------------------------------------------
// Helper: open an isolated store in a temp directory
// ---------------------------------------------------------------------------

fn scratch_store() -> (tempfile::TempDir, ContinuityStore) {
    let dir = tempfile::TempDir::new().expect("create temp dir for continuity test");
    let store = ContinuityStore::open(dir.path()).expect("open temp continuity store");
    (dir, store)
}

// ---------------------------------------------------------------------------
// GUARD: verify the production DB was NOT touched (checked by both tests)
// ---------------------------------------------------------------------------

fn assert_production_db_untouched() {
    let prod_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".sunny")
        .join("continuity.db");
    // We only care if the file previously did NOT exist; if it does exist for
    // legitimate reasons we simply skip this check to avoid false positives.
    // The critical property is: our test must not create it if it was absent.
    // We track this by asserting the canonical temp paths were used, which is
    // guaranteed structurally — but a belt-and-suspenders check here too.
    if !prod_path.exists() {
        // Good: nothing was created at the production path.
        return;
    }
    // If it does exist, check its modification time is not brand-new (within 5 s).
    if let Ok(meta) = std::fs::metadata(&prod_path) {
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
// Test 1: graph self-test — NO GLM, no #[ignore], always runs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn continuity_graph_self_test() {
    let (_tmp, store) = scratch_store();

    // ------------------------------------------------------------------
    // Step 1: upsert 3 sessions that wikilink to [[project-sunny-moc]] and
    //         [[2026-04-20]] in their summaries.
    // ------------------------------------------------------------------
    for i in 1..=3 {
        store
            .upsert_node(
                NodeKind::Session,
                &format!("session-{i}"),
                &format!("Session {i}"),
                &format!(
                    "Worked on [[project-sunny-moc]] today. See [[2026-04-20]] for notes. \
                     Run {i} complete."
                ),
                &[&format!("#session-{i}")],
            )
            .expect("upsert session");
    }

    // ------------------------------------------------------------------
    // Step 2: assert backlinks_of("project-sunny-moc") returns all 3 slugs
    // ------------------------------------------------------------------
    let backlinks = store
        .backlinks_of("project-sunny-moc")
        .expect("backlinks_of");
    assert_eq!(
        backlinks.len(),
        3,
        "expected 3 backlinks to project-sunny-moc, got {:?}",
        backlinks
    );
    for i in 1..=3 {
        let slug = format!("session-{i}");
        assert!(
            backlinks.contains(&slug),
            "backlinks must contain {slug}; got {:?}",
            backlinks
        );
    }

    // ------------------------------------------------------------------
    // Step 3: assert daily_note_slug("2026-04-20") exists
    //         (the wikilinks already caused a stub to be created; calling
    //          daily_note_slug promotes it to a DailyNote kind)
    // ------------------------------------------------------------------
    let daily_slug = store
        .daily_note_slug("2026-04-20")
        .expect("daily_note_slug");
    assert_eq!(daily_slug, "2026-04-20", "daily note slug must match date");

    // Verify it is present in recent_context
    let ctx = store.recent_context(20).expect("recent_context after daily note");
    let daily_present = ctx.iter().any(|n| n.slug == "2026-04-20");
    assert!(daily_present, "daily note must appear in recent_context");

    // ------------------------------------------------------------------
    // Step 4: regenerate project_moc("project-sunny-moc") and assert it
    //         lists all 3 session links
    // ------------------------------------------------------------------
    let moc = store
        .project_moc("project-sunny-moc")
        .expect("project_moc");
    assert_eq!(
        moc.slug, "project-sunny-moc-moc",
        "MOC slug must be '<project>-moc'"
    );
    assert!(
        moc.tags.contains(&"#moc".to_string()),
        "MOC must carry #moc tag"
    );
    for i in 1..=3 {
        let wikilink = format!("[[session-{i}]]");
        assert!(
            moc.summary.contains(&wikilink),
            "MOC summary must contain {wikilink}; summary:\n{}", moc.summary
        );
    }

    // ------------------------------------------------------------------
    // Step 5: forget one session — recent_context must now return 2 sessions
    //         (plus stubs / daily-note, but session count drops by 1)
    // ------------------------------------------------------------------
    store.forget_node("session-3").expect("forget_node");

    let ctx_after = store.recent_context(20).expect("recent_context after forget");
    let session_slugs: Vec<&str> = ctx_after
        .iter()
        .filter(|n| n.slug.starts_with("session-"))
        .map(|n| n.slug.as_str())
        .collect();
    assert_eq!(
        session_slugs.len(),
        2,
        "after forget, expected 2 live sessions; got {:?}",
        session_slugs
    );
    assert!(
        !session_slugs.contains(&"session-3"),
        "session-3 must be excluded after soft-delete"
    );

    // ------------------------------------------------------------------
    // Step 6: tag_search sanity — session-1 has #session-1 tag
    // ------------------------------------------------------------------
    let tagged = store.tag_search("#session-1").expect("tag_search");
    assert!(
        tagged.iter().any(|n| n.slug == "session-1"),
        "tag_search(#session-1) must include session-1"
    );

    // ------------------------------------------------------------------
    // Cleanup: assert production DB was not touched
    // ------------------------------------------------------------------
    drop(store);
    // _tmp is dropped here, removing the temp directory.
    assert_production_db_untouched();

    eprintln!(
        "  [continuity_graph_self_test] PASS — backlinks={}, MOC links=3, \
         sessions_after_forget={}, daily_note={}",
        backlinks.len(),
        session_slugs.len(),
        daily_slug
    );
}

// ---------------------------------------------------------------------------
// Test 2: GLM integration — #[ignore], skips if no key
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn continuity_glm_integration() {
    use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
    use sunny_lib::agent_loop::types::TurnOutcome;

    // Skip guard — load key from env or Keychain
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
            "SKIP continuity_glm_integration: no Z.AI key in env \
             (ZAI_API_KEY/ZHIPU_API_KEY/GLM_API_KEY) or macOS Keychain (sunny-zai-api-key)"
        );
        return;
    }

    let (_tmp, store) = scratch_store();

    // ------------------------------------------------------------------
    // Step 7: upsert a decision session that captures the SQLite choice
    // ------------------------------------------------------------------
    store
        .upsert_node(
            NodeKind::Decision,
            "decision-storage-choice",
            "Storage engine decision",
            "We decided to use [[sqlite]] over [[duckdb]] for the continuity graph. \
             The main reasons: bundled build, WAL mode, FTS5 support. #decision",
            &["#decision"],
        )
        .expect("upsert decision node");

    // Also upsert context sessions so recent_context has useful content.
    store
        .upsert_node(
            NodeKind::Session,
            "session-context-a",
            "Architecture session",
            "Reviewed storage options. [[decision-storage-choice]] captures the outcome.",
            &[],
        )
        .expect("upsert context-a");

    // ------------------------------------------------------------------
    // Step 8: fetch recent_context(5)
    // ------------------------------------------------------------------
    let context_nodes = store.recent_context(5).expect("recent_context for GLM");
    assert!(
        !context_nodes.is_empty(),
        "recent_context must return nodes before GLM call"
    );

    // ------------------------------------------------------------------
    // Step 9: build a system prompt that prepends the context
    // ------------------------------------------------------------------
    let context_text: String = context_nodes
        .iter()
        .map(|n| format!("[{}] {}: {}", n.kind.as_str(), n.title, n.summary))
        .collect::<Vec<_>>()
        .join("\n\n");

    let system_prompt = format!(
        "Here is our recent work:\n\n{context_text}\n\n\
         Answer questions about this project based on the context above."
    );

    let history = vec![serde_json::json!({
        "role": "user",
        "content": "What did we decide about storage? Be brief."
    })];

    // ------------------------------------------------------------------
    // Step 10: call GLM
    // ------------------------------------------------------------------
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
            eprintln!("SKIP continuity_glm_integration: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM call failed in continuity_glm_integration: {e}"),
    };

    // ------------------------------------------------------------------
    // Step 11: assert response mentions SQLite / sqlite
    // ------------------------------------------------------------------
    let lower = response_text.to_lowercase();
    assert!(
        lower.contains("sqlite") || lower.contains("sql lite"),
        "GLM response must mention SQLite given the context; got: {response_text:?}"
    );

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    drop(store);
    assert_production_db_untouched();

    eprintln!(
        "  [continuity_glm_integration] PASS — context_nodes={}, \
         response_snippet={:?}",
        context_nodes.len(),
        &response_text[..response_text.len().min(280)]
    );
}
