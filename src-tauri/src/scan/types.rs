//! Shared types for the SUNNY virus scanner.
//!
//! Wire-compatible with the TypeScript frontend — every struct here derives
//! `Serialize` and uses `#[serde(rename_all = "camelCase")]` so the JSON looks
//! natural on the JS side.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/// Final classification for a scanned file.
///
/// Ordered roughly by severity so the UI can derive a badge color from a
/// single field. `Unknown` is a scan that didn't finish (IO error, aborted).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Verdict {
    Clean,
    Info,
    Suspicious,
    Malicious,
    Unknown,
}

impl Verdict {
    /// Choose the worse of two verdicts. Used when combining signals
    /// (e.g. MalwareBazaar says clean, heuristics flag suspicious → suspicious).
    pub fn max(self, other: Verdict) -> Verdict {
        let rank = |v: Verdict| match v {
            Verdict::Clean => 0,
            Verdict::Info => 1,
            Verdict::Unknown => 2,
            Verdict::Suspicious => 3,
            Verdict::Malicious => 4,
        };
        if rank(self) >= rank(other) { self } else { other }
    }
}

// ---------------------------------------------------------------------------
// Signals — individual pieces of evidence contributing to a verdict
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SignalKind {
    /// MalwareBazaar hit — the file's SHA-256 is a known-bad sample.
    MalwareBazaarHit,
    /// VirusTotal hit — 1+ engines detected the file.
    VirustotalHit,
    /// File has the macOS `com.apple.quarantine` xattr — downloaded from the
    /// internet. Informational on its own; escalates combined with unsigned.
    Quarantined,
    /// `codesign --verify --deep` failed or binary is unsigned.
    Unsigned,
    /// Lives in a high-risk location (Downloads, /tmp, Desktop).
    RiskyPath,
    /// Modified within the last 24h — freshly arrived on the machine.
    RecentlyModified,
    /// Mach-O / ELF / PE magic bytes detected — it's an executable.
    Executable,
    /// Script with a shebang pointing outside standard bins.
    UnusualScript,
    /// File size is anomalous for its extension (tiny .app, huge .txt, etc).
    SizeAnomaly,
    /// Hidden dotfile in a user-facing directory.
    HiddenInUserDir,
    /// Filename / path / content matched a curated 2024-2026 malware-family
    /// IoC pattern (AMOS, Banshee, XCSSET, NotLockBit, …).
    KnownMalwareFamily,
    /// Content matched a known prompt-injection / LLM-jailbreak pattern
    /// (OWASP LLM01, DAN / STAN / AIM, tool-call exfil, invisible-unicode
    /// tag smuggling, etc.).
    PromptInjection,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Signal {
    pub kind: SignalKind,
    /// Plain-English reason shown in the UI.
    pub detail: String,
    /// This signal's individual contribution to the verdict.
    pub weight: Verdict,
}

// ---------------------------------------------------------------------------
// Finding — one inspected file
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Finding {
    /// Stable id (uuid) — used as ref in the UI and for quarantine ops.
    pub id: String,
    /// Canonical absolute path.
    pub path: String,
    /// File size in bytes (None if we never got that far).
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    /// SHA-256 hex (None if not hashed — unreadable, aborted, etc).
    pub sha256: Option<String>,
    /// Combined verdict across all signals.
    pub verdict: Verdict,
    /// Every signal that fired for this file. Possibly empty for clean files.
    pub signals: Vec<Signal>,
    /// Human-readable summary — the first line the UI shows.
    pub summary: String,
    /// UNIX seconds when we inspected it.
    #[ts(type = "number")]
    pub inspected_at: i64,
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanOptions {
    /// If true, descend into subdirectories. If false, only direct children.
    pub recursive: bool,
    /// Skip files larger than this many bytes. Defaults to 100 MB.
    #[ts(type = "number | null")]
    pub max_file_size: Option<u64>,
    /// Also consult the MalwareBazaar hash database. Defaults to true —
    /// turning it off yields a pure local/heuristic scan.
    pub online_lookup: bool,
    /// Also probe VirusTotal if an API key is available. Defaults to false
    /// (no key bundled; user must provide one via the vault).
    pub virustotal: bool,
    /// Only hash + network-check files that match one of these heuristics.
    /// If None, every file is hashed (slower but thorough).
    pub deep: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            max_file_size: Some(100 * 1024 * 1024),
            online_lookup: true,
            virustotal: false,
            deep: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ScanPhase {
    Queued,
    Walking,
    Hashing,
    Analyzing,
    Done,
    Aborted,
    Errored,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanProgress {
    pub scan_id: String,
    pub phase: ScanPhase,
    /// Total file count the walker has discovered so far.
    pub files_discovered: usize,
    /// Files fully inspected (post heuristics + optional online lookup).
    pub files_inspected: usize,
    /// Files we've skipped (too large, unreadable, ignored path).
    pub files_skipped: usize,
    /// Per-verdict tally — updates as findings are added.
    pub clean: usize,
    pub info: usize,
    pub suspicious: usize,
    pub malicious: usize,
    /// Absolute file currently being analyzed (for the live status line).
    pub current_path: Option<String>,
    /// Surface a non-fatal error to the UI without aborting.
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub finished_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// Scan record — one past or ongoing scan
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanRecord {
    pub scan_id: String,
    pub target: String,
    pub options: ScanOptions,
    pub progress: ScanProgress,
    /// Findings worth surfacing — clean files are elided unless
    /// `keep_clean` is set on the scan (future feature).
    pub findings: Vec<Finding>,
}

// ---------------------------------------------------------------------------
// Vault item — a file we've quarantined
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultItem {
    pub id: String,
    /// Path the file had before we moved it — used by "restore".
    pub original_path: String,
    /// Location inside `~/.sunny/scan_vault/` (not shown to the user).
    pub vault_path: String,
    #[ts(type = "number")]
    pub size: u64,
    pub sha256: String,
    pub verdict: Verdict,
    /// Why we quarantined this — copied from the Finding.
    pub reason: String,
    /// Optional list of signal kinds (serialized as strings for portability).
    pub signals: Vec<SignalKind>,
    #[ts(type = "number")]
    pub quarantined_at: i64,
}
