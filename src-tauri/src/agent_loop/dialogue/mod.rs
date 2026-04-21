//! Agent-to-agent dialogue — structured message passing between running
//! sub-agents.
//!
//! The existing `spawn_subagent` / `agent_run_inner` model is fire-and-
//! forget: spawn a child, wait for its final answer, return. That's fine
//! for simple delegation but breaks down for council / debate patterns
//! where two siblings need to coordinate mid-task ("critic, what do you
//! think so far?").
//!
//! This module provides two module-scoped registries:
//!
//!   * `INBOXES` — per-agent queue of pending messages. `agent_message`
//!     pushes into a receiver's inbox; `agent_run_inner` drains its own
//!     inbox before every LLM call and injects the entries as extra
//!     history messages so the model sees them on its next turn.
//!
//!   * `RESULTS` — per-agent final-answer slot. Registered as `None` when
//!     the agent starts; flipped to `Some(answer)` when it finishes.
//!     `agent_wait` polls the slot for a list of agent ids until every
//!     target is `Some(_)` or the timeout expires.
//!
//! Caps:
//!   * Inbox body ≤ 4000 chars (messages longer are truncated with an
//!     ellipsis — sender is responsible for staying under the cap).
//!   * Inbox depth ≤ 16 messages per agent (oldest dropped on push).
//!   * `agent_wait` timeout ≤ 600 s.


pub mod stream;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

/// Agent identifier. `"main"` for the top-level loop; a sub-agent's uuid
/// for every spawned child. Kept as a `String` so we can call
/// `Clone`/`Hash` cheaply and move ids across task boundaries without
/// lifetime gymnastics.
pub type AgentId = String;

/// Canonical id for the top-level agent. `agent_run_inner` uses this
/// when `sub_id == None` so messages to/from the main loop travel
/// through the same registry as every other agent.
pub const MAIN_AGENT_ID: &str = "main";

/// Maximum number of pending messages we retain per inbox. Older
/// messages are dropped on the floor when a sender pushes past the cap —
/// fail-open rather than returning an error because the LLM would then
/// have to reason about retry logic it probably doesn't need.
pub const INBOX_CAP: usize = 16;

/// Maximum length of a single dialogue message body in chars. Longer
/// payloads are truncated with an ellipsis marker so they still flow
/// but don't OOM the receiver's history.
pub const MAX_MESSAGE_CHARS: usize = 4_000;

/// Upper bound on the `timeout_secs` arg to `agent_wait`. Ten minutes is
/// generous for any sensible council scenario; anything longer is
/// almost certainly a confused caller.
pub const MAX_WAIT_SECS: u64 = 600;

/// How often `agent_wait` rechecks the results registry. 50ms is cheap
/// (a single mutex acquire) and responsive enough that a sub-agent
/// finishing mid-wait is reflected promptly in the caller's answer.
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long `wait_for_results` will keep polling for an id that isn't
/// registered yet. Enables the researcher→writer handoff pattern where
/// the researcher calls `agent_wait("writer-id")` before the parent has
/// finished spawning the writer. After this hold, unregistered ids
/// resolve to `None` immediately so the wait can return. Capped well
/// below `MAX_WAIT_SECS` so a malformed id doesn't burn a whole
/// 10-minute budget.
pub const SIBLING_SPAWN_HOLD: Duration = Duration::from_secs(30);

/// A single dialogue message. Carries the sender so the receiver's
/// injected history entry can attribute it correctly.
#[derive(Debug, Clone)]
pub struct DialogueMessage {
    pub from: AgentId,
    pub content: String,
}

/// Per-agent inbox map. Keyed by recipient id. Missing entries are
/// treated as "agent not registered" — `agent_message` rejects with a
/// structured error in that case so the sender can reroute.
static INBOXES: OnceLock<Mutex<HashMap<AgentId, Vec<DialogueMessage>>>> = OnceLock::new();

/// Per-agent result slot. `None` while running; `Some(answer)` once the
/// sub-agent has produced its final reply. `agent_wait` polls this map.
static RESULTS: OnceLock<Mutex<HashMap<AgentId, Option<String>>>> = OnceLock::new();

/// Parent pointer per agent id — powers sibling discovery. Keyed by
/// child id, value is the parent's id (typically `MAIN_AGENT_ID` for the
/// top-level spawn, or a parent sub-agent's uuid for nested spawns).
/// `list_siblings` scans this map to find other children with the same
/// parent. Unregistered agents simply don't appear, which falls out as
/// "no siblings" rather than an error — siblings are advisory, not a
/// hard dependency.
static PARENTS: OnceLock<Mutex<HashMap<AgentId, AgentId>>> = OnceLock::new();

fn inboxes() -> &'static Mutex<HashMap<AgentId, Vec<DialogueMessage>>> {
    INBOXES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn results() -> &'static Mutex<HashMap<AgentId, Option<String>>> {
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parents() -> &'static Mutex<HashMap<AgentId, AgentId>> {
    PARENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How often the background prune loop scans `PARENTS` for stale
/// entries. 5 minutes is a generous interval — the leak symptom only
/// manifests after 24h+ of continuous use, so a gentle cadence keeps
/// the cost near zero while still bounding growth.
const PRUNE_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Remove entries from `PARENTS` whose child agent has already finished
/// (its `RESULTS` slot holds `Some(_)`) AND whose inbox has been fully
/// drained. Both conditions together are the definition of "terminated
/// and nobody is still talking to this id" — if a sibling has queued a
/// last-minute hand-off message the recipient's inbox is non-empty and
/// we hold off until it's consumed.
///
/// Returns the number of entries pruned. Emitted at `info!` level if
/// non-zero so the 24h leak is visible in logs. Safe to call from
/// multiple tasks concurrently — each acquisition of the three mutexes
/// is short-lived and the deletion list is built from snapshots so we
/// never hold two locks at once.
pub async fn prune_stale_parents() -> usize {
    // Snapshot the RESULTS map under its own short-held lock so we
    // don't cross-hold with the INBOXES mutex below. `broadcast_to_
    // siblings` acquires INBOXES and PARENTS in sequence; by never
    // holding two at once we avoid any deadlock risk with that path.
    let finished_ids: Vec<AgentId> = match results().lock() {
        Ok(map) => map
            .iter()
            .filter_map(|(id, slot)| {
                if slot.is_some() {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect(),
        Err(_) => return 0,
    };

    // Of those finished ids, keep only the ones whose inbox is empty.
    // An id with pending messages means a sibling hand-off is still in
    // flight — honour the grace semantics by deferring pruning until
    // the next tick after the receiver has drained.
    let drainable: Vec<AgentId> = {
        let map = match inboxes().lock() {
            Ok(m) => m,
            Err(_) => return 0,
        };
        finished_ids
            .into_iter()
            .filter(|id| match map.get(id) {
                Some(q) => q.is_empty(),
                None => true,
            })
            .collect()
    };

    if drainable.is_empty() {
        return 0;
    }

    // Final step: remove those ids from PARENTS (and their now-empty
    // inbox / results entries). Doing everything under the PARENTS
    // lock keeps the bookkeeping consistent from the perspective of
    // `list_siblings`, which only reads PARENTS.
    let mut removed = 0usize;
    if let Ok(mut parent_map) = parents().lock() {
        for id in &drainable {
            if parent_map.remove(id).is_some() {
                removed += 1;
            }
        }
    }
    // Drop the matching INBOXES + RESULTS entries too so the registries
    // don't slowly grow the other two maps for the same leaked ids.
    // Best-effort: a poisoned lock just means we'll catch them next
    // tick.
    if removed > 0 {
        if let Ok(mut map) = inboxes().lock() {
            for id in &drainable {
                map.remove(id);
            }
        }
        if let Ok(mut map) = results().lock() {
            for id in &drainable {
                map.remove(id);
            }
        }
        log::info!("[dialogue] pruned {removed} stale parent entries");
    }
    removed
}

/// Spawn the background prune task. Called once from `startup::setup`
/// so every process-lifetime's worth of terminated sub-agents gets
/// cleaned up on a rolling 5-minute cadence. Idempotent-ish: multiple
/// calls just stack up multiple pruners, which is harmless (they're
/// all doing best-effort snapshots) but wasteful — don't.
pub fn start_prune_loop() {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(PRUNE_INTERVAL);
        // First tick fires immediately — skip so we don't race startup.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let _ = prune_stale_parents().await;
        }
    });
}

/// Clear the entire dialogue state. Tests only — the registries are
/// module-scoped and would otherwise leak state between `#[test]` cases
/// run on the same process.
#[cfg(test)]
pub fn reset_for_tests() {
    if let Ok(mut map) = inboxes().lock() {
        map.clear();
    }
    if let Ok(mut map) = results().lock() {
        map.clear();
    }
    if let Ok(mut map) = parents().lock() {
        map.clear();
    }
}

/// Register an agent in both maps. Called by `spawn_subagent` before it
/// kicks off the child's `agent_run_inner` and by the main-agent entry
/// point before the top-level loop begins. Safe to call for an id that
/// is already registered — existing inbox contents are preserved and the
/// result slot is reset to `None`.
pub fn register(id: &str) {
    if let Ok(mut map) = inboxes().lock() {
        map.entry(id.to_string()).or_insert_with(Vec::new);
    }
    if let Ok(mut map) = results().lock() {
        map.insert(id.to_string(), None);
    }
}

/// Count the *live* (still-running) children of a given parent. A child
/// is live if it is registered in the PARENTS map under this parent AND
/// its RESULTS slot is still `None` (i.e., `set_result` hasn't been
/// called yet). Used by `spawn_subagent` to cap horizontal fan-out: the
/// `MAX_SUBAGENT_DEPTH=3` recursion guard prevents vertical runaway but
/// not a parent emitting 100 siblings at depth 0, each of which itself
/// emits 100 more at depth 1.
pub fn count_live_children(parent_id: &str) -> usize {
    let parents_snapshot: HashMap<AgentId, AgentId> = match parents().lock() {
        Ok(m) => m.clone(),
        Err(_) => return 0,
    };
    let results_snapshot: HashMap<AgentId, Option<String>> = match results().lock() {
        Ok(m) => m.clone(),
        Err(_) => return 0,
    };
    parents_snapshot
        .iter()
        .filter(|(child, p)| {
            p.as_str() == parent_id
                // None in results = still in flight; missing = never
                // registered (shouldn't happen given register_with_parent
                // also calls register, but be defensive).
                && matches!(results_snapshot.get(child.as_str()), Some(None) | None)
        })
        .count()
}

/// Register an agent and record its parent for sibling discovery.
/// Equivalent to `register(id)` plus a write into the PARENTS map so
/// `list_siblings` / `broadcast_to_siblings` can enumerate peers. Kept
/// as a distinct function (rather than changing `register`'s signature)
/// so existing callers — tests, `agent_run_inner`'s main-agent path —
/// keep the same semantics. Root-level agents (no parent) should call
/// the plain `register`; only children registered via this function
/// become discoverable as siblings.
pub fn register_with_parent(id: &str, parent_id: &str) {
    register(id);
    if let Ok(mut map) = parents().lock() {
        map.insert(id.to_string(), parent_id.to_string());
    }
}

/// Return the ids of every other agent that shares `my_id`'s parent.
/// Excludes `my_id` itself. Returns an empty vec if the agent has no
/// recorded parent or no siblings — callers should treat "empty" as
/// "no peers to talk to", not as an error.
#[allow(dead_code)] // wired into the `agent_list_siblings` dispatcher in a follow-up.
pub async fn list_siblings(my_id: &str) -> Vec<String> {
    let snapshot: HashMap<AgentId, AgentId> = match parents().lock() {
        Ok(m) => m.clone(),
        Err(_) => return Vec::new(),
    };
    let parent = match snapshot.get(my_id) {
        Some(p) => p.clone(),
        None => return Vec::new(),
    };
    snapshot
        .iter()
        .filter_map(|(child, p)| {
            if p == &parent && child != my_id {
                Some(child.clone())
            } else {
                None
            }
        })
        .collect()
}

/// Broadcast a message to every sibling of `from`. Returns the number
/// of inboxes successfully delivered to. Uses `post_message` under the
/// hood so existing caps (inbox depth, body length) still apply. Errors
/// from individual recipients are swallowed — partial delivery is
/// better than none when one sibling has already finished and been
/// reaped from the registry.
#[allow(dead_code)] // wired into the `agent_broadcast` dispatcher in a follow-up.
pub async fn broadcast_to_siblings(
    from: &str,
    message: serde_json::Value,
) -> Result<usize, String> {
    let body = match message {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    };
    let siblings = list_siblings(from).await;
    let mut delivered = 0usize;
    for sib in &siblings {
        if post_message(from, sib, &body).is_ok() {
            delivered += 1;
        }
    }
    Ok(delivered)
}

/// Record a finished agent's final answer. Unblocks any `agent_wait`
/// that was sleeping on this id.
pub fn set_result(id: &str, answer: String) {
    if let Ok(mut map) = results().lock() {
        map.insert(id.to_string(), Some(answer));
    }
}

/// Returns `true` if the registry knows about `id`. Exposed for the
/// UI / scripted diagnostics that want to probe whether an agent id is
/// still addressable. `post_message` does its own membership check
/// inside the mutex, so this is advisory only.
#[allow(dead_code)]
pub fn is_registered(id: &str) -> bool {
    inboxes()
        .lock()
        .map(|m| m.contains_key(id))
        .unwrap_or(false)
}

/// Push a dialogue message into `to`'s inbox. Fails when the recipient
/// isn't registered so the caller gets a clear signal (vs silently
/// dropping the message into the void).
pub fn post_message(from: &str, to: &str, content: &str) -> Result<(), String> {
    let trimmed = truncate_body(content);
    let msg = DialogueMessage {
        from: from.to_string(),
        content: trimmed,
    };
    let mut map = inboxes()
        .lock()
        .map_err(|e| format!("dialogue inbox lock poisoned: {e}"))?;
    let queue = match map.get_mut(to) {
        Some(q) => q,
        None => {
            return Err(format!(
                "unknown recipient `{to}` — agent not registered (finished or never spawned)"
            ));
        }
    };
    queue.push(msg);
    // Cap enforcement: drop the oldest entries when we exceed the
    // INBOX_CAP. An LLM that is spamming messages probably isn't going
    // to read them anyway, so we'd rather keep the most recent context.
    while queue.len() > INBOX_CAP {
        queue.remove(0);
    }
    Ok(())
}

/// Drain `id`'s inbox, returning every pending message in FIFO order.
/// Called at the top of each `agent_run_inner` iteration so the model
/// sees dialogue messages on its next turn.
pub fn drain_inbox(id: &str) -> Vec<DialogueMessage> {
    let mut map = match inboxes().lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    match map.get_mut(id) {
        Some(q) => std::mem::take(q),
        None => Vec::new(),
    }
}

/// Block until every id in `targets` has a `Some(_)` result, or the
/// timeout elapses. Returns the id → answer map for everything that
/// finished; ids that timed out map to `None`.
///
/// Sibling-spawn hold: an id that isn't yet in the results registry is
/// treated as "might still be spawning" for up to `SIBLING_SPAWN_HOLD`
/// from the start of the wait. This enables a researcher→writer
/// handoff where the researcher calls `agent_wait("writer-id")` before
/// the parent has finished kicking off the writer. Once the hold
/// elapses, any id still not registered resolves to `None` and no
/// longer blocks completion — otherwise a typo in a target id would
/// stall the whole wait for the full user-supplied timeout.
pub async fn wait_for_results(
    targets: &[AgentId],
    timeout: Duration,
) -> HashMap<AgentId, Option<String>> {
    let started = Instant::now();
    loop {
        // Snapshot the results map under a short-held lock, then release
        // it before sleeping. Keeps the critical section tiny so the
        // sibling agents finishing in parallel aren't stalled by our
        // wait. We distinguish three states per id:
        //   * `Some(answer)` → finished, record the answer
        //   * `None` in map  → registered but still running
        //   * missing key    → not yet registered (might spawn soon)
        // Only the first is "done"; the other two keep us polling.
        let (snapshot, any_unregistered): (HashMap<AgentId, Option<String>>, bool) = {
            let map = match results().lock() {
                Ok(m) => m,
                Err(_) => return HashMap::new(),
            };
            let mut snap = HashMap::new();
            let mut unreg = false;
            for id in targets {
                match map.get(id) {
                    Some(Some(ans)) => {
                        snap.insert(id.clone(), Some(ans.clone()));
                    }
                    Some(None) => {
                        snap.insert(id.clone(), None);
                    }
                    None => {
                        snap.insert(id.clone(), None);
                        unreg = true;
                    }
                }
            }
            (snap, unreg)
        };

        let all_done = snapshot.values().all(|v| v.is_some());
        if all_done {
            return snapshot;
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return snapshot;
        }
        // If any target is still unregistered past the spawn-hold
        // window, bail out early with whatever's registered so far —
        // continuing to wait would just burn time on a never-appearing
        // id. Registered-but-unfinished ids continue to hold up to the
        // full user timeout, same as before.
        if any_unregistered && elapsed >= SIBLING_SPAWN_HOLD {
            let still_unregistered = {
                match results().lock() {
                    Ok(m) => targets.iter().any(|id| !m.contains_key(id)),
                    Err(_) => false,
                }
            };
            if still_unregistered {
                return snapshot;
            }
        }
        tokio::time::sleep(WAIT_POLL_INTERVAL).await;
    }
}

/// Build a `Value` suitable for pushing into `agent_run_inner`'s history
/// so the model sees the dialogue message on its next turn. Uses
/// `role: "user"` because Anthropic rejects `role: "system"` entries in
/// the message array (the system prompt is a separate top-level param);
/// `user` is accepted by Anthropic, Ollama, and GLM alike.
pub fn message_to_history_value(msg: &DialogueMessage) -> serde_json::Value {
    json!({
        "role": "user",
        "content": format!("[dialogue: from agent {}] {}", msg.from, msg.content),
    })
}

/// Truncate the message body to `MAX_MESSAGE_CHARS`, appending an
/// ellipsis when the cap is hit so the receiver can tell the tail was
/// clipped.
fn truncate_body(s: &str) -> String {
    let count = s.chars().count();
    if count <= MAX_MESSAGE_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_MESSAGE_CHARS).collect();
    out.push_str("…[truncated]");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test serialisation lock. The INBOXES / RESULTS registries are
    /// module-scoped, so concurrent tests would otherwise stomp on one
    /// another's state. Every test acquires this lock before it calls
    /// `reset_for_tests()` so the registries are single-threaded for the
    /// duration of the test.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn begin_test() -> std::sync::MutexGuard<'static, ()> {
        // Use a manual unwrap + re-lock instead of `.lock().unwrap()` so
        // a previously-poisoned mutex (from a panicked sibling test)
        // doesn't cascade into cascading failures across every test in
        // the suite.
        let guard = match TEST_LOCK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        reset_for_tests();
        guard
    }

    #[test]
    fn register_creates_inbox_and_result_slot() {
        let _g = begin_test();
        register("a1");
        assert!(is_registered("a1"));
        assert!(drain_inbox("a1").is_empty());
        // Slot starts as `None`.
        let map = results().lock().unwrap();
        assert!(matches!(map.get("a1"), Some(None)));
    }

    #[test]
    fn post_and_drain_roundtrip() {
        let _g = begin_test();
        register("bob");
        post_message("alice", "bob", "hello").unwrap();
        post_message("alice", "bob", "are you there?").unwrap();
        let inbox = drain_inbox("bob");
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[0].from, "alice");
        assert_eq!(inbox[0].content, "hello");
        assert_eq!(inbox[1].content, "are you there?");
        // Draining empties the inbox.
        assert!(drain_inbox("bob").is_empty());
    }

    #[test]
    fn post_to_unknown_recipient_errors() {
        let _g = begin_test();
        let err = post_message("alice", "ghost", "hi").unwrap_err();
        assert!(err.contains("unknown recipient"), "got: {err}");
    }

    #[test]
    fn inbox_cap_drops_oldest() {
        let _g = begin_test();
        register("charlie");
        for i in 0..(INBOX_CAP + 4) {
            post_message("alice", "charlie", &format!("msg {i}")).unwrap();
        }
        let inbox = drain_inbox("charlie");
        assert_eq!(inbox.len(), INBOX_CAP);
        // Oldest four (0..=3) should have been dropped.
        assert_eq!(inbox[0].content, "msg 4");
        assert_eq!(
            inbox.last().unwrap().content,
            format!("msg {}", INBOX_CAP + 3)
        );
    }

    #[test]
    fn oversize_message_is_truncated() {
        let _g = begin_test();
        register("dave");
        let huge = "x".repeat(MAX_MESSAGE_CHARS + 500);
        post_message("alice", "dave", &huge).unwrap();
        let inbox = drain_inbox("dave");
        assert_eq!(inbox.len(), 1);
        let body = &inbox[0].content;
        assert!(body.ends_with("…[truncated]"));
        // The leading `MAX_MESSAGE_CHARS` chars are preserved before the
        // ellipsis marker.
        let char_count = body.chars().count();
        assert!(char_count > MAX_MESSAGE_CHARS);
        assert!(char_count <= MAX_MESSAGE_CHARS + 32);
    }

    #[test]
    fn set_result_flips_slot() {
        let _g = begin_test();
        register("eve");
        let map = results().lock().unwrap();
        assert!(matches!(map.get("eve"), Some(None)));
        drop(map);

        set_result("eve", "42".to_string());
        let map = results().lock().unwrap();
        assert_eq!(map.get("eve"), Some(&Some("42".to_string())));
    }

    #[tokio::test]
    async fn wait_returns_when_all_done() {
        let _g = begin_test();
        register("frank");
        register("grace");
        set_result("frank", "answer-f".into());
        set_result("grace", "answer-g".into());

        let out = wait_for_results(
            &["frank".into(), "grace".into()],
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(out.get("frank"), Some(&Some("answer-f".into())));
        assert_eq!(out.get("grace"), Some(&Some("answer-g".into())));
    }

    #[tokio::test]
    async fn wait_times_out_when_incomplete() {
        let _g = begin_test();
        register("harry");
        // Never calls set_result — timeout path.
        let out = wait_for_results(&["harry".into()], Duration::from_millis(100)).await;
        assert_eq!(out.get("harry"), Some(&None));
    }

    #[tokio::test]
    async fn wait_unblocks_as_results_arrive() {
        let _g = begin_test();
        register("ivy");
        register("jack");
        set_result("ivy", "ivy-result".into());

        // Spawn a task that completes jack after a short delay.
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            set_result("jack", "jack-result".into());
        });

        let out =
            wait_for_results(&["ivy".into(), "jack".into()], Duration::from_secs(2)).await;
        assert_eq!(out.get("ivy"), Some(&Some("ivy-result".into())));
        assert_eq!(out.get("jack"), Some(&Some("jack-result".into())));
    }

    /// End-to-end: two "agents" coordinate via the dialogue tools.
    /// `register` both, have sender post via `post_message`, drain the
    /// receiver's inbox and verify the message arrived with the correct
    /// attribution and tagging on the history value. Mirrors the shape
    /// of the spawn_subagent → agent_message → drain_inbox path without
    /// actually spinning up an LLM call.
    #[tokio::test]
    async fn two_agents_dialogue_roundtrip() {
        let _g = begin_test();
        let sender = "uuid-sender";
        let receiver = "uuid-receiver";
        register(sender);
        register(receiver);

        // Sender posts, receiver drains on its next turn.
        post_message(sender, receiver, "critic — what do you think?").unwrap();
        let inbox = drain_inbox(receiver);
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].from, sender);
        assert_eq!(inbox[0].content, "critic — what do you think?");

        // Converting to history wire shape: role=user with the dialogue
        // attribution prefix so the receiver LLM sees where it came from.
        let history = message_to_history_value(&inbox[0]);
        assert_eq!(history["role"], "user");
        let content = history["content"].as_str().unwrap();
        assert!(content.contains("[dialogue: from agent uuid-sender]"));

        // Receiver then finishes — sender's agent_wait should unblock
        // with the result slot populated.
        set_result(receiver, "looks good to me".into());
        let waited = wait_for_results(
            &[receiver.to_string()],
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(
            waited.get(receiver),
            Some(&Some("looks good to me".to_string())),
        );
    }

    #[test]
    fn history_value_tags_sender() {
        let msg = DialogueMessage {
            from: "alice".into(),
            content: "what do you think?".into(),
        };
        let v = message_to_history_value(&msg);
        assert_eq!(v["role"], "user");
        let content = v["content"].as_str().unwrap();
        assert!(content.starts_with("[dialogue: from agent alice]"));
        assert!(content.contains("what do you think?"));
    }

    // ---- sibling discovery / broadcast / spawn-hold ------------------

    /// Register parent + two children. Each child should see exactly
    /// the other as a sibling — not itself, not the parent, not any
    /// unrelated agents.
    #[tokio::test]
    async fn list_siblings_returns_only_peers() {
        let _g = begin_test();
        register("parent-1");
        register_with_parent("child-a", "parent-1");
        register_with_parent("child-b", "parent-1");
        // Unrelated tree — must not bleed into the result.
        register("parent-2");
        register_with_parent("child-x", "parent-2");

        let sibs_a = list_siblings("child-a").await;
        assert_eq!(sibs_a, vec!["child-b".to_string()]);

        let sibs_b = list_siblings("child-b").await;
        assert_eq!(sibs_b, vec!["child-a".to_string()]);

        // Root-level parents have no recorded parent → no siblings.
        let sibs_root = list_siblings("parent-1").await;
        assert!(sibs_root.is_empty());

        // Unknown id also returns empty — no panic, no error.
        let sibs_unknown = list_siblings("never-registered").await;
        assert!(sibs_unknown.is_empty());
    }

    /// Broadcast from one sibling should deliver to every other sibling
    /// under the same parent and return the count. Messages from an
    /// unrelated tree must not see it.
    #[tokio::test]
    async fn broadcast_delivers_to_siblings_only() {
        let _g = begin_test();
        register("parent");
        register_with_parent("child1", "parent");
        register_with_parent("child2", "parent");
        // Separate tree — must not receive the broadcast.
        register("other-parent");
        register_with_parent("outsider", "other-parent");

        let delivered = broadcast_to_siblings(
            "child1",
            serde_json::Value::String("hello peers".into()),
        )
        .await
        .unwrap();
        assert_eq!(delivered, 1, "only child2 should receive");

        let inbox2 = drain_inbox("child2");
        assert_eq!(inbox2.len(), 1);
        assert_eq!(inbox2[0].from, "child1");
        assert_eq!(inbox2[0].content, "hello peers");

        // Sender's own inbox is untouched.
        assert!(drain_inbox("child1").is_empty());
        // Outsider's inbox is untouched.
        assert!(drain_inbox("outsider").is_empty());
    }

    /// Non-string messages stringify to JSON on the wire.
    #[tokio::test]
    async fn broadcast_stringifies_non_string_payload() {
        let _g = begin_test();
        register("p");
        register_with_parent("c1", "p");
        register_with_parent("c2", "p");

        let payload = serde_json::json!({"phase": "draft", "turn": 2});
        let n = broadcast_to_siblings("c1", payload).await.unwrap();
        assert_eq!(n, 1);
        let inbox = drain_inbox("c2");
        assert_eq!(inbox.len(), 1);
        // json! renders object field order stably for small keys; assert
        // on substrings rather than exact ordering to stay robust.
        assert!(inbox[0].content.contains("\"phase\""));
        assert!(inbox[0].content.contains("\"draft\""));
    }

    /// Stale-parent pruning: register 1 parent + 9 children, complete
    /// each child (set_result flips their slot to `Some(_)`), and
    /// verify `prune_stale_parents` removes exactly the 9 children.
    /// The parent has no PARENTS entry (it's root-registered) so it's
    /// invisible to the pruner regardless — but its INBOXES / RESULTS
    /// slots stay untouched, which is what we assert last. Guards
    /// against the 24h leak where PARENTS grows unbounded as children
    /// terminate without cleanup.
    #[tokio::test]
    async fn prune_removes_finished_children_keeps_parent() {
        let _g = begin_test();
        register("parent");
        for i in 0..9 {
            let id = format!("child-{i}");
            register_with_parent(&id, "parent");
            set_result(&id, format!("ans-{i}"));
        }

        let removed = prune_stale_parents().await;
        assert_eq!(removed, 9, "all 9 finished children should be pruned");

        // PARENTS map is now empty — every child is gone and the
        // parent was never registered via `register_with_parent`.
        {
            let map = parents().lock().unwrap();
            assert!(map.is_empty(), "parents map should be empty: {map:?}");
        }

        // Parent's own INBOXES + RESULTS entries are preserved — the
        // pruner only touches ids that appear in PARENTS, so a root
        // agent that's still "running" (Some slot, empty inbox) is
        // safe. We verify by re-setting its result and re-checking.
        assert!(is_registered("parent"), "parent must remain registered");
        set_result("parent", "parent-done".into());
        let map = results().lock().unwrap();
        assert_eq!(map.get("parent"), Some(&Some("parent-done".to_string())));
    }

    /// Pruning should NOT drop a terminated child while messages are
    /// still queued in its inbox — that would silently discard the
    /// tail of a sibling hand-off. The receiver drains on its next
    /// turn, then the following prune tick collects.
    #[tokio::test]
    async fn prune_defers_when_inbox_nonempty() {
        let _g = begin_test();
        register("p");
        register_with_parent("c", "p");
        post_message("sibling", "c", "last-word").unwrap();
        set_result("c", "done".into());

        // First tick: inbox non-empty, nothing pruned.
        assert_eq!(prune_stale_parents().await, 0);
        assert!(is_registered("c"), "should still be addressable");

        // Receiver drains, then second tick collects.
        let _ = drain_inbox("c");
        assert_eq!(prune_stale_parents().await, 1);
    }

    /// Spawn-hold: `wait_for_results` for an id that doesn't exist yet
    /// should stay open, and then resolve once the id is registered and
    /// completes. Mirrors the researcher→writer handoff where the
    /// researcher waits before the writer has actually spawned.
    #[tokio::test]
    async fn wait_holds_open_for_unspawned_sibling() {
        let _g = begin_test();
        // Target id is deliberately NOT registered up front.
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            register("late-writer");
            tokio::time::sleep(Duration::from_millis(40)).await;
            set_result("late-writer", "drafted".into());
        });

        let started = Instant::now();
        let out = wait_for_results(
            &["late-writer".into()],
            Duration::from_secs(5),
        )
        .await;
        let took = started.elapsed();

        assert_eq!(
            out.get("late-writer"),
            Some(&Some("drafted".to_string())),
            "wait should resolve once the late sibling registers + completes",
        );
        // Must have waited for the spawn + completion but not the full
        // 5 s timeout — anything under 1 s is plenty of headroom.
        assert!(took < Duration::from_secs(1), "took: {took:?}");
    }
}
