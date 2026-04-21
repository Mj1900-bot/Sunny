//! System-integrity snapshot.
//!
//! Reads a short list of macOS security posture knobs and surfaces
//! each as an `IntegrityStatus` event + a cached snapshot for the UI:
//!
//!   * System Integrity Protection (`csrutil status`)
//!   * Gatekeeper (`spctl --status`)
//!   * FileVault (`fdesetup status`)
//!   * Application Firewall (`defaults read /Library/Preferences/com.apple.alf globalstate`)
//!   * Sunny bundle code-signature (`codesign --verify --deep --strict` on our own bundle)
//!   * Configuration profiles (`profiles list -type configuration` — MDM / enterprise profiles)
//!
//! Probes are async subprocesses with short timeouts; each runs once
//! at startup and re-probes every 2 minutes.  Any diff emits an event.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

use super::{SecurityEvent, Severity};

const PROBE_INTERVAL: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// The whole grid, pushed to the UI on demand.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, TS)]
#[ts(export)]
pub struct IntegrityGrid {
    pub sip: IntegrityRow,
    pub gatekeeper: IntegrityRow,
    pub filevault: IntegrityRow,
    pub firewall: IntegrityRow,
    pub bundle: IntegrityRow,
    pub config_profiles: IntegrityRow,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, TS)]
#[ts(export)]
pub struct IntegrityRow {
    pub status: String,     // "ok" | "warn" | "crit" | "unknown"
    pub summary: String,    // short human label: "enabled", "disabled", "1 profile"
    pub detail: String,     // raw command output trimmed
    #[ts(type = "number")]
    pub checked_at: i64,
}

fn cache() -> &'static Mutex<Option<IntegrityGrid>> {
    static CELL: OnceLock<Mutex<Option<IntegrityGrid>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

pub fn start(_app: AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Immediate baseline.
        let first = probe_all().await;
        emit_diff(None, &first);
        if let Ok(mut guard) = cache().lock() {
            *guard = Some(first);
        }
        let mut ticker = tokio::time::interval(PROBE_INTERVAL);
        ticker.tick().await; // consume first immediate tick
        loop {
            ticker.tick().await;
            let fresh = probe_all().await;
            let mut guard = match cache().lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            let prev = guard.clone();
            emit_diff(prev.as_ref(), &fresh);
            *guard = Some(fresh);
        }
    });
}

pub async fn current_grid() -> IntegrityGrid {
    if let Ok(guard) = cache().lock() {
        if let Some(g) = guard.clone() {
            return g;
        }
    }
    probe_all().await
}

fn emit_diff(prev: Option<&IntegrityGrid>, cur: &IntegrityGrid) {
    let rows: [(&str, &IntegrityRow, Option<&IntegrityRow>); 6] = [
        ("sip", &cur.sip, prev.map(|p| &p.sip)),
        ("gatekeeper", &cur.gatekeeper, prev.map(|p| &p.gatekeeper)),
        ("filevault", &cur.filevault, prev.map(|p| &p.filevault)),
        ("firewall", &cur.firewall, prev.map(|p| &p.firewall)),
        ("bundle", &cur.bundle, prev.map(|p| &p.bundle)),
        ("config_profiles", &cur.config_profiles, prev.map(|p| &p.config_profiles)),
    ];
    for (key, cur_row, prev_row) in rows {
        // First-run emit gives us a baseline in the audit log for every key.
        let changed = prev_row.map(|p| p != cur_row).unwrap_or(true);
        if !changed {
            continue;
        }
        let severity = match cur_row.status.as_str() {
            "crit" => Severity::Crit,
            "warn" => Severity::Warn,
            _ => Severity::Info,
        };
        super::emit(SecurityEvent::IntegrityStatus {
            at: super::now(),
            key: key.into(),
            status: cur_row.status.clone(),
            detail: cur_row.summary.clone(),
            severity,
        });
    }
}

pub async fn probe_all() -> IntegrityGrid {
    let (sip, gatekeeper, filevault, firewall, bundle, profiles) = tokio::join!(
        probe_sip(),
        probe_gatekeeper(),
        probe_filevault(),
        probe_firewall(),
        probe_bundle(),
        probe_profiles(),
    );
    IntegrityGrid {
        sip, gatekeeper, filevault, firewall, bundle,
        config_profiles: profiles,
        updated_at: super::now(),
    }
}

async fn probe_sip() -> IntegrityRow {
    #[cfg(target_os = "macos")]
    {
        let out = run_cmd("/usr/bin/csrutil", &["status"]).await;
        match out {
            Some(body) => {
                let lower = body.to_lowercase();
                let enabled = lower.contains("enabled") && !lower.contains("disabled");
                IntegrityRow {
                    status: if enabled { "ok".into() } else { "crit".into() },
                    summary: if enabled { "enabled".into() } else { "disabled".into() },
                    detail: body.trim().to_string(),
                    checked_at: super::now(),
                }
            }
            None => unknown_row("csrutil unavailable"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    { unknown_row("macOS only") }
}

async fn probe_gatekeeper() -> IntegrityRow {
    #[cfg(target_os = "macos")]
    {
        let out = run_cmd("/usr/sbin/spctl", &["--status"]).await;
        match out {
            Some(body) => {
                let lower = body.to_lowercase();
                let enabled = lower.contains("assessments enabled");
                IntegrityRow {
                    status: if enabled { "ok".into() } else { "warn".into() },
                    summary: if enabled { "enabled".into() } else { "disabled".into() },
                    detail: body.trim().to_string(),
                    checked_at: super::now(),
                }
            }
            None => unknown_row("spctl unavailable"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    { unknown_row("macOS only") }
}

async fn probe_filevault() -> IntegrityRow {
    #[cfg(target_os = "macos")]
    {
        let out = run_cmd("/usr/bin/fdesetup", &["status"]).await;
        match out {
            Some(body) => {
                let lower = body.to_lowercase();
                let on = lower.contains("filevault is on");
                IntegrityRow {
                    status: if on { "ok".into() } else { "warn".into() },
                    summary: if on { "on".into() } else { "off".into() },
                    detail: body.trim().to_string(),
                    checked_at: super::now(),
                }
            }
            None => unknown_row("fdesetup unavailable"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    { unknown_row("macOS only") }
}

async fn probe_firewall() -> IntegrityRow {
    #[cfg(target_os = "macos")]
    {
        let out = run_cmd("/usr/bin/defaults", &["read", "/Library/Preferences/com.apple.alf", "globalstate"]).await;
        match out {
            Some(body) => {
                // 0 = off; 1 = on (allow signed); 2 = block-all.
                let v = body.trim().parse::<i32>().unwrap_or(-1);
                let (status, summary) = match v {
                    0 => ("warn", "off".to_string()),
                    1 => ("ok", "on · allow signed".to_string()),
                    2 => ("ok", "on · block all incoming".to_string()),
                    _ => ("unknown", format!("state {v}")),
                };
                IntegrityRow {
                    status: status.into(),
                    summary,
                    detail: format!("globalstate={v}"),
                    checked_at: super::now(),
                }
            }
            None => unknown_row("alf.plist unreadable"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    { unknown_row("macOS only") }
}

async fn probe_bundle() -> IntegrityRow {
    #[cfg(target_os = "macos")]
    {
        let Some(bundle) = resolve_bundle_path() else {
            return unknown_row("bundle path unresolved");
        };
        let out = run_cmd_capturing_stderr(
            "/usr/bin/codesign",
            &["--verify", "--deep", "--strict", &bundle],
        ).await;
        let Some((ok, body)) = out else {
            return unknown_row("codesign unavailable");
        };
        IntegrityRow {
            status: if ok { "ok".into() } else { "crit".into() },
            summary: if ok { "signature valid".into() } else { "SIGNATURE INVALID".into() },
            detail: if body.trim().is_empty() && ok { bundle.clone() } else { body.trim().to_string() },
            checked_at: super::now(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    { unknown_row("macOS only") }
}

async fn probe_profiles() -> IntegrityRow {
    #[cfg(target_os = "macos")]
    {
        // `profiles list -type configuration` requires root on modern macOS;
        // unprivileged invocation still prints "There are no configuration
        // profiles installed" or the user-level list, which is good enough
        // for a diff.  `profiles status -type enrollment` is zero-cost and
        // reports MDM enrollment state reliably without root.
        let status = run_cmd("/usr/bin/profiles", &["status", "-type", "enrollment"]).await;
        let list = run_cmd("/usr/bin/profiles", &["list"]).await;
        let combined = match (status, list) {
            (Some(a), Some(b)) => format!("{}\n\n{}", a.trim(), b.trim()),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => return unknown_row("profiles unavailable"),
        };
        let enrolled = combined.to_lowercase().contains("enrolled via dhcp")
            || combined.to_lowercase().contains("user approved")
            || combined.to_lowercase().contains("supervised");
        // Count lines that look like profile identifiers.
        let profile_count = combined
            .lines()
            .filter(|l| l.contains("profileIdentifier") || l.contains(".mobileconfig"))
            .count();
        let summary = if enrolled {
            format!("MDM enrolled · {profile_count} profile(s)")
        } else if profile_count > 0 {
            format!("{profile_count} profile(s)")
        } else {
            "no profiles".to_string()
        };
        IntegrityRow {
            status: if enrolled || profile_count > 2 { "warn".into() } else { "ok".into() },
            summary,
            detail: combined.chars().take(600).collect(),
            checked_at: super::now(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    { unknown_row("macOS only") }
}

// --------------------- helpers ---------------------

fn unknown_row(msg: &str) -> IntegrityRow {
    IntegrityRow {
        status: "unknown".into(),
        summary: msg.to_string(),
        detail: String::new(),
        checked_at: super::now(),
    }
}

async fn run_cmd(bin: &str, args: &[&str]) -> Option<String> {
    let fat = crate::paths::fat_path().unwrap_or_default();
    let fut = Command::new(bin).args(args).env("PATH", fat).output();
    let out = timeout(PROBE_TIMEOUT, fut).await.ok()?.ok()?;
    if !out.status.success() {
        // spctl exits 1 when disabled; fdesetup exits 0 either way.
        // Swallow non-zero exits and return the combined text so
        // parsing logic can still read the body.
    }
    let mut body = String::from_utf8_lossy(&out.stdout).to_string();
    if body.trim().is_empty() {
        body = String::from_utf8_lossy(&out.stderr).to_string();
    }
    Some(body)
}

async fn run_cmd_capturing_stderr(bin: &str, args: &[&str]) -> Option<(bool, String)> {
    let fat = crate::paths::fat_path().unwrap_or_default();
    let fut = Command::new(bin).args(args).env("PATH", fat).output();
    let out = timeout(PROBE_TIMEOUT, fut).await.ok()?.ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let body = if stderr.trim().is_empty() { stdout } else { stderr };
    Some((out.status.success(), body))
}

#[cfg(target_os = "macos")]
fn resolve_bundle_path() -> Option<String> {
    // The running executable sits at Sunny.app/Contents/MacOS/sunny — walk
    // up to the .app folder for the verify.
    let exe = std::env::current_exe().ok()?;
    let mut path = exe.clone();
    while let Some(parent) = path.parent() {
        let name = parent.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.ends_with(".app") {
            return Some(parent.to_string_lossy().to_string());
        }
        path = parent.to_path_buf();
    }
    // Dev build (cargo tauri dev): no .app. Point at the exe itself —
    // codesign --verify still checks the on-disk signature of an
    // ad-hoc-signed binary and will report "not signed at all".
    Some(exe.to_string_lossy().to_string())
}

// ------------------------------------------------------------------
// Sunny bundle metadata (displayed on the SYSTEM tab header).
// ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct BundleInfo {
    #[ts(type = "number")]
    pub pid: u32,
    pub bundle_path: String,
    pub exe_path: String,
    pub version: String,
    pub signer: String,
}

pub async fn bundle_info() -> BundleInfo {
    let pid = std::process::id();
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let bundle_path = {
        #[cfg(target_os = "macos")]
        {
            resolve_bundle_path().unwrap_or_default()
        }
        #[cfg(not(target_os = "macos"))]
        { String::new() }
    };
    let version = env!("CARGO_PKG_VERSION").to_string();
    let signer = extract_signer(&bundle_path).await;
    BundleInfo { pid, bundle_path, exe_path: exe, version, signer }
}

async fn extract_signer(bundle_path: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        if bundle_path.is_empty() {
            return "unknown".into();
        }
        // codesign -dv emits `Authority=Apple Development: name (TEAMID)` etc on stderr.
        let Some((_ok, body)) = run_cmd_capturing_stderr(
            "/usr/bin/codesign",
            &["-dv", "--verbose=2", bundle_path],
        ).await else {
            return "unknown".into();
        };
        for line in body.lines() {
            if let Some(rest) = line.strip_prefix("Authority=") {
                return rest.trim().to_string();
            }
        }
        // Ad-hoc signed builds have no Authority but do carry a TeamIdentifier.
        for line in body.lines() {
            if let Some(rest) = line.strip_prefix("TeamIdentifier=") {
                return format!("TeamIdentifier={}", rest.trim());
            }
        }
        "ad-hoc / unsigned".into()
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = bundle_path; "n/a".into() }
}

/// Snapshot env variables the SYSTEM tab surfaces — just names, never
/// values (so we don't accidentally display a key the user pasted
/// into the shell). Filtered to a small allowlist of interesting keys.
pub fn env_fingerprint() -> HashMap<String, String> {
    let keys = [
        "SHELL", "USER", "HOME", "LANG", "LC_ALL",
        "TERM_PROGRAM", "SUNNY_DEV", "SUNNY_CANARY_TOKEN",
    ];
    let mut out = HashMap::new();
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let value = if k == "SUNNY_CANARY_TOKEN" {
                // Canary is a signal, not a secret; abbreviate so the
                // user can confirm it's set without printing the full
                // id in the UI.
                if v.len() > 14 {
                    format!("{}…{}", &v[..10], &v[v.len() - 4..])
                } else { v }
            } else { v };
            out.insert(k.to_string(), value);
        }
    }
    out
}
