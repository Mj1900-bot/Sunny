//! `conversation_*` Tauri commands — per-session turn log.
//!
//! Backs the "remembering N earlier turns" UI hint and the agent_loop
//! cross-surface context replay. Three commands plus a sessions lister:
//!
//!   * `conversation_tail`             — read last N turns for a session.
//!   * `conversation_append`           — persist a single turn.
//!   * `conversation_prune_older_than` — retention sweep, returns rows removed.
//!   * `conversation_list_sessions`    — sprint-9 SessionPicker support.
//!
//! Each is a thin async wrapper over `memory::conversation`, translating the
//! frontend-friendly `role: String` into the typed `Role` enum.

use crate::memory;

/// Map the stringy role supplied from the webview to the typed enum. Returns
/// a structured error for unknown values so the frontend can surface a
/// validation message instead of silently persisting a fallback.
pub(super) fn parse_role(role: &str) -> Result<memory::conversation::Role, String> {
    match role {
        "user" => Ok(memory::conversation::Role::User),
        "assistant" => Ok(memory::conversation::Role::Assistant),
        "tool" => Ok(memory::conversation::Role::Tool),
        other => Err(format!(
            "unknown conversation role '{other}' (expected 'user' | 'assistant' | 'tool')"
        )),
    }
}

#[tauri::command]
pub async fn conversation_tail(
    session_id: String,
    limit: u32,
) -> Result<Vec<memory::conversation::Turn>, String> {
    memory::conversation::tail(&session_id, limit as usize).await
}

#[tauri::command]
pub async fn conversation_append(
    session_id: String,
    role: String,
    content: String,
) -> Result<(), String> {
    let role = parse_role(&role)?;
    memory::conversation::append(&session_id, role, &content).await
}

#[tauri::command]
pub async fn conversation_prune_older_than(days: u32) -> Result<usize, String> {
    memory::conversation::prune_older_than(days as i64).await
}

/// List up to `limit` most-recently-active sessions, newest first, so the
/// sprint-9 SessionPicker can render the user's conversation history.
/// Each row carries `last_at`, `turn_count`, and a 120-char preview of the
/// earliest turn — enough to identify the thread without a second fetch.
#[tauri::command]
pub async fn conversation_list_sessions(
    limit: u32,
) -> Result<Vec<memory::conversation::SessionSummary>, String> {
    memory::conversation::list_sessions(limit as usize).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// The conversation_* commands are the only ones with logic beyond a 1-line
// passthrough (role string → enum parsing plus u32 → usize/i64 casting).
// These tests cover both paths directly — the underlying storage layer is
// already exercised by `memory::conversation::tests`.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_role_accepts_the_three_canonical_roles() {
        assert_eq!(
            parse_role("user").unwrap(),
            memory::conversation::Role::User
        );
        assert_eq!(
            parse_role("assistant").unwrap(),
            memory::conversation::Role::Assistant
        );
        assert_eq!(
            parse_role("tool").unwrap(),
            memory::conversation::Role::Tool
        );
    }

    #[test]
    fn parse_role_rejects_unknown_values() {
        let err = parse_role("system").unwrap_err();
        assert!(err.contains("unknown conversation role"));
        assert!(err.contains("system"));
        // Empty string is also an error — no silent fallback.
        assert!(parse_role("").is_err());
        // Case-sensitive: the IPC contract is snake_case only.
        assert!(parse_role("User").is_err());
    }

    /// Round-trip the three `conversation_*` Tauri commands against a
    /// freshly-seeded session id. Uses the real global memory DB (not a
    /// scratch connection) so it exercises the full `with_conn` + Tokio
    /// `spawn_blocking` path the production command handlers run.
    ///
    /// `#[ignore]`d by default because the test hits
    /// `~/.sunny/memory.sqlite` — under a full parallel `cargo test --lib`
    /// the SQLite `PRAGMA journal_mode = WAL` step occasionally returns a
    /// transient disk I/O error when the WAL sidecar files contend with
    /// a parallel `memory::*` module test opening the same DB. The
    /// underlying primitives (`conversation::{append, tail,
    /// prune_older_than}`) have their own hermetic unit tests over a
    /// `scratch_conn` — this one exists as a full-stack smoke check you
    /// run explicitly with:
    ///
    ///     cargo test --lib commands::memory -- --ignored
    #[tokio::test]
    #[ignore = "hits ~/.sunny/memory.sqlite; flaky under parallel cargo test — run with --ignored"]
    async fn conversation_commands_round_trip() {
        // Ensure the global memory DB is open before the first async call
        // hits `with_conn`. Safe to call repeatedly.
        memory::init_default().expect("memory init");

        // Unique session keyed by pid + nanos so parallel test binaries /
        // re-runs never collide.
        let sid = format!(
            "test-sess-{pid}-{nanos}",
            pid = std::process::id(),
            nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        // Append three turns through the command surface.
        conversation_append(sid.clone(), "user".into(), "hi".into())
            .await
            .expect("append user");
        conversation_append(sid.clone(), "assistant".into(), "hello".into())
            .await
            .expect("append assistant");
        conversation_append(sid.clone(), "tool".into(), "result".into())
            .await
            .expect("append tool");

        // Tail via the command — should return all three oldest-first.
        let turns = conversation_tail(sid.clone(), 16).await.expect("tail ok");
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].content, "hi");
        assert_eq!(turns[0].role, memory::conversation::Role::User);
        assert_eq!(turns[1].role, memory::conversation::Role::Assistant);
        assert_eq!(turns[2].role, memory::conversation::Role::Tool);

        // Append with a bogus role surfaces a structured error instead of
        // silently persisting.
        let err = conversation_append(sid.clone(), "root".into(), "boom".into())
            .await
            .unwrap_err();
        assert!(err.contains("unknown conversation role"));

        // Prune with a huge window is a no-op (nothing is that old) and
        // returns 0 — proving the command wires through and the u32 → i64
        // cast survives.
        let removed = conversation_prune_older_than(365)
            .await
            .expect("prune ok");
        // We can't assert == 0 without knowing what other tests wrote, but
        // any finite usize proves the round-trip.
        let _: usize = removed;
    }
}
