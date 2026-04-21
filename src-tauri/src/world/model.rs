//! Wire-shape types for the world model.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::calendar::CalendarEvent;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Activity {
    Unknown,
    Coding,
    Writing,
    Meeting,
    Browsing,
    Communicating,
    Media,
    Terminal,
    Designing,
    Idle,
}

impl Default for Activity {
    fn default() -> Self {
        Activity::Unknown
    }
}

impl Activity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Activity::Unknown => "unknown",
            Activity::Coding => "coding",
            Activity::Writing => "writing",
            Activity::Meeting => "meeting",
            Activity::Browsing => "browsing",
            Activity::Communicating => "communicating",
            Activity::Media => "media",
            Activity::Terminal => "terminal",
            Activity::Designing => "designing",
            Activity::Idle => "idle",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct FocusSnapshot {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub window_title: String,
    /// Unix seconds at which the user switched to this app. `focused_duration_secs`
    /// is derived from this at render time.
    #[ts(type = "number")]
    pub focused_since_secs: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct AppSwitch {
    pub from_app: String,
    pub to_app: String,
    #[ts(type = "number")]
    pub at_secs: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct WorldState {
    #[ts(type = "number")]
    pub schema_version: u32,

    // Identity / time
    #[ts(type = "number")]
    pub timestamp_ms: i64,
    pub local_iso: String,
    pub host: String,
    pub os_version: String,

    // Focus / activity
    pub focus: Option<FocusSnapshot>,
    #[ts(type = "number")]
    pub focused_duration_secs: i64,
    pub activity: Activity,
    /// Most recent app switches, newest-first, capped at RECENT_SWITCHES.
    pub recent_switches: Vec<AppSwitch>,

    // Calendar
    pub next_event: Option<CalendarEvent>,
    #[ts(type = "number")]
    pub events_today: usize,

    // Mail
    #[ts(type = "number | null")]
    pub mail_unread: Option<i64>,

    // Machine
    pub cpu_pct: f32,
    pub temp_c: f32,
    pub mem_pct: f32,
    pub battery_pct: Option<f64>,
    pub battery_charging: Option<bool>,

    /// Seconds since the user last had keyboard/mouse activity (best-effort;
    /// populated by the world updater via IOHIDSystem idle time).
    /// Values >= 600 are treated as unattended by the consent gate.
    #[ts(type = "number")]
    #[serde(default)]
    pub idle_secs: i64,

    /// Monotonically increases every time the updater emits a new state.
    /// UIs can use it as a cheap change-detection key.
    #[ts(type = "number")]
    pub revision: u64,
}
