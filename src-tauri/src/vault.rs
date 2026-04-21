//! Vault — macOS Keychain-backed secret manager.
//!
//! Values are stored in the macOS login Keychain via the `security` CLI; we
//! maintain an index (labels, kinds, service names, timestamps — never
//! values) in `~/.sunny/vault_index.json`. All user-supplied strings are
//! passed as argv (never interpolated into a shell command), and secret
//! values are never logged.
//!
//! Keychain conventions:
//!   service  = "sunny.<uuid>"         (unique per item)
//!   account  = "sunny-user"           (constant)
//!   data     = the raw secret value

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const ACCOUNT: &str = "sunny-user";
const INDEX_DIR: &str = ".sunny";
const INDEX_FILE: &str = "vault_index.json";

// -------------- Rate limiter -----------------
// Cap how fast anyone (the user OR a runaway agent) can pull secrets out of
// the vault. A well-behaved UI asks for one secret at a time; a looping
// agent might ask for all of them in one turn. This cap stops that.
const REVEAL_WINDOW: Duration = Duration::from_secs(60);
const REVEAL_MAX_PER_WINDOW: usize = 5;

fn reveal_gate() -> &'static Mutex<VecDeque<Instant>> {
    use std::sync::OnceLock;
    static GATE: OnceLock<Mutex<VecDeque<Instant>>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(VecDeque::with_capacity(REVEAL_MAX_PER_WINDOW + 1)))
}

fn check_reveal_rate() -> Result<(), String> {
    let gate = reveal_gate();
    let mut stamps = gate.lock().map_err(|_| "vault gate poisoned".to_string())?;
    let now = Instant::now();
    while let Some(front) = stamps.front() {
        if now.duration_since(*front) > REVEAL_WINDOW {
            stamps.pop_front();
        } else {
            break;
        }
    }
    if stamps.len() >= REVEAL_MAX_PER_WINDOW {
        // Seconds until the oldest stamp ages out; that's when the next
        // reveal becomes permissible. Surfaced to the UI in the error
        // string as `retry=NNs` so the client can render a cooldown.
        let retry = stamps
            .front()
            .map(|front| REVEAL_WINDOW.saturating_sub(now.duration_since(*front)))
            .unwrap_or_default()
            .as_secs()
            .max(1);
        return Err(format!(
            "vault reveal rate-limited: max {} reveals per {}s (retry={}s)",
            REVEAL_MAX_PER_WINDOW,
            REVEAL_WINDOW.as_secs(),
            retry,
        ));
    }
    stamps.push_back(now);
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultItem {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub service: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    /// Set when the secret value is rotated via `vault_update_value`. Missing
    /// on items created before this field existed.
    #[serde(default)]
    pub updated_at: Option<i64>,
    /// Lifetime count of successful reveals. Stored in the index (not in
    /// the Keychain) so rotating a secret keeps the audit trail.
    #[serde(default)]
    pub reveal_count: u32,
}

// ---------------- Index on-disk ----------------

fn index_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    Ok(home.join(INDEX_DIR))
}

fn index_path() -> Result<PathBuf, String> {
    Ok(index_dir()?.join(INDEX_FILE))
}

fn ensure_index_dir() -> Result<(), String> {
    let dir = index_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("mkdir ~/.sunny: {e}"))?;
    }
    Ok(())
}

fn read_index() -> Result<Vec<VaultItem>, String> {
    let path = index_path()?;
    match fs::read_to_string(&path) {
        Ok(raw) => {
            if raw.trim().is_empty() {
                return Ok(Vec::new());
            }
            serde_json::from_str::<Vec<VaultItem>>(&raw)
                .map_err(|e| format!("parse vault index: {e}"))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read vault index: {e}")),
    }
}

fn write_index(items: &[VaultItem]) -> Result<(), String> {
    ensure_index_dir()?;
    let path = index_path()?;
    let tmp = path.with_extension("json.tmp");
    let encoded =
        serde_json::to_string_pretty(items).map_err(|e| format!("encode vault index: {e}"))?;
    fs::write(&tmp, encoded).map_err(|e| format!("write vault index tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename vault index: {e}"))?;
    Ok(())
}

// ---------------- Identifiers ----------------

/// Produce a reasonably-unique id without adding a `uuid` dependency.
/// Format: 32 lowercase hex chars.
fn new_uuid() -> String {
    let nanos = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let pid = std::process::id() as u64;
    // Mix in address-space entropy via a stack pointer.
    let marker = 0u8;
    let addr = &marker as *const u8 as usize as u64;
    let ns_mix = nanos.rotate_left(17) as u64 ^ pid.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let addr_mix = addr.rotate_left(29) ^ (nanos as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    format!("{:016x}{:016x}", ns_mix, addr_mix)
}

fn is_valid_kind(k: &str) -> bool {
    matches!(k, "api_key" | "password" | "token" | "ssh" | "note")
}

fn validate_label(label: &str) -> Result<(), String> {
    let len = label.chars().count();
    if len == 0 {
        return Err("label required".into());
    }
    if len > 200 {
        return Err("label too long (max 200 chars)".into());
    }
    if label.contains('\0') {
        return Err("label contains null byte".into());
    }
    Ok(())
}

// ---------------- security(1) wrappers ----------------

fn security_bin() -> PathBuf {
    // `security` ships with macOS at /usr/bin/security.
    PathBuf::from("/usr/bin/security")
}

fn keychain_add(service: &str, value: &str) -> Result<(), String> {
    let status = Command::new(security_bin())
        .args([
            "add-generic-password",
            "-s",
            service,
            "-a",
            ACCOUNT,
            "-w",
            value,
            "-U",
        ])
        .status()
        .map_err(|e| format!("security add: {e}"))?;
    if !status.success() {
        return Err(format!(
            "security add-generic-password failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

fn keychain_find(service: &str) -> Result<String, String> {
    let out = Command::new(security_bin())
        .args([
            "find-generic-password",
            "-s",
            service,
            "-a",
            ACCOUNT,
            "-w",
        ])
        .output()
        .map_err(|e| format!("security find: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "keychain lookup failed: {}",
            stderr.trim().is_empty().then(|| "no such item".to_string()).unwrap_or_else(|| stderr.trim().to_string())
        ));
    }
    let raw = String::from_utf8(out.stdout).map_err(|_| "non-utf8 secret".to_string())?;
    // `security -w` prints the password followed by a newline.
    let value = raw.trim_end_matches(['\n', '\r']).to_string();
    Ok(value)
}

fn keychain_delete(service: &str) -> Result<(), String> {
    let status = Command::new(security_bin())
        .args([
            "delete-generic-password",
            "-s",
            service,
            "-a",
            ACCOUNT,
        ])
        .status()
        .map_err(|e| format!("security delete: {e}"))?;
    if !status.success() {
        // Continue — item may already be absent. Surface non-fatal note.
        return Err(format!(
            "security delete-generic-password failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

// ---------------- Public API ----------------

pub fn list_items() -> Result<Vec<VaultItem>, String> {
    read_index()
}

pub fn add_item(kind: String, label: String, value: String) -> Result<VaultItem, String> {
    if !is_valid_kind(&kind) {
        return Err(format!("invalid kind: {kind}"));
    }
    validate_label(&label)?;
    if value.is_empty() {
        return Err("value required".into());
    }
    if value.contains('\0') {
        return Err("value contains null byte".into());
    }

    let id = format!("sunny.{}", new_uuid());
    let service = id.clone();

    keychain_add(&service, &value)?;

    let item = VaultItem {
        id,
        kind,
        label,
        service,
        created_at: chrono::Utc::now().timestamp(),
        last_used_at: None,
        updated_at: None,
        reveal_count: 0,
    };

    let mut index = read_index().unwrap_or_default();
    let next: Vec<VaultItem> = index.drain(..).chain(std::iter::once(item.clone())).collect();
    if let Err(e) = write_index(&next) {
        // Attempt to roll back the keychain entry so index and keychain
        // don't drift. Ignore rollback errors.
        let _ = keychain_delete(&item.service);
        return Err(e);
    }

    Ok(item)
}

pub fn reveal(id: String) -> Result<String, String> {
    check_reveal_rate()?;
    let index = read_index()?;
    let item = index
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| "item not found".to_string())?;
    let value = keychain_find(&item.service)?;
    // Best-effort: bump last_used_at. If this fails, still return value.
    let _ = mark_used(id);
    Ok(value)
}

pub fn delete_item(id: String) -> Result<(), String> {
    let index = read_index()?;
    let Some(item) = index.iter().find(|i| i.id == id).cloned() else {
        return Err("item not found".into());
    };

    // Try to delete from keychain first; ignore "not found" style errors
    // so an orphaned index entry can still be removed.
    let _ = keychain_delete(&item.service);

    let next: Vec<VaultItem> = index.into_iter().filter(|i| i.id != id).collect();
    write_index(&next)
}

pub fn rename_item(id: String, label: String) -> Result<VaultItem, String> {
    validate_label(&label)?;
    let index = read_index()?;
    if !index.iter().any(|i| i.id == id) {
        return Err("item not found".into());
    }
    let mut renamed: Option<VaultItem> = None;
    let next: Vec<VaultItem> = index
        .into_iter()
        .map(|i| {
            if i.id == id {
                let upd = VaultItem {
                    label: label.clone(),
                    ..i
                };
                renamed = Some(upd.clone());
                upd
            } else {
                i
            }
        })
        .collect();
    write_index(&next)?;
    renamed.ok_or_else(|| "rename failed".to_string())
}

pub fn update_value(id: String, value: String) -> Result<VaultItem, String> {
    if value.is_empty() {
        return Err("value required".into());
    }
    if value.contains('\0') {
        return Err("value contains null byte".into());
    }
    let index = read_index()?;
    let Some(target) = index.iter().find(|i| i.id == id).cloned() else {
        return Err("item not found".into());
    };

    // `security add-generic-password -U` updates in place when the item
    // already exists with the same service+account, so this is atomic from
    // the Keychain's perspective (no plaintext window on disk).
    keychain_add(&target.service, &value)?;

    let now = chrono::Utc::now().timestamp();
    let mut updated: Option<VaultItem> = None;
    let next: Vec<VaultItem> = index
        .into_iter()
        .map(|i| {
            if i.id == id {
                let upd = VaultItem {
                    updated_at: Some(now),
                    ..i
                };
                updated = Some(upd.clone());
                upd
            } else {
                i
            }
        })
        .collect();
    write_index(&next)?;
    updated.ok_or_else(|| "update failed".to_string())
}

pub fn mark_used(id: String) -> Result<(), String> {
    let index = read_index()?;
    let now = chrono::Utc::now().timestamp();
    let next: Vec<VaultItem> = index
        .into_iter()
        .map(|i| {
            if i.id == id {
                VaultItem {
                    last_used_at: Some(now),
                    reveal_count: i.reveal_count.saturating_add(1),
                    ..i
                }
            } else {
                i
            }
        })
        .collect();
    write_index(&next)
}
