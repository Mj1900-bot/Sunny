//! Capability grant policy (sprint-13 β).
//!
//! Sprint-12 α stubbed out `check_capabilities` + `CapabilityVerdict` on
//! the Rust side of the dispatcher; `initiator_grants()` always returned
//! `None`, defaulting every caller to the full capability set. This
//! module makes that seam load-bearing:
//!
//!   * `grants_for(initiator)` is the single source of truth — resolves a
//!     grant set from `~/.sunny/grants.json` (cached in-process with a
//!     mtime-driven reload check so UI edits pick up without an app
//!     restart).
//!   * `agent:main` is always unscoped (default-allow) — the primary
//!     user path stays frictionless. Sub-agents / scheduler / daemons
//!     consult the persisted policy and fall back to a sensible
//!     read-only default for unknown sub-agents.
//!   * Every denial appends a JSONL row to `~/.sunny/capability_denials.log`
//!     so the user can audit after the fact. The dispatcher already
//!     logs the denial string to stderr on first occurrence (see
//!     `tool_trait::UNSCOPED_WARNED` / the per-triple ledger below),
//!     so the file is the durable counterpart.
//!
//! The grant taxonomy matches what the `agent_loop::tools::*` modules
//! declare on their specs — currently a mix of dotted (`network.read`)
//! and colon (`app:launch`) namespacing. Defaults below mirror exactly
//! those strings; adding a new tool adds its `CAPS` entry to the
//! relevant default set in this file when the tool should be
//! scheduler/daemon-callable.
//!
//! The TS side (`src/lib/skillExecutor.ts::checkCapability`) keeps its
//! own scope check for skills. That layer narrows further at skill-call
//! time — do not attempt to drive it from here.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::SystemTime;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// On-disk schema for `~/.sunny/grants.json`.
///
/// Shape:
/// ```json
/// {
///   "initiators": {
///     "agent:scheduler": ["macos.calendar.read", "memory.read"]
///   },
///   "default_for_sub_agents": ["memory.read", "compute.run"]
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct GrantsFile {
    /// Explicit per-initiator allowlist. Keys are initiator strings the
    /// dispatcher passes through (`agent:main`, `agent:scheduler`,
    /// `agent:sub:<id>`, `agent:daemon:<name>`). Values are the
    /// capability strings that caller may invoke.
    #[serde(default)]
    pub initiators: HashMap<String, Vec<String>>,
    /// Fallback grant set applied to any `agent:sub:*` /
    /// `agent:daemon:*` / `agent:scheduler` initiator NOT listed in
    /// `initiators`. `agent:main` never consults this.
    #[serde(default = "default_sub_agent_caps")]
    pub default_for_sub_agents: Vec<String>,
}

impl Default for GrantsFile {
    fn default() -> Self {
        Self {
            initiators: default_initiator_map(),
            default_for_sub_agents: default_sub_agent_caps(),
        }
    }
}

/// Default allowlist baked into a freshly-written `grants.json`.
/// Mirrors the taxonomy declared on every migrated tool in
/// `agent_loop::tools::*`.
fn default_initiator_map() -> HashMap<String, Vec<String>> {
    let mut m = HashMap::new();
    // Scheduler-fired runs: read-only view of the user's world, plus
    // the memory tier scheduler templates already exercise.
    m.insert(
        "agent:scheduler".to_string(),
        vec![
            "network.read".to_string(),
            "web:fetch".to_string(),
            "memory.read".to_string(),
        ],
    );
    // Ambient watcher: notice, don't act. No network, no app launch.
    m.insert(
        "agent:daemon:ambient".to_string(),
        vec!["memory.read".to_string()],
    );
    m
}

fn default_sub_agent_caps() -> Vec<String> {
    vec![
        "network.read".to_string(),
        "web:fetch".to_string(),
        "memory.read".to_string(),
    ]
}

// ---------------------------------------------------------------------------
// Cache + reload
// ---------------------------------------------------------------------------

struct CachedGrants {
    file: GrantsFile,
    /// Path's mtime the last time we parsed it. `None` means the file
    /// didn't exist when we cached (so we're holding defaults and
    /// should reload the moment the file appears).
    mtime: Option<SystemTime>,
}

static CACHE: Lazy<RwLock<Option<CachedGrants>>> = Lazy::new(|| RwLock::new(None));

/// Per-(initiator, tool, cap) denial ledger — dedups the console WARN
/// so a hot scheduler loop doesn't spam. The JSONL denial log is NOT
/// deduped; every call appends a fresh row for audit integrity.
static DENIAL_WARNED: Lazy<Mutex<HashSet<(String, String, String)>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "grants.json";
const DENIAL_LOG: &str = "capability_denials.log";
const DENIAL_LOG_OLD: &str = "capability_denials.log.old";
/// Rotate the denial log once it exceeds this size. 4 MiB is enough for
/// tens of thousands of rows; rotation keeps tail_denials RAM-bounded.
const MAX_DENIAL_LOG_BYTES: u64 = 4 * 1024 * 1024;

fn grants_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    Ok(home.join(DIR_NAME).join(FILE_NAME))
}

fn denial_log_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    Ok(home.join(DIR_NAME).join(DENIAL_LOG))
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

fn read_file(path: &Path) -> Result<GrantsFile, String> {
    // Verify file mode and ownership before trusting the contents. A world-
    // writable or foreign-owned grants.json could silently escalate caps.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path).map_err(|e| format!("stat grants.json: {e}"))?;
        let mode = meta.mode() & 0o777;
        // Accept 0o600 (owner-only) or 0o644 (owner-write, world-read — common on macOS).
        if mode != 0o600 && mode != 0o644 {
            let msg = format!(
                "[capability] grants.json has unsafe mode {:o} (expected 600 or 644);                  falling back to compiled-in defaults",
                mode
            );
            log::warn!("{msg}");
            record_denial_raw("grants.json", "read", "unsafe file mode");
            return Err(msg);
        }
        // Verify the file is owned by the current process UID.
        let file_uid = meta.uid();
        let proc_uid = unsafe { libc::getuid() };
        if file_uid != proc_uid {
            let msg = format!(
                "[capability] grants.json owned by uid {} but process uid is {};                  falling back to compiled-in defaults",
                file_uid, proc_uid
            );
            log::warn!("{msg}");
            record_denial_raw("grants.json", "read", "foreign file ownership");
            return Err(msg);
        }
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read grants.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse grants.json: {e}"))
}

fn write_file(path: &Path, file: &GrantsFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(file).map_err(|e| format!("encode grants: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn mtime_of(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Load or refresh the cached grants file.
///
/// Reload policy:
///   * If the file doesn't exist → write defaults, cache defaults.
///   * If the file's mtime changed since the cached copy → re-read.
///   * Parse errors → keep the previous cache, log once per session so
///     the user sees the drift without losing the working policy.
fn load_cached() -> GrantsFile {
    let Ok(path) = grants_path() else {
        return GrantsFile::default();
    };

    // Fast-path: check if the cached copy is still fresh.
    {
        if let Ok(guard) = CACHE.read() {
            if let Some(cached) = guard.as_ref() {
                let disk_mtime = mtime_of(&path);
                if disk_mtime == cached.mtime {
                    return cached.file.clone();
                }
            }
        }
    }

    // Slow path: (re)parse.
    let (file, mtime) = if path.exists() {
        match read_file(&path) {
            Ok(f) => (f, mtime_of(&path)),
            Err(e) => {
                log::warn!("[capability] grants.json parse failed ({e}); keeping previous policy");
                // If we had a previous cache, return it; otherwise fall
                // back to hard defaults.
                if let Ok(guard) = CACHE.read() {
                    if let Some(cached) = guard.as_ref() {
                        return cached.file.clone();
                    }
                }
                (GrantsFile::default(), None)
            }
        }
    } else {
        // First launch — write defaults so the user has a file to edit.
        let defaults = GrantsFile::default();
        if let Err(e) = write_file(&path, &defaults) {
            log::warn!("[capability] grants.json write failed ({e}); in-memory defaults only");
        }
        (defaults, mtime_of(&path))
    };

    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(CachedGrants {
            file: file.clone(),
            mtime,
        });
    }
    file
}

// ---------------------------------------------------------------------------
// Public API — queried by `tool_trait::initiator_grants`
// ---------------------------------------------------------------------------

/// Resolve the capability grant set for an initiator.
///
/// Returns `None` to mean "unscoped — full-access default". Concretely:
///   * `agent:main` → `None` UNLESS the user explicitly set it in
///     `grants.json` (primary user path stays frictionless).
///   * Any explicit entry in `initiators` → `Some(<that list>)`.
///   * Any other `agent:sub:*` / `agent:scheduler` / `agent:daemon:*`
///     → `Some(default_for_sub_agents)`.
///   * Anything else (shouldn't happen — dispatcher only emits the
///     above) → `None` to fail open rather than lock out the user.
pub fn grants_for(initiator: &str) -> Option<Vec<String>> {
    let file = load_cached();

    if let Some(explicit) = file.initiators.get(initiator) {
        return Some(explicit.clone());
    }

    if initiator == "agent:main" {
        // Main agent explicitly uses the full-access default unless
        // overridden above. Never falls through to the sub-agent
        // allowlist.
        return None;
    }

    if initiator.starts_with("agent:sub:")
        || initiator.starts_with("agent:daemon:")
        || initiator == "agent:scheduler"
    {
        return Some(file.default_for_sub_agents.clone());
    }

    // Unknown initiator shape — deny with empty grant set rather than failing
    // open. Log once per unknown initiator so it surfaces quickly.
    log::warn!(
        "[capability] unknown initiator `{initiator}` — denying all capabilities (expected          agent:main | agent:sub:* | agent:daemon:* | agent:scheduler)"
    );
    Some(vec![])
}

/// Append a structured row to `~/.sunny/capability_denials.log` and
/// emit a one-shot WARN per `(initiator, tool, cap)` triple. Called by
/// `tool_trait::check_capabilities` right before it returns `Denied`.
///
/// `missing` is the full list of caps the initiator lacked; the first
/// entry is the representative one we dedupe the WARN on.
pub fn record_denial(initiator: &str, tool: &str, missing: &[&str], reason: &str) {
    let first_cap = missing.first().copied().unwrap_or("<none>");
    let triple = (
        initiator.to_string(),
        tool.to_string(),
        first_cap.to_string(),
    );
    let fresh = {
        match DENIAL_WARNED.lock() {
            Ok(mut guard) => {
                if guard.contains(&triple) {
                    false
                } else {
                    guard.insert(triple);
                    true
                }
            }
            Err(_) => false,
        }
    };
    if fresh {
        log::warn!(
            "[capability] denied {tool} for {initiator} — missing: {}",
            missing.join(", ")
        );
    }

    // Persist every denial — the dedupe above is for the console line
    // only; the audit log is the ground truth.
    if let Err(e) = append_denial(initiator, tool, missing, reason) {
        log::warn!("[capability] denial log append failed: {e}");
    }
}

/// Lightweight denial log entry for file-integrity failures that don't
/// have the full initiator/tool/missing context.
fn record_denial_raw(subject: &str, op: &str, reason: &str) {
    let _ = append_denial(subject, op, &[], reason);
}

fn append_denial(
    initiator: &str,
    tool: &str,
    missing: &[&str],
    reason: &str,
) -> Result<(), String> {
    let path = denial_log_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    // Rotate when the log exceeds MAX_DENIAL_LOG_BYTES: rename current
    // to .old (overwriting any previous .old), then start fresh. This
    // bounds both disk use and the RAM cost of tail_denials reads.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() >= MAX_DENIAL_LOG_BYTES {
            if let Some(parent) = path.parent() {
                let old = parent.join(DENIAL_LOG_OLD);
                let _ = fs::rename(&path, &old);
                log::info!("[capability] denial log rotated (exceeded {} MiB)", MAX_DENIAL_LOG_BYTES / 1024 / 1024);
            }
        }
    }

    let at = chrono::Utc::now().to_rfc3339();
    let row = json!({
        "at": at,
        "initiator": initiator,
        "tool": tool,
        "missing": missing,
        "reason": reason,
    });
    let mut line = row.to_string();
    line.push('\n');
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open denial log: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("write denial log: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri-facing helpers (wired via commands.rs)
// ---------------------------------------------------------------------------

/// One persisted denial entry, surfaced to the Security page. Shape mirrors
/// the JSONL row written by `append_denial`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CapabilityDenialRow {
    /// RFC3339 timestamp when the denial fired.
    pub at: String,
    /// `agent:main`, `agent:sub:<id>`, `agent:daemon:<name>`, `agent:scheduler`,
    /// or — for file-integrity failures — a string like `grants.json`.
    pub initiator: String,
    /// Tool name the caller tried to invoke, or `read`/`write` for
    /// file-integrity failures.
    pub tool: String,
    /// Capabilities the caller lacked. Empty for file-integrity rows.
    pub missing: Vec<String>,
    /// Human-readable reason (may be empty for the older rows).
    pub reason: String,
}

/// Read the tail of the denial audit log. Returns the most recent `limit`
/// rows, oldest-first. Silently returns an empty vec if the log doesn't
/// exist yet (no denials recorded this install).
pub fn tail_denials(limit: usize) -> Vec<CapabilityDenialRow> {
    let Ok(path) = denial_log_path() else {
        return Vec::new();
    };
    // Guard: refuse to slurp a file that somehow escaped rotation (e.g.
    // rotation failed on a previous write). Returning empty is safe —
    // the UI will show "no rows" rather than OOM-ing the process.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_DENIAL_LOG_BYTES * 2 {
            log::warn!(
                "[capability] denial log unexpectedly large ({} bytes) — skipping read",
                meta.len()
            );
            return Vec::new();
        }
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<CapabilityDenialRow> = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|v| CapabilityDenialRow {
            at: v.get("at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            initiator: v.get("initiator").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            tool: v.get("tool").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            missing: v
                .get("missing")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| e.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            reason: v.get("reason").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        })
        .collect();
    // Tail: keep only the last `limit` rows, preserving chronological order.
    if rows.len() > limit {
        let drop = rows.len() - limit;
        rows.drain(..drop);
    }
    rows
}

/// Snapshot of the persisted grants file — returned to the Settings UI
/// so it can render the current policy.
pub fn list_grants() -> Result<GrantsFile, String> {
    Ok(load_cached())
}

/// Persist a new policy. Invalidates the cache so the next query re-reads.
pub fn update_grants(new_file: GrantsFile) -> Result<(), String> {
    let path = grants_path()?;
    write_file(&path, &new_file)?;
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(CachedGrants {
            file: new_file,
            mtime: mtime_of(&path),
        });
    }
    // Clear the per-triple dedup ledger — policy changed, previous
    // denials are stale.
    if let Ok(mut w) = DENIAL_WARNED.lock() {
        w.clear();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn __reset_cache_for_tests() {
    if let Ok(mut guard) = CACHE.write() {
        *guard = None;
    }
    if let Ok(mut guard) = DENIAL_WARNED.lock() {
        guard.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // `grants.json` lives under $HOME; tests temporarily redirect HOME
    // to a tempdir so they don't stomp on the dev machine's real file.
    // HOME is process-wide env, so tests must serialise.
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    fn with_temp_home<F: FnOnce(&Path)>(f: F) {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "sunny-capability-tests-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::create_dir_all(&tmp);
        let saved = std::env::var_os("HOME");
        std::env::set_var("HOME", &tmp);
        __reset_cache_for_tests();

        f(&tmp);

        if let Some(v) = saved {
            std::env::set_var("HOME", v);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&tmp);
        __reset_cache_for_tests();
    }

    #[test]
    fn missing_grants_file_writes_defaults() {
        with_temp_home(|home| {
            let path = home.join(".sunny").join("grants.json");
            assert!(!path.exists(), "precondition: no file yet");

            // First call should write the default file and return the
            // scheduler allowlist from it.
            let scheduler = grants_for("agent:scheduler").expect("scheduler has explicit caps");
            assert!(scheduler.contains(&"memory.read".to_string()));
            assert!(path.exists(), "grants.json should have been created");

            // File round-trips as valid JSON with the expected shape.
            let raw = fs::read_to_string(&path).unwrap();
            let parsed: GrantsFile = serde_json::from_str(&raw).expect("default file parses");
            assert!(parsed.initiators.contains_key("agent:scheduler"));
        });
    }

    #[test]
    fn main_agent_bypasses_grant_check() {
        with_temp_home(|_| {
            // agent:main returns None → `check_capabilities` treats that
            // as full-access default.
            let caps = grants_for("agent:main");
            assert!(
                caps.is_none(),
                "main agent should be unscoped by default, got {caps:?}"
            );
        });
    }

    #[test]
    fn main_agent_honors_explicit_scope_if_user_sets_it() {
        with_temp_home(|_| {
            // User explicitly scopes the main agent — our policy must
            // honour that rather than silently defaulting to None.
            let mut file = GrantsFile::default();
            file.initiators.insert(
                "agent:main".to_string(),
                vec!["memory.read".to_string()],
            );
            update_grants(file).expect("update ok");

            let caps = grants_for("agent:main").expect("explicit scope returned");
            assert_eq!(caps, vec!["memory.read".to_string()]);
        });
    }

    #[test]
    fn sub_agent_restricted_to_default_when_unconfigured() {
        with_temp_home(|_| {
            let caps = grants_for("agent:sub:research-bot")
                .expect("sub-agent falls back to default list");
            // Default set gives read-flavoured capabilities but NOT
            // dangerous ones like app:launch / browser:open.
            assert!(caps.contains(&"memory.read".to_string()));
            assert!(!caps.contains(&"app:launch".to_string()));
            assert!(!caps.contains(&"browser:open".to_string()));
        });
    }

    #[test]
    fn grant_update_via_command_persists_and_reloads() {
        with_temp_home(|home| {
            // Seed + then update.
            let _ = grants_for("agent:scheduler"); // materialise file
            let mut file = load_cached();
            file.initiators.insert(
                "agent:sub:research-bot".to_string(),
                vec!["web:fetch".to_string(), "memory.read".to_string()],
            );
            update_grants(file).expect("update ok");

            // Cache should reflect the new entry immediately.
            let caps = grants_for("agent:sub:research-bot").expect("explicit entry hit");
            assert_eq!(caps.len(), 2);
            assert!(caps.contains(&"web:fetch".to_string()));

            // File on disk matches.
            let path = home.join(".sunny").join("grants.json");
            let parsed: GrantsFile =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(
                parsed
                    .initiators
                    .get("agent:sub:research-bot")
                    .unwrap()
                    .contains(&"web:fetch".to_string())
            );
        });
    }

    #[test]
    fn record_denial_appends_jsonl_row() {
        with_temp_home(|home| {
            record_denial(
                "agent:sub:research-bot",
                "app_launch",
                &["app:launch"],
                "initiator lacks app:launch",
            );
            let log = home.join(".sunny").join("capability_denials.log");
            assert!(log.exists(), "denial log should have been created");
            let body = fs::read_to_string(&log).unwrap();
            assert!(body.contains("\"tool\":\"app_launch\""));
            assert!(body.contains("\"initiator\":\"agent:sub:research-bot\""));
            assert!(body.ends_with('\n'), "JSONL rows must end with \\n");
        });
    }

    #[test]
    fn tail_denials_round_trips_written_rows() {
        with_temp_home(|_| {
            // Fresh home → no log yet → empty tail, never panics.
            assert!(tail_denials(50).is_empty());

            // Write two denials and confirm both surface in tail.
            record_denial(
                "agent:sub:alpha",
                "browser_open",
                &["browser:open"],
                "initiator lacks browser:open",
            );
            record_denial(
                "agent:daemon:ambient",
                "web_fetch",
                &["web:fetch"],
                "daemon scope omits web:fetch",
            );

            let rows = tail_denials(50);
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].initiator, "agent:sub:alpha");
            assert_eq!(rows[0].tool, "browser_open");
            assert_eq!(rows[0].missing, vec!["browser:open".to_string()]);
            assert_eq!(rows[1].initiator, "agent:daemon:ambient");
            // Limit clamps to the most recent rows, chronological order preserved.
            let rows = tail_denials(1);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].tool, "web_fetch");
        });
    }
}
