//! chat.db poller — watches selected conversations for new inbound messages
//! and emits a `messages:new` Tauri event per arrival. The frontend proxy
//! engine consumes these events, drafts a reply, and either auto-sends (after
//! the 30s gate) or queues a user-approved draft.
//!
//! # Design
//!
//! - Tokio task, 5s tick. Cheap: one `sqlite3 -readonly` spawn per enabled
//!   handle per tick, bailing out early when the frontend has no active
//!   subscriptions (the default state on first launch).
//! - The frontend registers the set of handles it cares about via
//!   `messages_watcher_set_subscriptions`. Each subscription carries a
//!   `since_rowid` cursor so we only emit messages strictly newer than what
//!   the frontend has already seen. Without the cursor, a restart would
//!   re-emit every pending message and re-fire proxy drafts.
//! - We only emit inbound rows (`is_from_me = 0`) because the proxy has
//!   nothing to do with messages the user themselves just sent.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use ts_rs::TS;

use crate::messaging;

const TICK_INTERVAL: Duration = Duration::from_secs(5);
const PER_TICK_LIMIT: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Subscription {
    pub chat_identifier: String,
    /// Emit only messages with ROWID > since_rowid. Frontend updates this as
    /// it processes events (via the same set-subscriptions call).
    #[ts(type = "number")]
    pub since_rowid: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct NewMessageEvent {
    pub chat_identifier: String,
    #[ts(type = "number")]
    pub rowid: i64,
    pub text: String,
    #[ts(type = "number")]
    pub ts: i64,
    pub sender: Option<String>,
    pub has_attachment: bool,
}

pub type WatchState = Arc<RwLock<HashMap<String, Subscription>>>;

/// Global registry of active subscriptions. Wrapped in an `Arc<RwLock<…>>` so
/// the Tauri command handler can mutate it while the poller task reads from
/// it on every tick.
pub fn state() -> WatchState {
    STATE.clone()
}

pub fn start(app: AppHandle) {
    let state = state();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(TICK_INTERVAL);
        // First tick fires immediately; burn it so we don't race app startup.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = poll_once(&app, &state).await {
                log::warn!("messages_watcher tick failed: {e}");
            }
        }
    });
}

async fn poll_once(app: &AppHandle, state: &WatchState) -> Result<(), String> {
    // Snapshot the subscription map so we don't hold the lock across awaits.
    let subs: Vec<Subscription> = {
        let guard = state.read().await;
        if guard.is_empty() {
            return Ok(());
        }
        guard.values().cloned().collect()
    };

    for sub in subs {
        match messaging::fetch_conversation(
            sub.chat_identifier.clone(),
            Some(PER_TICK_LIMIT),
            Some(sub.since_rowid),
        )
        .await
        {
            Ok(rows) => {
                let mut max_rowid = sub.since_rowid;
                for m in rows {
                    if m.from_me {
                        // Track the rowid so we don't re-read our own sends,
                        // but never emit them — the proxy only cares about
                        // incoming traffic.
                        if m.rowid > max_rowid {
                            max_rowid = m.rowid;
                        }
                        continue;
                    }
                    if m.rowid > max_rowid {
                        max_rowid = m.rowid;
                    }
                    let event = NewMessageEvent {
                        chat_identifier: sub.chat_identifier.clone(),
                        rowid: m.rowid,
                        text: m.text,
                        ts: m.ts,
                        sender: m.sender,
                        has_attachment: m.has_attachment,
                    };
                    if let Err(e) = app.emit("messages:new", &event) {
                        log::warn!("emit messages:new failed: {e}");
                    }
                }
                // Advance the cursor so the next tick doesn't re-fetch rows
                // we just emitted. The frontend is *also* expected to call
                // `messages_watcher_set_subscriptions` with an updated cursor
                // after it's processed the event, but we move here as a
                // defense-in-depth in case the frontend is slow.
                if max_rowid > sub.since_rowid {
                    let mut guard = state.write().await;
                    if let Some(entry) = guard.get_mut(&sub.chat_identifier) {
                        if max_rowid > entry.since_rowid {
                            entry.since_rowid = max_rowid;
                        }
                    }
                }
            }
            Err(e) => {
                // chat.db unavailable (FDA revoked, db closed mid-migration, etc.)
                // is routine. Log once per tick and move on.
                log::warn!(
                    "messages_watcher fetch_conversation({}) failed: {e}",
                    sub.chat_identifier
                );
            }
        }
    }

    Ok(())
}

pub async fn set_subscriptions(subs: Vec<Subscription>) -> Result<(), String> {
    let st = state();
    let mut guard = st.write().await;
    guard.clear();
    for s in subs {
        if s.chat_identifier.is_empty() {
            continue;
        }
        guard.insert(s.chat_identifier.clone(), s);
    }
    Ok(())
}

pub async fn list_subscriptions() -> Vec<Subscription> {
    let st = state();
    let guard = st.read().await;
    guard.values().cloned().collect()
}

static STATE: std::sync::LazyLock<WatchState> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));
