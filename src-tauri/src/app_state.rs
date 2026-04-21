//! Tauri-managed application state. Fields are `pub` so domain command
//! wrappers in `commands.rs` can access them via `tauri::State<'_, AppState>`.

use std::sync::Mutex;

use crate::audio;
use crate::clipboard::ClipboardEntry;
use crate::metrics;
use crate::nav::CurrentView;
use crate::pty;

pub struct AppState {
    pub collector: Mutex<metrics::Collector>,
    pub ptys: pty::PtyRegistry,
    pub recorder: audio::Recorder,
    pub clipboard: Mutex<Vec<ClipboardEntry>>,
    /// Last view the frontend told us is currently visible. Written by
    /// `nav_set_current` every time `setView` runs; read by `page_peek`
    /// so the agent can answer "what page am I on".
    pub current_view: Mutex<Option<CurrentView>>,
}
