//! Tiny time/parsing utilities shared across world submodules.

use chrono::TimeZone;

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn local_iso_now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%z").to_string()
}

pub fn os_version_hint() -> String {
    // Best-effort — we never call sw_vers synchronously here (it would
    // slow every tick). The frontend's `navigator.userAgent`-based
    // rendering still shows a nicer version; this Rust-side value is a
    // fallback for CLI consumers of world.json.
    "macOS".to_string()
}

pub fn iso_to_unix(iso: &str) -> Option<i64> {
    // Calendar emits "YYYY-MM-DDTHH:MM:SS" in local time. Parse as naive
    // and treat as local.
    let naive = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S").ok())?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp())
}
