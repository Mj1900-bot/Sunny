//! Incident-response snapshot bundler.
//!
//! When `panic::engage` fires we capture a forensic bundle to
//! `~/.sunny/security/incidents/<iso-timestamp>.json` containing:
//!
//!   * the last 500 events from the ring (already JSONL-persisted,
//!     but a local copy in one file makes sharing easier),
//!   * current system-integrity grid,
//!   * current enforcement policy,
//!   * current canary status,
//!   * active connections (`lsof -iP`) + descendant processes,
//!   * per-tool rate snapshot,
//!   * FIM baseline at the moment of panic.
//!
//! The bundle is intentionally self-contained so a user can share it
//! or hand it to an incident responder without having to recombine
//! state from five different files.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize)]
struct Bundle {
    captured_at: i64,
    reason: String,
    events: Vec<super::SecurityEvent>,
    summary: serde_json::Value,
    integrity: super::integrity::IntegrityGrid,
    policy: super::enforcement::EnforcementPolicy,
    canary: serde_json::Value,
    connections: Vec<super::connections::Connection>,
    processes: Vec<super::watchers::process_tree::DescendantProcess>,
    tool_rates: Vec<super::behavior::ToolRateSnapshot>,
    fim: super::fim::FimBaseline,
    bundle_info: super::integrity::BundleInfo,
}

/// Capture a bundle and return its on-disk path.  Called from
/// `panic::engage` right after the flag is set so the forensic
/// snapshot records the state at the moment the tripwire fired.
pub async fn capture(reason: &str) -> Option<PathBuf> {
    let events = super::store().map(|s| s.recent(500, None)).unwrap_or_default();
    let summary = serde_json::to_value(super::policy::compute_summary())
        .unwrap_or(serde_json::Value::Null);
    let integrity = super::integrity::current_grid().await;
    let policy = super::enforcement::snapshot();
    let canary = canary_status_value();
    let connections = super::connections::snapshot().await;
    let processes = super::watchers::process_tree::snapshot();
    let tool_rates = super::behavior::snapshot();
    let fim = super::fim::current_baseline();
    let bundle_info = super::integrity::bundle_info().await;

    let bundle = Bundle {
        captured_at: super::now(),
        reason: reason.to_string(),
        events,
        summary,
        integrity,
        policy,
        canary,
        connections,
        processes,
        tool_rates,
        fim,
        bundle_info,
    };

    let dir = super::resolve_data_dir().join("incidents");
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("security: incident dir create failed: {e}");
        return None;
    }
    let name = format!("incident-{}.json", iso_stamp(super::now()));
    let path = dir.join(name);
    match serde_json::to_string_pretty(&bundle) {
        Ok(body) => {
            if let Err(e) = fs::write(&path, body) {
                log::warn!("security: incident write failed: {e}");
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&path) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o600);
                    let _ = fs::set_permissions(&path, perms);
                }
            }
            Some(path)
        }
        Err(e) => {
            log::warn!("security: incident serialize failed: {e}");
            None
        }
    }
}

/// Returns a vector of prior incident bundles (path, mtime, size).
pub fn list() -> Vec<IncidentEntry> {
    let dir = super::resolve_data_dir().join("incidents");
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<IncidentEntry> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            let meta = path.metadata().ok()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(IncidentEntry {
                path: path.to_string_lossy().to_string(),
                captured_at: mtime,
                size: meta.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
    out
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct IncidentEntry {
    pub path: String,
    #[ts(type = "number")]
    pub captured_at: i64,
    #[ts(type = "number")]
    pub size: u64,
}

fn canary_status_value() -> serde_json::Value {
    let tok = super::canary::token().unwrap_or("");
    let armed = !tok.is_empty();
    let short = if tok.len() > 14 {
        format!("{}…{}", &tok[..10], &tok[tok.len() - 4..])
    } else { tok.to_string() };
    serde_json::json!({
        "armed": armed,
        "token_preview": short,
    })
}

fn iso_stamp(unix: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_opt(unix, 0)
        .single()
        .map(|d| d.format("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_else(|| unix.to_string())
}
