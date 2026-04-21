//! SUNNY constitution — declarative identity, values, and hard prohibitions.
//!
//! Before this module, the agent's identity was scattered across string
//! literals in multiple files (system prompts, reflection guards, the
//! openclaw fallback message). Hard prohibitions were either absent or
//! expressed as ad-hoc `if tool == "rm" …` conditionals in the
//! safety-paths module.
//!
//! The constitution centralizes both into a single user-editable JSON
//! file at `~/.sunny/constitution.json`. On first launch we write a
//! sensible default (identity = British male assistant, values = concise
//! answers + confirm destructive actions, prohibitions = nothing by
//! default so the user can opt in). Subsequent launches read the file
//! verbatim, so the user can tune their agent's personality without
//! rebuilding.
//!
//! ### Data shape
//!
//! ```json
//! {
//!   "identity": {
//!     "name": "SUNNY",
//!     "voice": "British male, calm, dry wit",
//!     "operator": "Sunny"
//!   },
//!   "values": [
//!     "Prefer concise over verbose",
//!     "Ask before destructive action",
//!     "Never share user secrets with cloud providers"
//!   ],
//!   "prohibitions": [
//!     {
//!       "description": "Never message contacts after 10 PM without explicit ok",
//!       "tools": ["messaging_send_imessage", "messaging_send_sms"],
//!       "after_local_hour": 22
//!     },
//!     {
//!       "description": "Refuse any rm -rf on /",
//!       "tools": ["run_shell"],
//!       "match_input_contains": ["rm -rf /", "rm -rf /*"]
//!     }
//!   ]
//! }
//! ```
//!
//! ### Policy check
//!
//! `check_tool(tool, input_json)` returns:
//!   • `Allow` — proceed normally
//!   • `Block(reason)` — the constitution absolutely refuses; the agent
//!     loop aborts the tool call and surfaces a `constitution_block`
//!     insight to the user. Distinct from ConfirmGate: ConfirmGate asks
//!     the user; a constitution block never asks — the user already said
//!     no at configuration time.
//!
//! All checks are pure functions — no filesystem reads, no locks. The
//! loader pulls a single snapshot into a `RwLock<Arc<Constitution>>` on
//! boot; updates go through `save(new)` which atomically writes the file
//! and swaps the Arc. Readers pay one `read().clone()` per check,
//! essentially free.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Diagnostics — rule-kick counters
// ---------------------------------------------------------------------------
//
// Each time `check_tool*` returns `Block(..)`, we bump a process-wide
// counter keyed by the rule's description. The Diagnostics page
// surfaces this so operators can see which prohibitions fire hot.

fn kick_map() -> &'static Mutex<HashMap<String, AtomicU64>> {
    static MAP: OnceLock<Mutex<HashMap<String, AtomicU64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bump_kick(rule_description: &str) {
    if let Ok(mut map) = kick_map().lock() {
        map.entry(rule_description.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }
}

/// Read-only snapshot of rule-kick counts, sorted descending. Used by
/// the Diagnostics page.
pub fn rule_kicks_snapshot() -> Vec<(String, u64)> {
    let Ok(map) = kick_map().lock() else {
        return Vec::new();
    };
    let mut out: Vec<(String, u64)> = map
        .iter()
        .map(|(k, v)| (k.clone(), v.load(Ordering::Relaxed)))
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

// ---------------------------------------------------------------------------
// Verifier last-result (sprint-13 ε)
// ---------------------------------------------------------------------------
//
// The TS `verifyAnswer` path (see src/lib/constitution.ts) runs after
// every agent turn and voice reply. Each run surfaces a single result —
// pass or fail, plus the first-failed rule if any — that the Diagnostics
// page now shows. We keep the last result in three atomics rather than
// a `Mutex<Option<...>>` so the read path stays lock-free on every 2 s
// poll; the failed-rule string is behind a RwLock<Option<String>>
// because no AtomicCell<String> exists in std.

/// Wall-clock milliseconds at which the most recent verifyAnswer ran.
/// Zero means "no verify has been recorded this process". Stored in a
/// u64 (as i64 reinterpret) to match every other time atomic in the
/// codebase; conversion is a single `as i64` at read time.
static LAST_VERIFY_AT_MS: AtomicU64 = AtomicU64::new(0);

/// Outcome of the most recent verify. `0 = fail`, `1 = pass`. A u8
/// would be enough but the codebase uses u64 atomics uniformly; the
/// cost is identical.
static LAST_VERIFY_PASSED: AtomicU64 = AtomicU64::new(0);

/// First failed rule description from the most recent verify. `None`
/// means either verify never ran OR verify passed. This field is
/// semantically tied to `LAST_VERIFY_PASSED == 0`; we rely on the
/// caller setting them together in `record_verify_result` rather than
/// burning an extra atomic to lock the pair.
fn verify_fail_rule_cell() -> &'static RwLock<Option<String>> {
    static CELL: OnceLock<RwLock<Option<String>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(None))
}

/// Record a verifyAnswer outcome. Called from the TS verifyAnswer path
/// via the `constitution_record_verify` Tauri command. `first_failed`
/// is the rule description (e.g. "max_words:150") of the first
/// violation found; pass `None` when the answer verified cleanly.
///
/// Distinct from `bump_kick` above: kicks are CONSTITUTION.check_tool
/// blocks (user said "never"), verify is a post-hoc content audit on
/// the model's reply. Both surface on the Diagnostics page in separate
/// tiles; there's no overlap in accounting.
pub fn record_verify_result(at_ms: i64, passed: bool, first_failed: Option<String>) {
    LAST_VERIFY_AT_MS.store(at_ms.max(0) as u64, Ordering::Relaxed);
    LAST_VERIFY_PASSED.store(if passed { 1 } else { 0 }, Ordering::Relaxed);
    if let Ok(mut guard) = verify_fail_rule_cell().write() {
        // When passed=true we clear the stale failure so a healthy run
        // erases the prior red state on the Diagnostics page, matching
        // operator intuition ("most recent reply verified cleanly").
        *guard = if passed { None } else { first_failed };
    }
}

/// Snapshot of the most recent verify result: `(at_ms, passed, first_failed_rule)`.
/// Returns `None` when no verify has been recorded this process —
/// distinct from "passed with no failures" which returns
/// `Some((at_ms, true, None))`.
pub fn last_verify_result() -> Option<(i64, bool, Option<String>)> {
    let at = LAST_VERIFY_AT_MS.load(Ordering::Relaxed);
    if at == 0 {
        return None;
    }
    let passed = LAST_VERIFY_PASSED.load(Ordering::Relaxed) != 0;
    let rule = verify_fail_rule_cell()
        .read()
        .ok()
        .and_then(|g| g.clone());
    Some((at as i64, passed, rule))
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct Constitution {
    #[serde(default)]
    #[ts(type = "number")]
    pub schema_version: u32,
    #[serde(default)]
    pub identity: Identity,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub prohibitions: Vec<Prohibition>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct Identity {
    #[serde(default = "default_name")]
    pub name: String,
    #[serde(default = "default_voice")]
    pub voice: String,
    #[serde(default = "default_operator")]
    pub operator: String,
}

/// Serde `#[serde(default = "…")]` runs during deserialization only — a
/// plain `Identity::default()` call would leave every field empty without
/// this manual impl, which would defeat the "give every user a sensible
/// identity on first boot" goal.
impl Default for Identity {
    fn default() -> Self {
        Identity {
            name: default_name(),
            voice: default_voice(),
            operator: default_operator(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct Prohibition {
    pub description: String,
    /// Tool names this prohibition applies to. Empty means "all tools".
    #[serde(default)]
    pub tools: Vec<String>,
    /// If set, only block when the local hour is >= this value (24-hour).
    /// Useful for "no messages after 10 PM" style rules.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub after_local_hour: Option<u8>,
    /// If set, only block when the local hour is < this value. Combined
    /// with `after_local_hour` this expresses "between 10 PM and 7 AM".
    #[serde(default)]
    #[ts(type = "number | null")]
    pub before_local_hour: Option<u8>,
    /// Block when any of these substrings appears in the tool's input
    /// JSON (case-sensitive). Used for fast keyword bans; more complex
    /// patterns should be handled by the critic.
    #[serde(default)]
    pub match_input_contains: Vec<String>,
}

fn default_name() -> String {
    "SUNNY".to_string()
}
fn default_voice() -> String {
    "British male, calm, dry wit when appropriate".to_string()
}
fn default_operator() -> String {
    "Sunny".to_string()
}

impl Default for Constitution {
    fn default() -> Self {
        Constitution {
            schema_version: SCHEMA_VERSION,
            identity: Identity::default(),
            values: default_values(),
            prohibitions: Vec::new(),
        }
    }
}

fn default_values() -> Vec<String> {
    // Sprint-6: the first four entries are machine-readable keys the
    // runtime verifier understands (see `verifier.rs`). They fire
    // automatically on fresh installs so out-of-box users actually get
    // enforcement rather than prose the verifier silently ignores. The
    // trailing entries are human-readable hints the model reads as prompt
    // context — the verifier no-ops them, but they steer voice & tone.
    vec![
        // Machine-readable (verifier enforces):
        "max_words:150".to_string(),
        "no_markdown_in_voice:voice".to_string(),
        "confirm_destructive_ran".to_string(),
        "no_emoji".to_string(),
        // Human-readable (model-facing prompt context):
        "Be concise. Warm British sentences. Dry wit welcome.".to_string(),
        "Prefer tools over guessing for anything current or personal.".to_string(),
        "Trust the user over learned facts when they conflict.".to_string(),
    ]
}

/// Heuristic: does this value entry look like a machine-readable verifier
/// key (e.g. `max_words:150`, `no_emoji`) rather than a freeform prose
/// hint? Mirrors the rule surface recognised by the TS `verifier.ts`
/// parser. Test-only today — used by Rust-side assertions that the
/// defaults will trigger enforcement without a TS runtime.
#[cfg(test)]
pub fn is_machine_readable_value(v: &str) -> bool {
    let trimmed = v.trim();
    // No whitespace inside — verifier rules are single tokens (with an
    // optional `:arg` suffix). Prose hints always contain spaces.
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return false;
    }
    let key = trimmed.split(':').next().unwrap_or("");
    matches!(
        key,
        "max_words"
            | "max_sentences"
            | "no_emoji"
            | "no_markdown_in_voice"
            | "require_british_english"
            | "confirm_destructive_ran"
    )
}

// ---------------------------------------------------------------------------
// Policy check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Block(String),
}

impl Constitution {
    /// Evaluate a tool call against every prohibition. Returns the first
    /// matching `Block` (with the rule's description as the reason) or
    /// `Allow` if no prohibition fires.
    pub fn check_tool(&self, tool: &str, input_json: &str) -> Decision {
        self.check_tool_at(tool, input_json, local_hour_now())
    }

    /// Test hook — injects the "current hour" so hour-gated rules can be
    /// verified deterministically.
    pub fn check_tool_at(&self, tool: &str, input_json: &str, local_hour: u8) -> Decision {
        for p in &self.prohibitions {
            if !applies_to_tool(p, tool) {
                continue;
            }
            if !matches_hour_window(p, local_hour) {
                continue;
            }
            if !matches_input(p, input_json) {
                continue;
            }
            bump_kick(&p.description);
            return Decision::Block(p.description.clone());
        }
        Decision::Allow
    }
}

fn applies_to_tool(p: &Prohibition, tool: &str) -> bool {
    if p.tools.is_empty() {
        return true;
    }
    p.tools.iter().any(|t| t == tool)
}

fn matches_hour_window(p: &Prohibition, hour: u8) -> bool {
    match (p.after_local_hour, p.before_local_hour) {
        (None, None) => true,
        (Some(after), None) => hour >= after,
        (None, Some(before)) => hour < before,
        (Some(after), Some(before)) => {
            if after <= before {
                // Same-day window e.g. [9, 17) — active between 9 and 17.
                hour >= after && hour < before
            } else {
                // Wraps midnight — e.g. [22, 7) — active 22..=23 or 0..7.
                hour >= after || hour < before
            }
        }
    }
}

fn matches_input(p: &Prohibition, input_json: &str) -> bool {
    if p.match_input_contains.is_empty() {
        return true;
    }
    p.match_input_contains
        .iter()
        .any(|needle| input_json.contains(needle))
}

fn local_hour_now() -> u8 {
    use chrono::Timelike;
    chrono::Local::now().hour() as u8
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SCHEMA_VERSION: u32 = 1;
const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "constitution.json";

fn cell() -> &'static RwLock<Arc<Constitution>> {
    static CELL: OnceLock<RwLock<Arc<Constitution>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(Arc::new(Constitution::default())))
}

/// Current in-memory snapshot. Cheap — returns a clone of the Arc.
pub fn current() -> Arc<Constitution> {
    let guard = cell().read().unwrap_or_else(|p| p.into_inner());
    guard.clone()
}

/// Initialize the constitution: load `~/.sunny/constitution.json` if
/// present, otherwise write defaults and use those. Call once from
/// `tauri::Builder::setup`.
pub fn init_default() -> Result<(), String> {
    let path = constitution_path()?;
    if path.exists() {
        match load_from(&path) {
            Ok(c) => {
                set(c);
                return Ok(());
            }
            Err(e) => {
                // Malformed file — don't crash; log and fall through to
                // defaults so the user's assistant still boots.
                log::warn!("constitution parse failed ({e}); using defaults");
            }
        }
    }
    // First launch (or bad file): write the default so the user can edit it.
    let default = Constitution::default();
    if let Err(e) = save_to(&path, &default) {
        log::warn!("constitution write failed ({e}); in-memory default only");
    }
    set(default);
    Ok(())
}

fn set(c: Constitution) {
    if let Ok(mut w) = cell().write() {
        *w = Arc::new(c);
    }
}

fn constitution_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    Ok(home.join(DIR_NAME).join(FILE_NAME))
}

fn load_from(path: &std::path::Path) -> Result<Constitution, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    let c: Constitution = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;
    Ok(c)
}

fn save_to(path: &std::path::Path, c: &Constitution) -> Result<(), String> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(c).map_err(|e| format!("encode: {e}"))?;
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

// ---------------------------------------------------------------------------
// Tauri command surface
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn constitution_get() -> Constitution {
    (*current()).clone()
}

#[tauri::command]
pub fn constitution_save(value: Constitution) -> Result<(), String> {
    let path = constitution_path()?;
    save_to(&path, &value)?;
    set(value);
    Ok(())
}

#[tauri::command]
pub fn constitution_check(tool: String, input: serde_json::Value) -> CheckResult {
    let c = current();
    let input_s = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
    match c.check_tool(&tool, &input_s) {
        Decision::Allow => CheckResult {
            allowed: true,
            reason: None,
        },
        Decision::Block(reason) => CheckResult {
            allowed: false,
            reason: Some(reason),
        },
    }
}

#[derive(Serialize)]
pub struct CheckResult {
    pub allowed: bool,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Kick log (voice-path verifyAnswer surface)
//
// The TS `constitutionKicks.ts` module runs `verifyAnswer` on every voice
// reply and appends a JSONL row here for each violation detected. This
// Rust-side command is deliberately dumb — it takes an already-formed
// `serde_json::Value`, validates nothing beyond "is an object", and writes
// it to `~/.sunny/constitution_kicks.log`. The authoritative rule surface
// lives in TypeScript (see constitution.ts); this command just persists
// the audit trail so a future `tail -f` or Diagnostics page can surface it.
//
// Failure mode: the command returns `Ok(())` on filesystem failure and
// logs a warning. We never want a bad SSD or a full disk to propagate a
// kick-log error back into the voice pipeline and short-circuit a reply.
// ---------------------------------------------------------------------------

const KICKS_FILE_NAME: &str = "constitution_kicks.log";

fn kicks_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    Ok(home.join(DIR_NAME).join(KICKS_FILE_NAME))
}

/// In-process counter. The on-disk log is the authoritative record, but
/// counting lines on every `constitution_kicks_count` call would be wasted
/// I/O — the Diagnostics page asks for the count every time it renders.
/// We initialise from the file on first read (lazy) so cross-session
/// counts survive a restart without forcing a boot-time file scan.
fn kick_counter_cell() -> &'static RwLock<Option<u64>> {
    static KICK_COUNTER: OnceLock<RwLock<Option<u64>>> = OnceLock::new();
    KICK_COUNTER.get_or_init(|| RwLock::new(None))
}

fn count_existing_lines(path: &std::path::Path) -> u64 {
    match fs::read_to_string(path) {
        Ok(body) => body.lines().filter(|l| !l.trim().is_empty()).count() as u64,
        Err(_) => 0,
    }
}

/// Maximum serialized byte size for a single kick row. Rows exceeding this
/// limit are rejected to prevent a runaway caller from filling the disk.
const KICK_ROW_MAX_BYTES: usize = 8 * 1024; // 8 KiB

#[tauri::command]
pub fn constitution_kick_append(row: serde_json::Value) -> Result<(), String> {
    use std::io::Write;

    let path = match kicks_path() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("constitution_kick_append: kicks_path failed: {e}");
            return Ok(());
        }
    };

    // Ensure the parent dir exists. If mkdir fails (read-only FS, etc.),
    // swallow the error — the session counter still bumps in TS.
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log::warn!("constitution_kick_append: mkdir failed: {e}");
            return Ok(());
        }
    }

    let line = match serde_json::to_string(&row) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("constitution_kick_append: serialise failed: {e}");
            return Ok(());
        }
    };

    // Enforce size cap — reject oversized rows before touching the filesystem.
    if line.len() > KICK_ROW_MAX_BYTES {
        return Err(format!(
            "constitution_kick_append: row too large ({} bytes, max {})",
            line.len(),
            KICK_ROW_MAX_BYTES
        ));
    }

    // Append mode, create if missing. JSONL convention: one record per
    // line, terminator is LF.
    let mut file = match fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("constitution_kick_append: open failed: {e}");
            return Ok(());
        }
    };
    if let Err(e) = writeln!(file, "{line}") {
        log::warn!("constitution_kick_append: write failed: {e}");
        return Ok(());
    }

    // Bump the in-process counter. Lazy-init from the file on first touch.
    if let Ok(mut guard) = kick_counter_cell().write() {
        let cur = guard.unwrap_or_else(|| count_existing_lines(&path));
        *guard = Some(cur.saturating_add(1));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Best-effort — tighten perms so audit trail isn't world-readable.
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

#[tauri::command]
pub fn constitution_kicks_count() -> u64 {
    let path = match kicks_path() {
        Ok(p) => p,
        Err(_) => return 0,
    };
    // Read-path: if the counter is already populated, use it. Otherwise
    // lazy-init from the file.
    if let Ok(guard) = kick_counter_cell().read() {
        if let Some(n) = *guard {
            return n;
        }
    }
    let n = count_existing_lines(&path);
    if let Ok(mut guard) = kick_counter_cell().write() {
        *guard = Some(n);
    }
    n
}

/// Sibling to `constitution_kick_append`: the TS `verifyAnswer` path
/// calls this once per turn to record the outcome of the last check.
/// Distinct surface from `constitution_kick_append` because a verify
/// run produces exactly one pass/fail summary per reply whereas kicks
/// are a stream of individual rule violations.
///
/// `at_ms` defaults to "now" when absent so the TS side can skip the
/// clock read when it doesn't care to pass one. Always returns `Ok(())`
/// — this command is on the reply hot path and must never block voice.
#[tauri::command]
pub fn constitution_record_verify(
    at_ms: Option<i64>,
    passed: bool,
    first_failed: Option<String>,
) -> Result<(), String> {
    let stamp = at_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    record_verify_result(stamp, passed, first_failed);
    Ok(())
}

#[tauri::command]
pub fn constitution_kicks_recent(limit: Option<usize>) -> Vec<serde_json::Value> {
    let cap = limit.unwrap_or(50).min(500);
    let path = match kicks_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(cap);
    for line in body.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) => out.push(v),
            Err(_) => continue,
        }
        if out.len() >= cap {
            break;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn constitution_with(prohibitions: Vec<Prohibition>) -> Constitution {
        Constitution {
            schema_version: 1,
            identity: Identity::default(),
            values: vec![],
            prohibitions,
        }
    }

    #[test]
    fn allow_by_default_with_no_prohibitions() {
        let c = constitution_with(vec![]);
        let d = c.check_tool_at("run_shell", r#"{"cmd":"ls"}"#, 12);
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn tool_scope_respects_name_list() {
        let c = constitution_with(vec![Prohibition {
            description: "No shell".to_string(),
            tools: vec!["run_shell".to_string()],
            after_local_hour: None,
            before_local_hour: None,
            match_input_contains: vec![],
        }]);
        assert_ne!(c.check_tool_at("run_shell", "{}", 12), Decision::Allow);
        assert_eq!(c.check_tool_at("fs_list", "{}", 12), Decision::Allow);
    }

    #[test]
    fn empty_tools_list_means_universal() {
        let c = constitution_with(vec![Prohibition {
            description: "Blanket ban".to_string(),
            tools: vec![],
            after_local_hour: None,
            before_local_hour: None,
            match_input_contains: vec!["SECRET".to_string()],
        }]);
        assert_ne!(
            c.check_tool_at("anything", r#"{"x":"SECRET"}"#, 12),
            Decision::Allow
        );
        assert_eq!(c.check_tool_at("anything", r#"{"x":"ok"}"#, 12), Decision::Allow);
    }

    #[test]
    fn hour_window_same_day() {
        // Office hours [9, 17): block inside, allow outside.
        let c = constitution_with(vec![Prohibition {
            description: "Not in meeting hours".to_string(),
            tools: vec![],
            after_local_hour: Some(9),
            before_local_hour: Some(17),
            match_input_contains: vec![],
        }]);
        assert!(matches!(c.check_tool_at("t", "{}", 9), Decision::Block(_)));
        assert!(matches!(c.check_tool_at("t", "{}", 16), Decision::Block(_)));
        assert_eq!(c.check_tool_at("t", "{}", 17), Decision::Allow);
        assert_eq!(c.check_tool_at("t", "{}", 8), Decision::Allow);
    }

    #[test]
    fn hour_window_wraps_midnight() {
        // Late night [22, 7): block inside, allow outside.
        let c = constitution_with(vec![Prohibition {
            description: "No messages after hours".to_string(),
            tools: vec!["messaging_send_imessage".to_string()],
            after_local_hour: Some(22),
            before_local_hour: Some(7),
            match_input_contains: vec![],
        }]);
        assert!(matches!(
            c.check_tool_at("messaging_send_imessage", "{}", 23),
            Decision::Block(_)
        ));
        assert!(matches!(
            c.check_tool_at("messaging_send_imessage", "{}", 2),
            Decision::Block(_)
        ));
        assert_eq!(
            c.check_tool_at("messaging_send_imessage", "{}", 9),
            Decision::Allow
        );
        assert_eq!(
            c.check_tool_at("messaging_send_imessage", "{}", 21),
            Decision::Allow
        );
    }

    #[test]
    fn only_after_without_before_is_open_ended() {
        // "Never after 10pm" — active 22..=23 only (no wrap semantic unless
        // before is set).
        let c = constitution_with(vec![Prohibition {
            description: "No late".to_string(),
            tools: vec![],
            after_local_hour: Some(22),
            before_local_hour: None,
            match_input_contains: vec![],
        }]);
        assert!(matches!(c.check_tool_at("t", "{}", 22), Decision::Block(_)));
        assert!(matches!(c.check_tool_at("t", "{}", 23), Decision::Block(_)));
        assert_eq!(c.check_tool_at("t", "{}", 21), Decision::Allow);
    }

    #[test]
    fn input_contains_blocks_only_on_match() {
        let c = constitution_with(vec![Prohibition {
            description: "No rm -rf /".to_string(),
            tools: vec!["run_shell".to_string()],
            after_local_hour: None,
            before_local_hour: None,
            match_input_contains: vec!["rm -rf /".to_string()],
        }]);
        assert!(matches!(
            c.check_tool_at("run_shell", r#"{"cmd":"rm -rf /"}"#, 12),
            Decision::Block(_)
        ));
        assert_eq!(
            c.check_tool_at("run_shell", r#"{"cmd":"ls /tmp"}"#, 12),
            Decision::Allow
        );
    }

    #[test]
    fn first_matching_prohibition_wins_with_its_description() {
        let c = constitution_with(vec![
            Prohibition {
                description: "first".to_string(),
                tools: vec!["t".to_string()],
                after_local_hour: None,
                before_local_hour: None,
                match_input_contains: vec![],
            },
            Prohibition {
                description: "second".to_string(),
                tools: vec!["t".to_string()],
                after_local_hour: None,
                before_local_hour: None,
                match_input_contains: vec![],
            },
        ]);
        match c.check_tool_at("t", "{}", 12) {
            Decision::Block(r) => assert_eq!(r, "first"),
            Decision::Allow => panic!("expected block"),
        }
    }

    #[test]
    fn default_constitution_has_identity_and_values() {
        let c = Constitution::default();
        assert_eq!(c.schema_version, 1);
        assert_eq!(c.identity.name, "SUNNY");
        assert!(!c.values.is_empty());
        assert!(c.prohibitions.is_empty(), "defaults start permissive");
    }

    #[test]
    fn default_values_include_machine_readable_verifier_keys() {
        // Sprint-6 Agent δ: out-of-box installs must ship at least three
        // machine-readable value keys so the runtime verifier actually
        // fires on fresh `~/.sunny/constitution.json` files. Without this,
        // the verifier silently no-ops on prose and users get zero
        // enforcement.
        let c = Constitution::default();
        let machine_count = c
            .values
            .iter()
            .filter(|v| is_machine_readable_value(v))
            .count();
        assert!(
            machine_count >= 3,
            "defaults must ship >= 3 machine-readable verifier keys; got {machine_count} in {:?}",
            c.values
        );

        // The first few entries should be the machine keys (so they read
        // cleanly in the JSON file and don't get buried below prose).
        assert!(
            is_machine_readable_value(&c.values[0]),
            "first default value should be a machine-readable key, got {:?}",
            c.values[0]
        );

        // At least one prose hint must survive — the model reads these as
        // prompt context even though the verifier ignores them.
        let prose_count = c
            .values
            .iter()
            .filter(|v| !is_machine_readable_value(v))
            .count();
        assert!(
            prose_count >= 1,
            "defaults must keep at least one human-readable hint for the model"
        );
    }

    #[test]
    fn is_machine_readable_value_recognises_known_rules() {
        assert!(is_machine_readable_value("max_words:150"));
        assert!(is_machine_readable_value("max_sentences:4"));
        assert!(is_machine_readable_value("no_emoji"));
        assert!(is_machine_readable_value("no_markdown_in_voice:voice"));
        assert!(is_machine_readable_value("require_british_english"));
        assert!(is_machine_readable_value("confirm_destructive_ran"));
    }

    #[test]
    fn is_machine_readable_value_rejects_prose() {
        assert!(!is_machine_readable_value(
            "Prefer concise over verbose — say less, mean more."
        ));
        assert!(!is_machine_readable_value("Be concise. Warm British sentences."));
        assert!(!is_machine_readable_value(""));
        assert!(!is_machine_readable_value("unknown_rule:42"));
    }
}
