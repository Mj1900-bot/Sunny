//! Clipboard sniffer types + helpers. The background loop that populates
//! `AppState::clipboard` lives in `startup.rs`; this module only owns the
//! data shape, classification helpers, raw `pbpaste` read, and the
//! frontend-facing `get_clipboard_history` command.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::app_state::AppState;

pub const CLIPBOARD_HISTORY_MAX: usize = 20;
pub const CLIPBOARD_DISPLAY_TRUNCATE: usize = 60;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClipboardEntry {
    pub kind: String, // 'TEXT' | 'URL' | 'CODE' | 'IMG'
    pub time: String, // "HH:MM"
    pub text: String,
}

pub fn classify_clipboard(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return "URL".to_string();
    }
    let looks_like_code = raw.contains('{')
        || raw.contains('}')
        || raw.contains("=>")
        || raw.contains("function")
        || raw.contains("const ")
        || raw.lines().filter(|l| l.starts_with("  ") || l.starts_with('\t')).count() >= 2;
    if looks_like_code {
        return "CODE".to_string();
    }
    "TEXT".to_string()
}

pub fn truncate_display(raw: &str) -> String {
    let single = raw.replace('\n', " ").replace('\r', " ");
    let collapsed: String = single.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > CLIPBOARD_DISPLAY_TRUNCATE {
        let cut: String = collapsed.chars().take(CLIPBOARD_DISPLAY_TRUNCATE).collect();
        format!("{}…", cut)
    } else {
        collapsed
    }
}

pub async fn pbpaste_read() -> Option<String> {
    // Image paste detection TODO via pasteboard types (NSPasteboard public.tiff / public.png).
    // For now we only read plain text via pbpaste — binary image data is not exposed here.
    let out = tokio::process::Command::new("pbpaste").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

#[tauri::command]
pub fn get_clipboard_history(state: tauri::State<'_, AppState>) -> Vec<ClipboardEntry> {
    state.clipboard.lock().unwrap().clone()
}
