//! Quarantine vault — isolation storage for flagged files.
//!
//! On `quarantine()` we:
//!   1. `rename(src, ~/.sunny/scan_vault/{uuid}.bin)`   (atomic move)
//!   2. `chmod 000` on the moved file so it cannot be executed or read
//!      accidentally by the user or another agent.
//!   3. Write `{uuid}.json` sidecar with metadata (original path, verdict,
//!      reason, timestamps) so we can restore or purge later.
//!
//! This is distinct from `vault.rs` (secrets / Keychain).

use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::types::{Finding, SignalKind, VaultItem, Verdict};

const VAULT_DIR: &str = ".sunny/scan_vault";
// Vault is owner-only, read-execute on the dir so we can list it but
// nothing inside is executable by accident.
const DIR_MODE: u32 = 0o700;
// Quarantined files are inaccessible to everyone — restore rechmods them.
const FILE_MODE: u32 = 0o000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn vault_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no $HOME".to_string())?;
    let dir = home.join(VAULT_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("mkdir vault: {e}"))?;
    }
    fs::set_permissions(&dir, fs::Permissions::from_mode(DIR_MODE))
        .map_err(|e| format!("chmod vault: {e}"))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn quarantine_finding(finding: &Finding) -> Result<VaultItem, String> {
    let src = Path::new(&finding.path);
    if !src.exists() {
        return Err(format!("source not found: {}", finding.path));
    }
    let metadata = src.metadata().map_err(|e| format!("stat {}: {e}", finding.path))?;
    if !metadata.is_file() {
        return Err(format!("refusing to quarantine non-file: {}", finding.path));
    }
    let size = metadata.len();

    let root = vault_root()?;
    let id = uuid::Uuid::new_v4().to_string();
    let vault_path = root.join(format!("{id}.bin"));

    // Atomic rename first; fall back to copy+delete for cross-device moves.
    if fs::rename(src, &vault_path).is_err() {
        let mut input = File::open(src).map_err(|e| format!("open src: {e}"))?;
        let mut output = File::create(&vault_path).map_err(|e| format!("create vault: {e}"))?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = input.read(&mut buf).map_err(|e| format!("read src: {e}"))?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).map_err(|e| format!("write vault: {e}"))?;
        }
        drop(output);
        fs::remove_file(src).map_err(|e| format!("remove src: {e}"))?;
    }

    // Lock the file down so a double-click does nothing.
    let _ = fs::set_permissions(&vault_path, fs::Permissions::from_mode(FILE_MODE));

    let signals: Vec<SignalKind> = finding.signals.iter().map(|s| s.kind).collect();
    let reason = derive_reason(finding);

    let item = VaultItem {
        id: id.clone(),
        original_path: finding.path.clone(),
        vault_path: vault_path.to_string_lossy().to_string(),
        size,
        sha256: finding.sha256.clone().unwrap_or_default(),
        verdict: finding.verdict,
        reason,
        signals,
        quarantined_at: now(),
    };

    write_meta(&root, &item)?;
    Ok(item)
}

pub fn list() -> Result<Vec<VaultItem>, String> {
    let root = vault_root()?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("read vault: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(item) = serde_json::from_str::<VaultItem>(&data) {
                    out.push(item);
                }
            }
        }
    }
    // Newest first.
    out.sort_by(|a, b| b.quarantined_at.cmp(&a.quarantined_at));
    Ok(out)
}

pub fn restore(id: &str, overwrite_if_exists: bool) -> Result<String, String> {
    let root = vault_root()?;
    let meta_path = root.join(format!("{id}.json"));
    let bin_path = root.join(format!("{id}.bin"));
    let data = fs::read_to_string(&meta_path).map_err(|e| format!("read meta: {e}"))?;
    let item: VaultItem = serde_json::from_str(&data).map_err(|e| format!("parse meta: {e}"))?;

    let target = Path::new(&item.original_path);
    if target.exists() && !overwrite_if_exists {
        return Err(format!(
            "original path already exists: {} (pass overwrite=true to clobber)",
            item.original_path
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    // Restore sensible perms before moving so the file is usable again.
    let _ = fs::set_permissions(&bin_path, fs::Permissions::from_mode(0o644));
    if fs::rename(&bin_path, target).is_err() {
        // Cross-device: copy + delete.
        fs::copy(&bin_path, target).map_err(|e| format!("copy restore: {e}"))?;
        fs::remove_file(&bin_path).map_err(|e| format!("remove vault bin: {e}"))?;
    }
    let _ = fs::remove_file(&meta_path);
    Ok(item.original_path)
}

pub fn delete(id: &str) -> Result<(), String> {
    let root = vault_root()?;
    let meta_path = root.join(format!("{id}.json"));
    let bin_path = root.join(format!("{id}.bin"));
    // chmod first so `remove_file` can actually delete it.
    let _ = fs::set_permissions(&bin_path, fs::Permissions::from_mode(0o600));
    let _ = fs::remove_file(&bin_path);
    let _ = fs::remove_file(&meta_path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn write_meta(root: &Path, item: &VaultItem) -> Result<(), String> {
    let meta_path = root.join(format!("{}.json", item.id));
    let data = serde_json::to_string_pretty(item).map_err(|e| format!("serialize meta: {e}"))?;

    // Atomic write: `{path}.tmp` -> fsync + chmod 0600 -> rename.
    // Mirrors the scheduler / constitution / settings pattern so a crash
    // mid-write can never leave a half-written `{id}.json` on disk.
    let tmp_path = meta_path.with_extension("json.tmp");

    let write_result = (|| -> Result<(), String> {
        let mut f = File::create(&tmp_path).map_err(|e| format!("create tmp meta: {e}"))?;
        f.write_all(data.as_bytes())
            .map_err(|e| format!("write meta: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync meta: {e}"))?;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod meta: {e}"))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    fs::rename(&tmp_path, &meta_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename meta: {e}")
    })?;
    Ok(())
}

fn derive_reason(finding: &Finding) -> String {
    // Prefer the malicious signal's detail, else the highest-weight signal.
    let best = finding
        .signals
        .iter()
        .max_by_key(|s| match s.weight {
            Verdict::Malicious => 4,
            Verdict::Suspicious => 3,
            Verdict::Unknown => 2,
            Verdict::Info => 1,
            Verdict::Clean => 0,
        });
    best.map(|s| s.detail.clone()).unwrap_or_else(|| finding.summary.clone())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Silence unused import warnings on non-macOS (scan is macOS-only in practice
// but we want the crate to keep compiling on Linux CI).
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Serialize, Deserialize)]
struct _Ping;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_item(id: &str) -> VaultItem {
        VaultItem {
            id: id.to_string(),
            original_path: "/tmp/original.bin".to_string(),
            vault_path: format!("/tmp/{id}.bin"),
            size: 42,
            sha256: "deadbeef".to_string(),
            verdict: Verdict::Suspicious,
            reason: "test".to_string(),
            signals: vec![],
            quarantined_at: 0,
        }
    }

    #[test]
    fn write_meta_is_atomic_and_leaves_no_tmp() {
        // Unique scratch dir under the OS tempdir so tests don't collide.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("sunny-scan-vault-test-{nanos}"));
        fs::create_dir_all(&root).expect("create scratch");

        let id = "test-id-1234";
        let item = sample_item(id);

        write_meta(&root, &item).expect("write_meta");

        let meta_path = root.join(format!("{id}.json"));
        let tmp_path = meta_path.with_extension("json.tmp");

        // The real file must exist, the tmp must NOT be left behind.
        assert!(meta_path.exists(), "final meta file should exist");
        assert!(!tmp_path.exists(), "tmp file must be renamed away");

        // Deleting the real file should not reveal any stray `.tmp` sibling.
        fs::remove_file(&meta_path).expect("remove meta");
        assert!(!tmp_path.exists(), "no .tmp leftover after delete");

        // Permissions: owner-only 0600 on the written file (before deletion we
        // re-write so we can re-check).
        write_meta(&root, &item).expect("write_meta again");
        let mode = fs::metadata(&meta_path)
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "meta must be owner-only");

        // Cleanup.
        let _ = fs::remove_dir_all(&root);
    }
}
