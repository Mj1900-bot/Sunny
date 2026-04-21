//! Side-effecting helpers fired on focus change:
//!   - write a perception-kind episodic row (rate-limited to avoid spam)
//!   - optionally capture screen OCR (opt-in via settings)

use std::sync::OnceLock;

use super::helpers::now_secs;
use super::model::WorldState;
use crate::{memory, ocr, settings, vision};

// ---------------------------------------------------------------------------
// Focus-change perception episode
// ---------------------------------------------------------------------------

/// Write a perception-kind episodic row capturing the focus transition.
/// Runs in a spawned task so it never stretches a tick.
pub(super) fn spawn_focus_episode(prev: &WorldState, next: &WorldState) {
    let from = prev
        .focus
        .as_ref()
        .map(|f| f.app_name.clone())
        .unwrap_or_else(|| "—".into());
    let to_app = next
        .focus
        .as_ref()
        .map(|f| f.app_name.clone())
        .unwrap_or_else(|| "—".into());
    let to_title = next
        .focus
        .as_ref()
        .map(|f| f.window_title.clone())
        .unwrap_or_default();
    let activity = next.activity.as_str().to_string();

    // Drop perception spam: if the user is rapidly alt-tabbing, these rows
    // would pile up. One row per unique (from,to) pair per minute is plenty.
    if !should_log_focus_change(&from, &to_app) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let text = if to_title.trim().is_empty() {
            format!("Focus: {from} → {to_app} [{activity}]")
        } else {
            format!("Focus: {from} → {to_app} — {to_title} [{activity}]")
        };
        let meta = serde_json::json!({
            "from": from,
            "to": to_app,
            "title": to_title,
            "activity": activity,
        });
        let _ = memory::episodic_add(
            memory::EpisodicKind::Perception,
            text,
            vec!["focus".into(), activity],
            meta,
        );
    });
}

/// Module-local rate limiter for focus-change episodic writes. Keeps a
/// small history of (from,to,at_secs) entries and drops any (from,to)
/// pair that fired within the last 60 seconds.
pub(super) fn should_log_focus_change(from: &str, to: &str) -> bool {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    static LOG: OnceLock<Mutex<VecDeque<(String, String, i64)>>> = OnceLock::new();
    let cell = LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(32)));
    let Ok(mut q) = cell.lock() else { return true };
    let now = now_secs();
    q.retain(|(_, _, t)| now - *t < 300); // keep 5 minutes
    let recently = q.iter().any(|(a, b, t)| a == from && b == to && now - *t < 60);
    if recently {
        return false;
    }
    q.push_back((from.to_string(), to.to_string(), now));
    if q.len() > 32 {
        q.pop_front();
    }
    true
}

// ---------------------------------------------------------------------------
// Focus-triggered screen OCR (opt-in)
// ---------------------------------------------------------------------------
//
// When `screenOcrEnabled` is set in settings, every focus change triggers
// a best-effort OCR capture of the now-frontmost window. The extracted
// text lands as a `perception` episodic row so the consolidator can mine
// it (e.g. "user had the error 'cannot find symbol X' on screen at 14:03")
// and future "what did that window say" queries find it by FTS / embed.
//
// Off by default for privacy — screen contents often include secrets. The
// user toggles it in Settings. We also rate-limit aggressively (OCR is
// CPU-heavy) and gate on the Screen Recording permission via
// `vision::capture_active_window` which returns a clear error when denied.

/// Minimum interval between OCR captures, regardless of focus changes.
/// 90 s keeps the CPU footprint small (tesseract spikes to 1 core for ~1s)
/// while still catching meaningful app transitions.
const OCR_MIN_INTERVAL_SECS: i64 = 90;

/// Cap on OCR text stored per episodic row. Screen OCR produces kilobytes
/// of noisy text — store a compact tail so FTS still finds useful words
/// without bloating the memory DB.
const OCR_STORE_CAP: usize = 1200;

pub(super) fn spawn_focus_ocr(next: &WorldState) {
    if !ocr_enabled_in_settings() {
        return;
    }
    if !ocr_rate_limit_ok() {
        return;
    }
    let focus_name = next
        .focus
        .as_ref()
        .map(|f| f.app_name.clone())
        .unwrap_or_default();
    if focus_name.is_empty() {
        return;
    }
    let activity = next.activity.as_str().to_string();

    tauri::async_runtime::spawn(async move {
        // Capture the frontmost window. If the user hasn't granted Screen
        // Recording permission, this returns a clear error — we swallow it
        // silently so missing permissions don't spam the log every 15s.
        let img = match vision::capture_active_window().await {
            Ok(img) => img,
            Err(e) => {
                log::debug!("focus-ocr: capture failed ({e})");
                return;
            }
        };
        let result = match ocr::ocr_image_base64(img.base64, None).await {
            Ok(r) => r,
            Err(e) => {
                log::debug!("focus-ocr: tesseract failed ({e})");
                return;
            }
        };
        let text = result.text.trim();
        if text.len() < 12 {
            // Too little text to be useful; save the write and ignore.
            return;
        }
        let cap = text.len().min(OCR_STORE_CAP);
        let body = if text.len() > cap {
            format!("{} …", &text[..cap])
        } else {
            text.to_string()
        };

        let text_out = format!("Screen OCR: {focus_name}\n{body}");
        let meta = serde_json::json!({
            "focus_app": focus_name,
            "activity": activity,
            "ocr_text_len": text.len(),
            "ocr_boxes": result.boxes.len(),
        });
        let _ = memory::episodic_add(
            memory::EpisodicKind::Perception,
            text_out,
            vec!["screen-ocr".into(), "perception".into(), activity.clone()],
            meta,
        );
    });
}

/// Reads `~/.sunny/settings.json` to check whether the user opted into
/// screen OCR. Called once per focus-change tick; loaded lazily and
/// treated permissively (any parse failure → OCR disabled).
fn ocr_enabled_in_settings() -> bool {
    let Ok(value) = settings::load() else { return false };
    let Some(obj) = value.as_object() else { return false };
    obj.get("screenOcrEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Rate-limit OCR captures across the whole process. Module-local
/// OnceLock guards the last-capture timestamp; we refuse new captures
/// until OCR_MIN_INTERVAL_SECS has elapsed.
fn ocr_rate_limit_ok() -> bool {
    use std::sync::Mutex;
    static LAST: OnceLock<Mutex<i64>> = OnceLock::new();
    let cell = LAST.get_or_init(|| Mutex::new(0));
    let Ok(mut guard) = cell.lock() else { return false };
    let now = now_secs();
    if now - *guard < OCR_MIN_INTERVAL_SECS {
        return false;
    }
    *guard = now;
    true
}
