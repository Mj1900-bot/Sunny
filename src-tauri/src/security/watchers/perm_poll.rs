//! TCC permission poller.
//!
//! Polls every permission probe exposed by `permissions.rs` on a slow
//! cadence (every 10s), caches the last seen state, and emits a
//! `PermissionChange` event whenever a bit flips.
//!
//! This is how the Security nav-strip can light up the PERM chip
//! amber the moment a user revokes Accessibility, without the
//! frontend having to manually re-probe.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

use crate::security::{self, SecurityEvent, Severity};

const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Full TCC grid returned by `security_perm_grid`.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, TS)]
#[ts(export)]
pub struct PermGrid {
    pub screen_recording: PermState,
    pub accessibility: PermState,
    pub full_disk_access: PermState,
    pub automation: PermState,
    pub microphone: PermState,
    pub camera: PermState,
    pub contacts: PermState,
    pub calendar: PermState,
    pub reminders: PermState,
    pub photos: PermState,
    pub input_monitoring: PermState,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PermState {
    #[default]
    Unknown,
    Granted,
    Denied,
    /// Parked — reserved for future permission probes that can return a
    /// hard error distinct from "denied" (e.g. TCC corruption).
    #[allow(dead_code)]
    Error,
}

fn state_str(s: PermState) -> &'static str {
    match s {
        PermState::Unknown => "unknown",
        PermState::Granted => "granted",
        PermState::Denied => "denied",
        PermState::Error => "error",
    }
}

static LAST: OnceLock<Mutex<Option<PermGrid>>> = OnceLock::new();
fn last() -> &'static Mutex<Option<PermGrid>> {
    LAST.get_or_init(|| Mutex::new(None))
}

pub fn start(_app: AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        loop {
            ticker.tick().await;
            let fresh = probe_all().await;
            let mut guard = match last().lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if let Some(prev) = guard.clone() {
                emit_diff(&prev, &fresh);
            } else {
                // first pass — no deltas, just record the initial
                // baseline for the UI to render.
                security::emit(SecurityEvent::Notice {
                    at: security::now(),
                    source: "perm_poll".into(),
                    message: "initial permissions snapshot captured".into(),
                    severity: Severity::Info,
                });
            }
            *guard = Some(fresh);
        }
    });
}

fn emit_diff(prev: &PermGrid, cur: &PermGrid) {
    macro_rules! diff_field {
        ($field:ident) => {
            if prev.$field != cur.$field {
                let severity = match (prev.$field, cur.$field) {
                    (PermState::Granted, PermState::Denied) => Severity::Warn,
                    (PermState::Denied, PermState::Granted) => Severity::Info,
                    _ => Severity::Info,
                };
                security::emit(SecurityEvent::PermissionChange {
                    at: security::now(),
                    key: stringify!($field).into(),
                    previous: Some(state_str(prev.$field).to_string()),
                    current: state_str(cur.$field).to_string(),
                    severity,
                });
            }
        };
    }
    diff_field!(screen_recording);
    diff_field!(accessibility);
    diff_field!(full_disk_access);
    diff_field!(automation);
    diff_field!(microphone);
    diff_field!(camera);
    diff_field!(contacts);
    diff_field!(calendar);
    diff_field!(reminders);
    diff_field!(photos);
    diff_field!(input_monitoring);
}

/// Probe every TCC gate we care about. Each probe is best-effort —
/// failures land as `Unknown` rather than aborting the whole grid.
pub async fn probe_all() -> PermGrid {
    // Silent FFI probes — instant.
    let screen_recording = bool_to_state(crate::permissions::has_screen_recording());
    let accessibility = bool_to_state(crate::permissions::has_accessibility());
    let full_disk_access = bool_to_state(crate::permissions::has_full_disk_access());

    // Automation probe is async (osascript). Generous timeout upstream.
    let automation = match crate::permissions::check_automation_system_events().await {
        Ok(true) => PermState::Granted,
        Ok(false) => PermState::Denied,
        Err(_) => PermState::Unknown,
    };

    // File-open probes for Contacts / Calendar / Reminders / Photos —
    // reading the canonical DB file requires the matching TCC grant
    // (see permissions.rs comment block on FDA). These don't prompt.
    let contacts = bool_to_state(probe_contacts_db());
    let calendar = bool_to_state(probe_calendar_db());
    let reminders = bool_to_state(probe_reminders_db());
    let photos = bool_to_state(probe_photos_library());

    // Mic + camera probes — we don't want to actually open the device
    // (which triggers an OS prompt). Best we can do without
    // AVCaptureDevice FFI is treat them as Unknown. The Permissions tab
    // shows these as Unknown and offers a "Grant via System Settings"
    // affordance.
    let microphone = PermState::Unknown;
    let camera = PermState::Unknown;
    let input_monitoring = PermState::Unknown;

    PermGrid {
        screen_recording,
        accessibility,
        full_disk_access,
        automation,
        microphone,
        camera,
        contacts,
        calendar,
        reminders,
        photos,
        input_monitoring,
        updated_at: security::now(),
    }
}

fn bool_to_state(b: bool) -> PermState {
    if b { PermState::Granted } else { PermState::Denied }
}

#[cfg(target_os = "macos")]
fn probe_contacts_db() -> bool {
    use std::fs::File;
    let Some(home) = dirs::home_dir() else { return false };
    let candidates = [
        home.join("Library/Application Support/AddressBook/Sources"),
        home.join("Library/Application Support/AddressBook/AddressBook-v22.abcddb"),
    ];
    for p in candidates.iter() {
        if p.exists() && File::open(p).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn probe_calendar_db() -> bool {
    use std::fs::File;
    let Some(home) = dirs::home_dir() else { return false };
    let path = home.join("Library/Calendars");
    path.exists() && File::open(path).is_ok()
}

#[cfg(target_os = "macos")]
fn probe_reminders_db() -> bool {
    use std::fs::File;
    let Some(home) = dirs::home_dir() else { return false };
    let path = home.join("Library/Reminders");
    if path.exists() && File::open(&path).is_ok() {
        return true;
    }
    // Fall back to the group-containers copy which exists on
    // post-Catalina setups.
    let alt = home.join("Library/Group Containers/group.com.apple.reminders");
    alt.exists() && File::open(alt).is_ok()
}

#[cfg(target_os = "macos")]
fn probe_photos_library() -> bool {
    use std::fs::File;
    let Some(home) = dirs::home_dir() else { return false };
    let path = home.join("Pictures/Photos Library.photoslibrary");
    path.exists() && File::open(&path).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn probe_contacts_db() -> bool { false }
#[cfg(not(target_os = "macos"))]
fn probe_calendar_db() -> bool { false }
#[cfg(not(target_os = "macos"))]
fn probe_reminders_db() -> bool { false }
#[cfg(not(target_os = "macos"))]
fn probe_photos_library() -> bool { false }

/// On-demand fetch for the `security_perm_grid` command. Uses the
/// latest cached grid if one is available, falls back to a fresh probe
/// otherwise so the UI never has to wait for the slow poll interval
/// on first render.
pub async fn current_grid() -> PermGrid {
    if let Ok(guard) = last().lock() {
        if let Some(g) = guard.clone() {
            return g;
        }
    }
    probe_all().await
}
