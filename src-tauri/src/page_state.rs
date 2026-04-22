//! Per-page visible state snapshots so the agent can "see" what the user
//! sees without screen recording.
//!
//! Each of SUNNY's stateful pages (Calendar, Tasks, Inbox, Focus, Notes,
//! Voice) registers a small JSON-serialisable snapshot here on every
//! meaningful local state change. The agent reads the snapshots back via
//! read-only `page_state_<name>` tools in the catalog.
//!
//! Every snapshot type is:
//!   * `Serialize + Deserialize + Clone + Default` so the setter is
//!     trivial and the getter returns an "empty" default before the page
//!     has been visited.
//!   * `<500 bytes` worth of fields — we truncate arrays at the frontend
//!     side (see `usePageStateSync.ts`) so we never balloon memory when
//!     e.g. 10k tasks are loaded.
//!
//! Nothing here is attacker-controlled except strings the user typed
//! (filter queries, selected ids). The `ExternalRead` trust class in the
//! catalog applies — snapshots go through the `<untrusted_source>`
//! envelope before they reach the LLM.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Snapshot shapes — one per page
// ---------------------------------------------------------------------------

/// CalendarPage visible state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CalendarSnapshot {
    pub active_date: String,
    pub view_mode: String,
    #[serde(default)]
    #[ts(optional)]
    pub selected_event_id: Option<String>,
    #[serde(default)]
    pub hidden_calendars: Vec<String>,
}

/// TasksPage visible state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TasksSnapshot {
    pub active_tab: String,
    #[serde(default)]
    pub selected_ids: Vec<String>,
    #[serde(default)]
    pub filter_query: String,
    #[serde(default)]
    #[ts(type = "number")]
    pub total_count: u32,
    #[serde(default)]
    #[ts(type = "number")]
    pub completed_count: u32,
}

/// InboxPage visible state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InboxSnapshot {
    #[serde(default)]
    #[ts(optional)]
    pub selected_item_id: Option<String>,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub triage_labels_summary: String,
}

/// FocusPage visible state. Note: NOT TS-exported because the name clashes
/// with `world::model::FocusSnapshot`; the `page_state_focus` commands keep
/// their `unknown` fallback to avoid a generator collision.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FocusSnapshot {
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub elapsed_secs: u32,
    #[serde(default)]
    pub target_secs: u32,
    #[serde(default)]
    pub mode: Option<String>,
}

/// NotesPage visible state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NotesSnapshot {
    #[serde(default)]
    #[ts(optional)]
    pub selected_note_id: Option<String>,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub search_query: String,
}

/// VoicePage visible state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceSnapshot {
    #[serde(default)]
    pub recording: bool,
    #[serde(default)]
    #[ts(optional)]
    pub last_transcript: Option<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub clip_count: u32,
}

/// Union of all per-page snapshots. Missing pages default to empty.
#[derive(Debug, Default)]
pub struct PageStatesSnapshot {
    pub calendar: CalendarSnapshot,
    pub tasks: TasksSnapshot,
    pub inbox: InboxSnapshot,
    pub focus: FocusSnapshot,
    pub notes: NotesSnapshot,
    pub voice: VoiceSnapshot,
}

/// Wrapper managed by Tauri. Exposed as `tauri::State<'_, PageStates>`.
/// Uses a single `Mutex` over the whole snapshot bundle — contention is
/// a non-issue given snapshot writes happen at most a few Hz per page.
pub struct PageStates {
    pub inner: Mutex<PageStatesSnapshot>,
}

impl PageStates {
    pub fn new() -> Self {
        Self { inner: Mutex::new(PageStatesSnapshot::default()) }
    }
}

impl Default for PageStates {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — 6 getters (read-only, exposed to agent) + 6 setters
// (frontend-only, NOT registered as agent tools).
// ---------------------------------------------------------------------------

/// Macro to cut down on boilerplate for the 12 commands. Each call site
/// expands into `page_state_<page>()` and `page_state_<page>_set()`.
macro_rules! page_state_cmds {
    ($get:ident, $set:ident, $field:ident, $ty:ident) => {
        #[tauri::command]
        pub fn $get(state: tauri::State<'_, PageStates>) -> Result<$ty, String> {
            let guard = state
                .inner
                .lock()
                .map_err(|_| concat!(stringify!($get), ": mutex poisoned").to_string())?;
            Ok(guard.$field.clone())
        }

        #[tauri::command]
        pub fn $set(
            state: tauri::State<'_, PageStates>,
            snapshot: $ty,
        ) -> Result<(), String> {
            let mut guard = state
                .inner
                .lock()
                .map_err(|_| concat!(stringify!($set), ": mutex poisoned").to_string())?;
            guard.$field = snapshot;
            Ok(())
        }
    };
}

page_state_cmds!(page_state_calendar, page_state_calendar_set, calendar, CalendarSnapshot);
page_state_cmds!(page_state_tasks, page_state_tasks_set, tasks, TasksSnapshot);
page_state_cmds!(page_state_inbox, page_state_inbox_set, inbox, InboxSnapshot);
page_state_cmds!(page_state_focus, page_state_focus_set, focus, FocusSnapshot);
page_state_cmds!(page_state_notes, page_state_notes_set, notes, NotesSnapshot);
page_state_cmds!(page_state_voice, page_state_voice_set, voice, VoiceSnapshot);

/// Convenience helper used by the agent dispatcher so we don't have to
/// re-lock from inside `dispatch.rs`. Returns the JSON encoding of the
/// named page's current snapshot, or a default if never set.
pub fn snapshot_json(state: &PageStates, page: &str) -> Result<String, String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| format!("page_state[{page}]: mutex poisoned"))?;
    let value = match page {
        "calendar" => serde_json::to_string(&guard.calendar),
        "tasks" => serde_json::to_string(&guard.tasks),
        "inbox" => serde_json::to_string(&guard.inbox),
        "focus" => serde_json::to_string(&guard.focus),
        "notes" => serde_json::to_string(&guard.notes),
        "voice" => serde_json::to_string(&guard.voice),
        other => return Err(format!("page_state: unknown page `{other}`")),
    };
    value.map_err(|e| format!("page_state[{page}]: encode: {e}"))
}
