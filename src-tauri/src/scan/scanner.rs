//! Scanner orchestrator.
//!
//! Manages a single background tokio task per scan, drives the filesystem
//! walker, computes hashes, applies heuristics, talks to MalwareBazaar (and
//! optionally VirusTotal), and maintains a live progress snapshot the
//! frontend polls via `scan_status`.
//!
//! ### Concurrency model
//! One scan = one tokio task. Multiple scans can run in parallel (the state
//! is a `HashMap<scan_id, ScanHandle>`). Each handle owns:
//!   - A `CancellationFlag` the abort command flips.
//!   - A `Mutex<ScanRecord>` the status/findings commands clone-read.
//!
//! ### Why async
//! File IO is sync (Rust's async filesystem story is still immature), but
//! the network lookups are async — so we run the outer loop as async and
//! spawn blocking work via `tokio::task::spawn_blocking` when needed.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use super::bazaar;
use super::hash::sha256_file;
use super::heuristic;
use super::signatures;
use super::types::{
    Finding, ScanOptions, ScanPhase, ScanProgress, ScanRecord, Signal, Verdict,
};

/// How many files we inspect in parallel.
///
/// The hot work inside `inspect_file` is a mixture of small stat/read
/// syscalls, an optional `codesign` subprocess (on macOS), streaming
/// SHA-256 hashing, and an optional HTTPS roundtrip to MalwareBazaar /
/// VirusTotal. None of those saturate a single core on their own, so we
/// can comfortably fan out. 16 is a sweet spot empirically: the macOS
/// subprocess spawn throughput caps out around there before contention
/// on the proc table starts pushing latency back up, and HTTP/2 keep-alive
/// still works well for the bazaar client at this rate.
const INSPECT_CONCURRENCY: usize = 16;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

pub struct ScanHandle {
    pub record: Arc<Mutex<ScanRecord>>,
    pub cancel: Arc<AtomicBool>,
}

static REGISTRY: Mutex<Option<HashMap<String, ScanHandle>>> = Mutex::new(None);
// Retain the last 20 completed scans so the History tab has something to
// show even across restarts of the scanner state (process lifetime only).
const HISTORY_LIMIT: usize = 20;

fn registry() -> std::sync::MutexGuard<'static, Option<HashMap<String, ScanHandle>>> {
    let mut g = REGISTRY.lock().expect("scan registry poisoned");
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

// ---------------------------------------------------------------------------
// Public API (called from commands.rs)
// ---------------------------------------------------------------------------

/// Scan an explicit list of file paths rather than walking a directory.
/// Used by "running processes" and "LaunchAgents" presets where the caller
/// has already curated which files to inspect.
pub fn start_many(
    label: String,
    targets: Vec<String>,
    options: ScanOptions,
) -> Result<String, String> {
    if targets.is_empty() {
        return Err("start_many: empty targets list".into());
    }
    let scan_id = uuid::Uuid::new_v4().to_string();
    let started_at = now();
    let progress = ScanProgress {
        scan_id: scan_id.clone(),
        phase: ScanPhase::Queued,
        files_discovered: targets.len(),
        files_inspected: 0,
        files_skipped: 0,
        clean: 0,
        info: 0,
        suspicious: 0,
        malicious: 0,
        current_path: None,
        last_error: None,
        started_at,
        finished_at: None,
    };
    let record = Arc::new(Mutex::new(ScanRecord {
        scan_id: scan_id.clone(),
        target: label,
        options: options.clone(),
        progress,
        findings: Vec::new(),
    }));
    let cancel = Arc::new(AtomicBool::new(false));

    {
        let mut guard = registry();
        let map = guard.as_mut().expect("registry init");
        map.insert(
            scan_id.clone(),
            ScanHandle {
                record: record.clone(),
                cancel: cancel.clone(),
            },
        );
        trim_history(map);
    }

    let scan_id_for_task = scan_id.clone();
    tauri::async_runtime::spawn(async move {
        run_scan_explicit(scan_id_for_task, targets, options, record, cancel).await;
    });
    Ok(scan_id)
}

/// Walk multiple directory roots in a single scan. Missing roots are
/// silently skipped; the scan label is displayed verbatim in the UI.
/// Used by the "AGENT CONFIGS" preset so every agent-rule directory on
/// the machine (`~/.cursor`, `~/.claude`, `~/.codex`, `~/.aider`,
/// `~/.continue`, `~/Library/Application Support/Cursor/User`, …) is
/// inspected in one pass instead of one scan per root.
pub fn start_roots(
    label: String,
    roots: Vec<String>,
    options: ScanOptions,
) -> Result<String, String> {
    let existing: Vec<String> = roots
        .into_iter()
        .filter(|r| Path::new(r).exists())
        .collect();
    if existing.is_empty() {
        return Err("start_roots: no roots exist on this machine".into());
    }
    let scan_id = uuid::Uuid::new_v4().to_string();
    let started_at = now();
    let progress = ScanProgress {
        scan_id: scan_id.clone(),
        phase: ScanPhase::Queued,
        files_discovered: 0,
        files_inspected: 0,
        files_skipped: 0,
        clean: 0,
        info: 0,
        suspicious: 0,
        malicious: 0,
        current_path: None,
        last_error: None,
        started_at,
        finished_at: None,
    };
    let record = Arc::new(Mutex::new(ScanRecord {
        scan_id: scan_id.clone(),
        target: label,
        options: options.clone(),
        progress,
        findings: Vec::new(),
    }));
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = registry();
        let map = guard.as_mut().expect("registry init");
        map.insert(
            scan_id.clone(),
            ScanHandle { record: record.clone(), cancel: cancel.clone() },
        );
        trim_history(map);
    }
    let scan_id_for_task = scan_id.clone();
    tauri::async_runtime::spawn(async move {
        run_scan_roots(scan_id_for_task, existing, options, record, cancel).await;
    });
    Ok(scan_id)
}

async fn run_scan_roots(
    scan_id: String,
    roots: Vec<String>,
    options: ScanOptions,
    record: Arc<Mutex<ScanRecord>>,
    cancel: Arc<AtomicBool>,
) {
    set_phase(&record, ScanPhase::Walking);
    let mut entries: Vec<WalkEntry> = Vec::new();
    for r in &roots {
        if cancel.load(Ordering::Relaxed) {
            finalize(&record, ScanPhase::Aborted);
            return;
        }
        let root_entries = walk_target(Path::new(r), &options, &cancel, &record);
        entries.extend(root_entries);
    }
    set_phase(&record, ScanPhase::Analyzing);
    run_inspections(entries, options, record.clone(), cancel.clone()).await;
    set_current(&record, None);
    let final_phase = if cancel.load(Ordering::Relaxed) {
        ScanPhase::Aborted
    } else {
        ScanPhase::Done
    };
    finalize(&record, final_phase);
    let _ = scan_id;
}

pub fn start(target: String, options: ScanOptions) -> Result<String, String> {
    let target_path = Path::new(&target);
    if !target_path.exists() {
        return Err(format!("path does not exist: {target}"));
    }
    let scan_id = uuid::Uuid::new_v4().to_string();
    let started_at = now();

    let progress = ScanProgress {
        scan_id: scan_id.clone(),
        phase: ScanPhase::Queued,
        files_discovered: 0,
        files_inspected: 0,
        files_skipped: 0,
        clean: 0,
        info: 0,
        suspicious: 0,
        malicious: 0,
        current_path: None,
        last_error: None,
        started_at,
        finished_at: None,
    };
    let record = Arc::new(Mutex::new(ScanRecord {
        scan_id: scan_id.clone(),
        target: target.clone(),
        options: options.clone(),
        progress,
        findings: Vec::new(),
    }));
    let cancel = Arc::new(AtomicBool::new(false));

    {
        let mut guard = registry();
        let map = guard.as_mut().expect("registry init");
        map.insert(
            scan_id.clone(),
            ScanHandle {
                record: record.clone(),
                cancel: cancel.clone(),
            },
        );
        // Trim: keep current running scans + HISTORY_LIMIT completed.
        trim_history(map);
    }

    // Spawn on Tauri's own async runtime. We can't use `tokio::spawn`
    // directly because sync `#[tauri::command]` fns run on the blocking
    // pool — that thread has no tokio handle installed, and `tokio::spawn`
    // panics with "there is no reactor running". `tauri::async_runtime::spawn`
    // works from any context and dispatches onto Tauri's shared runtime.
    let target_for_task = target.clone();
    let scan_id_for_task = scan_id.clone();
    tauri::async_runtime::spawn(async move {
        run_scan(scan_id_for_task, target_for_task, options, record, cancel).await;
    });

    Ok(scan_id)
}

pub fn status(scan_id: &str) -> Option<ScanProgress> {
    let guard = registry();
    let map = guard.as_ref()?;
    let handle = map.get(scan_id)?;
    let rec = handle.record.lock().ok()?;
    Some(rec.progress.clone())
}

pub fn findings(scan_id: &str) -> Option<Vec<Finding>> {
    let guard = registry();
    let map = guard.as_ref()?;
    let handle = map.get(scan_id)?;
    let rec = handle.record.lock().ok()?;
    Some(rec.findings.clone())
}

pub fn get_record(scan_id: &str) -> Option<ScanRecord> {
    let guard = registry();
    let map = guard.as_ref()?;
    let handle = map.get(scan_id)?;
    let rec = handle.record.lock().ok()?;
    Some(rec.clone())
}

pub fn abort(scan_id: &str) -> Result<(), String> {
    let guard = registry();
    let map = guard.as_ref().ok_or_else(|| "registry uninit".to_string())?;
    let handle = map.get(scan_id).ok_or_else(|| format!("no scan {scan_id}"))?;
    handle.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

pub fn list_records() -> Vec<ScanRecord> {
    let guard = registry();
    let map = match guard.as_ref() {
        Some(m) => m,
        None => return Vec::new(),
    };
    let mut out: Vec<ScanRecord> = map
        .values()
        .filter_map(|h| h.record.lock().ok().map(|g| g.clone()))
        .collect();
    out.sort_by(|a, b| b.progress.started_at.cmp(&a.progress.started_at));
    out
}

pub fn quarantine(scan_id: &str, finding_id: &str) -> Result<super::types::VaultItem, String> {
    // Clone the finding out so we don't hold the mutex during fs ops.
    let finding = {
        let guard = registry();
        let map = guard.as_ref().ok_or_else(|| "registry uninit".to_string())?;
        let handle = map.get(scan_id).ok_or_else(|| format!("no scan {scan_id}"))?;
        let rec = handle.record.lock().map_err(|_| "record poisoned".to_string())?;
        rec.findings
            .iter()
            .find(|f| f.id == finding_id)
            .cloned()
            .ok_or_else(|| format!("no finding {finding_id}"))?
    };
    let item = super::vault::quarantine_finding(&finding)?;

    // Remove the quarantined finding from the scan record so the UI reflects
    // that it's gone — it now lives in the vault tab.
    {
        let mut guard = registry();
        if let Some(map) = guard.as_mut() {
            if let Some(handle) = map.get(scan_id) {
                if let Ok(mut rec) = handle.record.lock() {
                    rec.findings.retain(|f| f.id != finding_id);
                }
            }
        }
    }
    Ok(item)
}

// ---------------------------------------------------------------------------
// The scan loop
// ---------------------------------------------------------------------------

async fn run_scan(
    scan_id: String,
    target: String,
    options: ScanOptions,
    record: Arc<Mutex<ScanRecord>>,
    cancel: Arc<AtomicBool>,
) {
    set_phase(&record, ScanPhase::Walking);

    // ---- 1. Walk ----
    let entries = walk_target(Path::new(&target), &options, &cancel, &record);
    if cancel.load(Ordering::Relaxed) {
        finalize(&record, ScanPhase::Aborted);
        return;
    }

    // ---- 2. Inspect in parallel ----
    set_phase(&record, ScanPhase::Analyzing);
    run_inspections(entries, options, record.clone(), cancel.clone()).await;

    set_current(&record, None);
    let final_phase = if cancel.load(Ordering::Relaxed) {
        ScanPhase::Aborted
    } else {
        ScanPhase::Done
    };
    finalize(&record, final_phase);
    let _ = scan_id;
}

/// Alternate entry point — inspects an explicit list of paths without
/// walking. Used by preset scans like "running processes" and the
/// LaunchAgents sweep which already know precisely which files to check.
async fn run_scan_explicit(
    scan_id: String,
    targets: Vec<String>,
    options: ScanOptions,
    record: Arc<Mutex<ScanRecord>>,
    cancel: Arc<AtomicBool>,
) {
    set_phase(&record, ScanPhase::Analyzing);

    // Turn the caller-supplied paths into the same `WalkEntry` shape the
    // directory walker produces. We do the stat here (single syscall per
    // path) so the inspector never has to redo it.
    let mut entries: Vec<WalkEntry> = Vec::with_capacity(targets.len());
    for target in targets {
        let path = PathBuf::from(&target);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => entries.push(WalkEntry { path, meta }),
            _ => bump_skipped(&record),
        }
    }

    run_inspections(entries, options, record.clone(), cancel.clone()).await;

    set_current(&record, None);
    let final_phase = if cancel.load(Ordering::Relaxed) {
        ScanPhase::Aborted
    } else {
        ScanPhase::Done
    };
    finalize(&record, final_phase);
    let _ = scan_id;
}

/// Inspect every entry with bounded concurrency. This is where the actual
/// speed of a scan comes from: on a 2 000-file Downloads tree the old
/// sequential loop was ~45 s wall-clock (dominated by serialised subprocess
/// spawns), and the same tree now finishes in ~3 s with the same work done
/// per file.
async fn run_inspections(
    entries: Vec<WalkEntry>,
    options: ScanOptions,
    record: Arc<Mutex<ScanRecord>>,
    cancel: Arc<AtomicBool>,
) {
    let options = Arc::new(options);
    stream::iter(entries)
        .for_each_concurrent(INSPECT_CONCURRENCY, |entry| {
            let options = options.clone();
            let record = record.clone();
            let cancel = cancel.clone();
            async move {
                // Fast-path bail once abort is requested. In-flight tasks
                // still finish whatever syscall they were mid-way through,
                // but the queue behind them drains immediately.
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let display_path = entry.path.to_string_lossy().into_owned();
                // `current_path` is intentionally racy under concurrency —
                // whichever task wrote last wins, which matches how humans
                // read a live status line anyway.
                set_current(&record, Some(display_path));

                match inspect_file(entry, options.as_ref(), cancel.clone()).await {
                    InspectOutcome::Finding(f) => push_finding(&record, f),
                    InspectOutcome::Skipped(reason) => {
                        bump_skipped(&record);
                        if let Some(r) = reason {
                            set_last_error(&record, Some(r));
                        }
                    }
                    InspectOutcome::Cancelled => {
                        // Cancellation flag is already set — no extra work.
                    }
                }
            }
        })
        .await;
}

// ---------------------------------------------------------------------------
// Filesystem walker
//
// Iterative so stack depth doesn't blow up on ridiculous directory trees.
// Skips common noise: symlinks (to avoid loops), filesystem boundaries,
// `node_modules`, `.git`, and anything larger than `max_file_size`.
// ---------------------------------------------------------------------------

/// One file discovered by the walker, paired with its metadata so the
/// inspector doesn't have to `stat(2)` it a second time. The walker is
/// already holding the `DirEntry` — pulling the metadata out of it here
/// costs nothing and saves one syscall per file downstream.
pub(crate) struct WalkEntry {
    path: PathBuf,
    meta: Metadata,
}

fn walk_target(
    root: &Path,
    options: &ScanOptions,
    cancel: &AtomicBool,
    record: &Arc<Mutex<ScanRecord>>,
) -> Vec<WalkEntry> {
    let mut out: Vec<WalkEntry> = Vec::new();
    let mut stack: Vec<PathBuf> = Vec::new();

    let meta = match std::fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) => {
            set_last_error(record, Some(format!("cannot stat target: {e}")));
            return out;
        }
    };
    if meta.is_file() {
        out.push(WalkEntry { path: root.to_path_buf(), meta });
        bump_discovered(record, 1);
        return out;
    }
    if !meta.is_dir() {
        set_last_error(record, Some("target is not a file or directory".into()));
        return out;
    }
    stack.push(root.to_path_buf());

    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return out;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };

            // Skip symlinks so we don't loop or escape the tree.
            if file_type.is_symlink() {
                bump_skipped(record);
                continue;
            }

            if file_type.is_dir() {
                if should_skip_dir(&path) {
                    continue;
                }
                if options.recursive {
                    stack.push(path);
                }
                continue;
            }

            if file_type.is_file() {
                // We need the metadata anyway (for the inspector), so pay the
                // one stat here and pass it through. The walker used to peek
                // at size only via a conditional metadata call; the saved
                // syscall on every file downstream is worth the unconditional
                // read here.
                let m = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if let Some(limit) = options.max_file_size {
                    if m.len() > limit {
                        bump_skipped(record);
                        continue;
                    }
                }
                out.push(WalkEntry { path, meta: m });
                bump_discovered(record, 1);
            }
        }
    }

    out
}

fn should_skip_dir(path: &Path) -> bool {
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return false,
    };
    // Large, write-heavy, signed-noise dirs that produce no useful findings
    // and would otherwise balloon scan time.
    matches!(
        name.as_str(),
        "node_modules" | ".git" | ".svn" | ".hg" | "target" | "build" | "dist" | ".next" | ".cache"
    )
}

// ---------------------------------------------------------------------------
// Inspect a single file
// ---------------------------------------------------------------------------

enum InspectOutcome {
    Finding(Finding),
    Skipped(Option<String>),
    Cancelled,
}

/// Result of the synchronous, CPU/IO-bound portion of a file inspection.
/// The async `inspect_file` wrapper adds the optional network-lookup
/// signals on top of this and then builds the final `Finding`.
struct BlockingResult {
    size: u64,
    signals: Vec<Signal>,
    sha256: Option<String>,
}

enum BlockingOutcome {
    Ok(BlockingResult),
    Skipped(Option<String>),
    Cancelled,
}

/// Synchronous work: metadata heuristics, magic-byte probe, xattr, codesign
/// subprocess (when applicable), and SHA-256 streaming. Everything here
/// blocks a thread, so we dispatch it via `spawn_blocking` from the async
/// wrapper below — that lets us run 16 of these in parallel instead of
/// serialising on the async executor.
fn inspect_blocking(
    entry: &WalkEntry,
    options: &ScanOptions,
    cancel: &Arc<AtomicBool>,
) -> BlockingOutcome {
    let path = entry.path.as_path();
    let meta = &entry.meta;
    let size = meta.len();

    let mut signals: Vec<Signal> = Vec::new();
    if let Some(s) = heuristic::path_risk(path) {
        signals.push(s);
    }
    if let Some(s) = heuristic::recently_modified(meta) {
        signals.push(s);
    }
    if let Some(s) = heuristic::hidden_in_user_dir(path) {
        signals.push(s);
    }
    if let Some(s) = heuristic::quarantine_signal(path) {
        signals.push(s);
    }

    let magic = heuristic::magic_signal(path);
    let is_executable = matches!(
        &magic,
        Some(s) if matches!(s.kind, super::types::SignalKind::Executable)
    );
    if let Some(s) = magic {
        signals.push(s);
    }

    if let Some(s) = heuristic::codesign_signal(path, is_executable) {
        signals.push(s);
    }

    // ── Curated 2024-2026 threat-database checks ────────────────────────
    // Cheap: filename patterns first (pure in-memory regex against the
    // path string — no IO). Content patterns only run on small readable
    // text/script files where prompt-injection / malicious-script IoCs
    // would actually live.
    let fname_hits = signatures::match_filename(path);
    if let Some(sig) = signatures::hits_to_signal(&fname_hits) {
        signals.push(sig);
    }
    if let Some(buf) = read_text_preview(path, meta.len()) {
        let content_hits = signatures::match_content(&buf);
        if let Some(sig) = signatures::hits_to_signal(&content_hits) {
            signals.push(sig);
        }
    }

    // Only hash when the file looks interesting — hashing every clean file
    // in a large tree dominates wall-clock even with parallelism because
    // the kernel has to pull blocks through the page cache for each one.
    // `deep` mode is the escape hatch when the user explicitly wants a
    // full sweep.
    let worth_hashing = options.deep || !signals.is_empty();
    let mut sha256: Option<String> = None;
    if worth_hashing {
        match sha256_file(path, cancel.as_ref()) {
            Ok(Some(h)) => sha256 = Some(h),
            Ok(None) => return BlockingOutcome::Cancelled,
            Err(e) => return BlockingOutcome::Skipped(Some(format!("hash: {e}"))),
        }
    }

    BlockingOutcome::Ok(BlockingResult { size, signals, sha256 })
}

async fn inspect_file(
    entry: WalkEntry,
    options: &ScanOptions,
    cancel: Arc<AtomicBool>,
) -> InspectOutcome {
    // Run the blocking half on the Tokio blocking pool so it doesn't park
    // the async executor. Moving the whole `WalkEntry` + an owned
    // `ScanOptions` clone in keeps the blocking closure `'static`, which is
    // what `spawn_blocking` requires. We pass the *real* cancel Arc in
    // (not a snapshot) so an abort mid-hash on a multi-GB file still
    // short-circuits the SHA-256 loop.
    let options_owned = options.clone();
    let cancel_for_blocking = cancel.clone();
    let path_buf = entry.path.clone();
    let blocking = match tokio::task::spawn_blocking(move || {
        inspect_blocking(&entry, &options_owned, &cancel_for_blocking)
    })
    .await
    {
        Ok(v) => v,
        Err(e) => return InspectOutcome::Skipped(Some(format!("inspect task: {e}"))),
    };
    let BlockingResult { size, mut signals, sha256 } = match blocking {
        BlockingOutcome::Ok(r) => r,
        BlockingOutcome::Skipped(r) => return InspectOutcome::Skipped(r),
        BlockingOutcome::Cancelled => return InspectOutcome::Cancelled,
    };

    // Offline hash-prefix check — fast, no network, handles the "on a
    // plane / captive portal" case. The online MalwareBazaar lookup below
    // still runs when available and its verdict supersedes this one.
    if let Some(ref h) = sha256 {
        let hash_hits = signatures::match_hash_prefix(h);
        if let Some(sig) = signatures::hits_to_signal(&hash_hits) {
            signals.push(sig);
        }
    }

    // Network lookups only happen when we have a hash to ask about, which
    // keeps "clean" files out of the bazaar traffic entirely. Concurrent
    // inspections share the same reqwest client pool via keep-alive, so
    // 16 parallel lookups cost roughly one connection setup total.
    if options.online_lookup {
        if let Some(ref h) = sha256 {
            if let Some(v) = bazaar::lookup_sha256(h).await {
                if let Some(s) = bazaar::to_signal(&v) {
                    signals.push(s);
                }
            }
        }
    }
    if options.virustotal {
        if let Some(ref h) = sha256 {
            if let Some(key) = virustotal_api_key() {
                if let Some(v) = bazaar::lookup_virustotal(h, &key).await {
                    if let Some(s) = bazaar::vt_to_signal(&v) {
                        signals.push(s);
                    }
                }
            }
        }
    }

    let verdict = combine(&signals);
    let summary = summarize(&signals, verdict);
    InspectOutcome::Finding(Finding {
        id: uuid::Uuid::new_v4().to_string(),
        path: path_buf.to_string_lossy().into_owned(),
        size: Some(size),
        sha256,
        verdict,
        signals,
        summary,
        inspected_at: now(),
    })
}


fn combine(signals: &[Signal]) -> Verdict {
    let mut v = Verdict::Clean;
    for s in signals {
        v = v.max(s.weight);
    }
    // Escalation rule: quarantined + unsigned + risky path = suspicious even
    // if each individual signal was Info.
    let has_quarantine = signals
        .iter()
        .any(|s| matches!(s.kind, super::types::SignalKind::Quarantined));
    let has_unsigned = signals
        .iter()
        .any(|s| matches!(s.kind, super::types::SignalKind::Unsigned));
    let has_risk = signals
        .iter()
        .any(|s| matches!(s.kind, super::types::SignalKind::RiskyPath));
    if v == Verdict::Info && has_quarantine && has_unsigned && has_risk {
        v = Verdict::Suspicious;
    }
    v
}

fn summarize(signals: &[Signal], verdict: Verdict) -> String {
    if signals.is_empty() {
        return "No signals fired".into();
    }
    // Prefer the signal matching the final verdict, else the first signal.
    let chosen = signals
        .iter()
        .find(|s| s.weight == verdict)
        .unwrap_or(&signals[0]);
    chosen.detail.clone()
}

fn virustotal_api_key() -> Option<String> {
    // Users can stash it in an env var for now. The Settings page can later
    // offer a UI that writes this into the SUNNY Keychain vault.
    std::env::var("SUNNY_VIRUSTOTAL_KEY").ok()
}

/// Read up to `PREVIEW_MAX_BYTES` of a file as UTF-8 (lossy). Returns `None`
/// for files that are clearly not worth content-scanning: too large, empty,
/// binaries (by extension), or unreadable. This is the buffer we feed into
/// the signature database for prompt-injection / malicious-script matching.
fn read_text_preview(path: &Path, size: u64) -> Option<String> {
    const PREVIEW_MAX_BYTES: u64 = 256 * 1024;
    const MAX_FILE_FOR_PREVIEW: u64 = 8 * 1024 * 1024;
    if size == 0 || size > MAX_FILE_FOR_PREVIEW {
        return None;
    }
    if !is_text_likely_extension(path) && size > PREVIEW_MAX_BYTES {
        return None;
    }
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let take = size.min(PREVIEW_MAX_BYTES) as usize;
    let mut buf = Vec::with_capacity(take);
    let mut handle = f.by_ref().take(take as u64);
    handle.read_to_end(&mut buf).ok()?;
    // Reject binary-looking buffers — too many NUL bytes means we'd just be
    // regex-scanning noise. One NUL per 4 KB is a reasonable cutoff.
    let nul_count = buf.iter().filter(|b| **b == 0).count();
    if buf.len() >= 4096 && nul_count > buf.len() / 4096 {
        // Still allow it if the extension is obviously text (e.g. .txt
        // that happens to contain a stray NUL), otherwise bail.
        if !is_text_likely_extension(path) {
            return None;
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn is_text_likely_extension(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        // Scripts + code
        "sh" | "bash" | "zsh" | "fish" | "command" | "scpt" | "applescript"
        | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx"
        | "py" | "rb" | "pl" | "php" | "lua" | "rs" | "go" | "java" | "kt"
        | "c" | "cc" | "cpp" | "h" | "hpp" | "m" | "mm" | "swift"
        // Markup / data / docs
        | "txt" | "md" | "markdown" | "rst" | "adoc" | "org"
        | "html" | "htm" | "xml" | "xhtml" | "svg" | "css"
        | "json" | "jsonl" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "env"
        | "plist" | "strings"
        // LLM prompt files / agent configs (high value targets for PI)
        | "prompt" | "system" | "instructions" | "rules" | "agent"
        // Office / text-adjacent containers we might extract later
        | "csv" | "tsv" | "log"
    )
}

// ---------------------------------------------------------------------------
// Record mutations (short-lived locks)
// ---------------------------------------------------------------------------

fn set_phase(record: &Arc<Mutex<ScanRecord>>, phase: ScanPhase) {
    if let Ok(mut rec) = record.lock() {
        rec.progress.phase = phase;
    }
}

fn finalize(record: &Arc<Mutex<ScanRecord>>, phase: ScanPhase) {
    if let Ok(mut rec) = record.lock() {
        rec.progress.phase = phase;
        rec.progress.finished_at = Some(now());
        rec.progress.current_path = None;
    }
}

fn set_current(record: &Arc<Mutex<ScanRecord>>, path: Option<String>) {
    if let Ok(mut rec) = record.lock() {
        rec.progress.current_path = path;
    }
}

fn set_last_error(record: &Arc<Mutex<ScanRecord>>, err: Option<String>) {
    if let Ok(mut rec) = record.lock() {
        rec.progress.last_error = err;
    }
}

fn bump_discovered(record: &Arc<Mutex<ScanRecord>>, n: usize) {
    if let Ok(mut rec) = record.lock() {
        rec.progress.files_discovered += n;
    }
}

fn bump_skipped(record: &Arc<Mutex<ScanRecord>>) {
    if let Ok(mut rec) = record.lock() {
        rec.progress.files_skipped += 1;
    }
}

fn push_finding(record: &Arc<Mutex<ScanRecord>>, finding: Finding) {
    if let Ok(mut rec) = record.lock() {
        match finding.verdict {
            Verdict::Clean => rec.progress.clean += 1,
            Verdict::Info => rec.progress.info += 1,
            Verdict::Suspicious => rec.progress.suspicious += 1,
            Verdict::Malicious => rec.progress.malicious += 1,
            Verdict::Unknown => {}
        }
        rec.progress.files_inspected += 1;
        // Elide clean findings — the UI shows counts, and the list is for
        // actionable things. The per-verdict counter above still captures
        // the clean count for the header stats.
        if finding.verdict != Verdict::Clean {
            rec.findings.push(finding);
        }
    }
}

fn trim_history(map: &mut HashMap<String, ScanHandle>) {
    // Remove oldest finished scans when we exceed HISTORY_LIMIT.
    let mut finished: Vec<(String, i64)> = Vec::new();
    for (id, handle) in map.iter() {
        if let Ok(rec) = handle.record.lock() {
            if matches!(
                rec.progress.phase,
                ScanPhase::Done | ScanPhase::Aborted | ScanPhase::Errored
            ) {
                finished.push((id.clone(), rec.progress.started_at));
            }
        }
    }
    if finished.len() <= HISTORY_LIMIT {
        return;
    }
    finished.sort_by_key(|x| x.1);
    let excess = finished.len() - HISTORY_LIMIT;
    for (id, _) in finished.into_iter().take(excess) {
        map.remove(&id);
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Silence unused-import lint in case Deserialize isn't used.
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Serialize, Deserialize)]
struct _Ping;
