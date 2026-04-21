//! Tauri command handlers for the scanner. Thin wrappers around the
//! scanner / vault / bazaar modules — no business logic here.

use std::process::Command;

use super::scanner;
use super::signatures::{self, SignatureCatalog};
use super::types::{Finding, ScanOptions, ScanProgress, ScanRecord, VaultItem};
use super::vault;

use crate::applescript::escape_applescript;

// ---------------------------------------------------------------------------
// Scan lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn scan_start(target: String, options: Option<ScanOptions>) -> Result<String, String> {
    scanner::start(target, options.unwrap_or_default())
}

/// Scan a caller-curated list of files. Used by preset scans (running
/// processes, LaunchAgents) that want to target specific paths instead of
/// walking a whole tree.
#[tauri::command]
pub fn scan_start_many(
    label: String,
    targets: Vec<String>,
    options: Option<ScanOptions>,
) -> Result<String, String> {
    scanner::start_many(label, targets, options.unwrap_or_default())
}

/// Walk a set of directory roots in one scan — used by the "AGENT
/// CONFIGS" preset so every `~/.cursor`, `~/.claude`, `AGENTS.md`-carrying
/// location is inspected in a single pass. Missing roots are ignored.
#[tauri::command]
pub fn scan_start_roots(
    label: String,
    roots: Vec<String>,
    options: Option<ScanOptions>,
) -> Result<String, String> {
    scanner::start_roots(label, roots, options.unwrap_or_default())
}

#[tauri::command]
pub fn scan_status(scan_id: String) -> Option<ScanProgress> {
    scanner::status(&scan_id)
}

#[tauri::command]
pub fn scan_findings(scan_id: String) -> Option<Vec<Finding>> {
    scanner::findings(&scan_id)
}

#[tauri::command]
pub fn scan_record(scan_id: String) -> Option<ScanRecord> {
    scanner::get_record(&scan_id)
}

#[tauri::command]
pub fn scan_abort(scan_id: String) -> Result<(), String> {
    scanner::abort(&scan_id)
}

#[tauri::command]
pub fn scan_list() -> Vec<ScanRecord> {
    scanner::list_records()
}

/// Curated 2024-2026 threat database — what the scanner matches against
/// beyond the online MalwareBazaar / VirusTotal lookups. Exposed so the
/// UI can show the user exactly which malware families, malicious-script
/// behaviours, and prompt-injection patterns we cover.
#[tauri::command]
pub fn scan_signature_catalog() -> SignatureCatalog {
    signatures::catalog()
}

/// One hit in a probe request — lightweight structure just for the UI.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeHit {
    pub id: &'static str,
    pub name: &'static str,
    pub category: signatures::SignatureCategory,
    pub weight: super::types::Verdict,
    pub excerpt: String,
    pub offset: Option<usize>,
}

/// Run an ad-hoc signature probe without starting a full scan.
///
/// The frontend passes an optional filename (path-like — checked against
/// filename IoC patterns), optional text body (checked against content
/// IoC patterns), and optional SHA-256 (checked against the offline
/// hash-prefix table). Any subset may be supplied. Useful for the
/// "PROBE" tool on the Scan tab: paste a suspicious snippet or filename
/// and see which signatures fire.
#[tauri::command]
pub fn scan_signature_probe(
    filename: Option<String>,
    text: Option<String>,
    sha256: Option<String>,
) -> Vec<ProbeHit> {
    let mut out: Vec<ProbeHit> = Vec::new();
    if let Some(name) = filename.as_ref() {
        if !name.trim().is_empty() {
            let p = std::path::Path::new(name);
            for h in signatures::match_filename(p) {
                out.push(ProbeHit {
                    id: h.entry.id,
                    name: h.entry.name,
                    category: h.entry.category,
                    weight: h.entry.weight,
                    excerpt: h.excerpt,
                    offset: h.offset,
                });
            }
        }
    }
    if let Some(body) = text.as_ref() {
        if !body.is_empty() {
            for h in signatures::match_content(body) {
                out.push(ProbeHit {
                    id: h.entry.id,
                    name: h.entry.name,
                    category: h.entry.category,
                    weight: h.entry.weight,
                    excerpt: h.excerpt,
                    offset: h.offset,
                });
            }
        }
    }
    if let Some(hash) = sha256.as_ref() {
        let trimmed = hash.trim();
        if !trimmed.is_empty() {
            for h in signatures::match_hash_prefix(trimmed) {
                out.push(ProbeHit {
                    id: h.entry.id,
                    name: h.entry.name,
                    category: h.entry.category,
                    weight: h.entry.weight,
                    excerpt: h.excerpt,
                    offset: h.offset,
                });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn scan_quarantine(scan_id: String, finding_id: String) -> Result<VaultItem, String> {
    scanner::quarantine(&scan_id, &finding_id)
}

#[tauri::command]
pub fn scan_vault_list() -> Result<Vec<VaultItem>, String> {
    vault::list()
}

#[tauri::command]
pub fn scan_vault_restore(id: String, overwrite: Option<bool>) -> Result<String, String> {
    vault::restore(&id, overwrite.unwrap_or(false))
}

#[tauri::command]
pub fn scan_vault_delete(id: String) -> Result<(), String> {
    vault::delete(&id)
}

// ---------------------------------------------------------------------------
// Utilities — native folder picker, reveal-in-Finder, special scan targets
// ---------------------------------------------------------------------------

/// Show the native macOS "choose folder" dialog and return the chosen path.
/// Returns `None` when the user cancels — the UI treats that as a no-op.
#[tauri::command]
pub fn scan_pick_folder(prompt: Option<String>) -> Result<Option<String>, String> {
    // We use AppleScript instead of pulling in `tauri-plugin-dialog` to keep
    // the dependency surface lean. `choose folder` returns a HFS-style alias;
    // POSIX path conversion gives us the absolute path we need.
    let prompt_text = prompt.unwrap_or_else(|| "Pick a folder to scan".to_string());
    let script = format!(
        "try
            set theFolder to choose folder with prompt \"{}\"
            return POSIX path of theFolder
         on error number -128
            return \"\"
         end try",
        escape_applescript(&prompt_text),
    );
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(path))
}

/// Open the containing folder of `path` in Finder with the file selected.
#[tauri::command]
pub fn scan_reveal_in_finder(path: String) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("open -R: {e}"))?;
    if !status.success() {
        return Err(format!("open -R exited {status}"));
    }
    Ok(())
}

/// Enumerate running processes and return the set of unique on-disk
/// executable paths. The UI feeds this into `scan_start` so each binary gets
/// hashed + looked up. Skips kernel threads, per-user helper daemons whose
/// paths we can't resolve, and duplicates.
#[tauri::command]
pub fn scan_running_executables() -> Result<Vec<String>, String> {
    // `ps -axo comm=` prints the full exec path (column `comm`), one per line.
    // `=` suppresses the header. `-ax` includes processes for every user the
    // invoking uid can see.
    let out = Command::new("/bin/ps")
        .args(["-axo", "comm="])
        .output()
        .map_err(|e| format!("ps: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let mut seen = std::collections::HashSet::new();
    let mut paths = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let path = line.trim();
        // Ignore empties and synthesized paths like "(launchd)".
        if path.is_empty() || !path.starts_with('/') {
            continue;
        }
        // Only real files on disk. Kernel tasks / removed binaries are skipped.
        if !std::path::Path::new(path).is_file() {
            continue;
        }
        if seen.insert(path.to_string()) {
            paths.push(path.to_string());
        }
    }
    paths.sort();
    Ok(paths)
}

