//! Safe filesystem write/edit/read operations for SUNNY.
//!
//! The agent layer can invoke these commands to read, write, edit, rename and
//! delete files. Every operation is gated by a path-safety policy that rejects
//! writes outside the user's home directory (and always rejects well-known
//! system paths even if the caller somehow redirected $HOME). Writes are
//! performed atomically via tmp-file + rename, mirroring the pattern used in
//! settings.rs. file_edit requires the caller to declare the number of
//! replacements it expects — this prevents a buggy agent from silently
//! substituting every occurrence of a common token.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::security::{self, SecurityEvent, Severity};

// --- Limits -----------------------------------------------------------------

/// Default cap for file_read_text when the caller doesn't specify one: 2 MiB.
const DEFAULT_READ_CAP: usize = 2 * 1024 * 1024;
/// Hard ceiling for file_read_text regardless of caller input: 10 MiB.
const MAX_READ_CAP: usize = 10 * 1024 * 1024;
/// Marker appended when we truncate a large read. Caller can look for this.
const TRUNCATION_MARKER: &str = "\n…[truncated]";

// --- Structs returned to the frontend --------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOpResult {
    pub path: String,
    pub bytes: usize,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEditResult {
    pub path: String,
    pub replacements: u32,
    pub bytes_before: usize,
    pub bytes_after: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub modified_secs: i64,
}

// --- Path safety ------------------------------------------------------------

/// Top-level roots that are never valid write targets. Even a misconfigured
/// `$HOME` cannot redirect a write here — we check after expansion.
const FORBIDDEN_ROOTS: &[&str] = &[
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/private",
    "/var",
    "/opt",
    "/cores",
    "/Network",
];

/// Lookup the caller's home directory. Separated so tests can override via
/// env var without monkey-patching `dirs`.
fn home_dir() -> Result<PathBuf, String> {
    if let Ok(h) = std::env::var("SUNNY_FILESYS_HOME_OVERRIDE") {
        return Ok(PathBuf::from(h));
    }
    dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())
}

/// Expand a leading `~` or `~/` to the user's home dir. Non-tilde paths pass
/// through untouched.
fn expand_tilde(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" {
        return home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return Ok(home_dir()?.join(rest));
    }
    Ok(PathBuf::from(raw))
}

/// Resolve any `.` / `..` components the caller may have embedded so that our
/// safety check sees the *effective* target path, not the textual one. We
/// can't use `canonicalize()` because the file may not exist yet.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Validate a path is safe to **write/delete/rename into**. Reads use a
/// looser rule — they just forbid the explicit FORBIDDEN_ROOTS but allow any
/// readable location. `require_under_home` flags writes.
fn check_path(raw: &str, require_under_home: bool) -> Result<PathBuf, String> {
    let expanded = expand_tilde(raw)?;
    if !expanded.is_absolute() {
        return Err(format!(
            "path must be absolute or begin with '~': got {raw}"
        ));
    }
    let normalized = normalize(&expanded);
    let as_str = normalized.to_string_lossy().to_string();

    if as_str == "/" {
        return Err("refusing to operate on filesystem root '/'".into());
    }

    // Whitelist tmp-dir and /tmp first, since on macOS std::env::temp_dir()
    // returns something under /var/folders/... which would otherwise trip
    // the /var forbidden-root rule below.
    let tmp = std::env::temp_dir();
    let tmp_norm = normalize(&tmp);
    let tmp_str = tmp_norm.to_string_lossy().to_string();
    let under_tmp = as_str == tmp_str || as_str.starts_with(&format!("{tmp_str}/"));
    let under_slashtmp = as_str == "/tmp" || as_str.starts_with("/tmp/");

    if !(under_tmp || under_slashtmp) {
        // Forbidden top-level roots (post-normalization so ../ can't sneak by).
        for root in FORBIDDEN_ROOTS {
            if as_str == *root || as_str.starts_with(&format!("{root}/")) {
                return Err(format!("refusing to operate on protected path: {root}"));
            }
        }
    }

    if require_under_home {
        let home = home_dir()?;
        let home_norm = normalize(&home);
        let home_str = home_norm.to_string_lossy().to_string();
        let under_home = as_str == home_str || as_str.starts_with(&format!("{home_str}/"));
        if !(under_home || under_tmp || under_slashtmp) {
            return Err(format!(
                "refusing to write outside $HOME or temp dir: {as_str}"
            ));
        }
    }

    Ok(normalized)
}

// --- Atomic write primitive -------------------------------------------------

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Pid + nanotime + monotonic counter gives a unique tmp name even under
/// highly concurrent writes in the same process at the same instant. This
/// mirrors settings.rs::save_to.
fn unique_tmp_path(final_path: &Path) -> PathBuf {
    let parent = final_path.parent().unwrap_or_else(|| Path::new("/"));
    let name = final_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    parent.join(format!(".{name}.tmp.{pid}.{nanos}.{counter}"))
}

/// Atomic write: tmp + fsync + rename. On any error the tmp file is cleaned
/// up so we don't leak dotfiles.
fn atomic_write(final_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = final_path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", final_path.display()))?;
    if !parent.exists() {
        return Err(format!(
            "parent directory does not exist: {}",
            parent.display()
        ));
    }
    let tmp_path = unique_tmp_path(final_path);
    let write_result = (|| -> Result<(), String> {
        let mut f =
            fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync: {e}"))?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    fs::rename(&tmp_path, final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename tmp: {e}")
    })?;
    Ok(())
}

// --- Public API -------------------------------------------------------------

/// Scrub a path for the SecurityBus: replace the caller's $HOME prefix with
/// `~` so long paths don't blow up the audit log and the user's username
/// doesn't leak into persisted events.
fn scrub_path_for_event(raw: &str) -> String {
    if let Ok(home) = home_dir() {
        let home_str = home.to_string_lossy().to_string();
        if raw == home_str {
            return "~".to_string();
        }
        if let Some(rest) = raw.strip_prefix(&format!("{home_str}/")) {
            return format!("~/{rest}");
        }
    }
    raw.to_string()
}

/// Generate a compact event id unique enough for correlating a single
/// filesys op's log line. `pid.nanos.counter` mirrors the tmp-file scheme.
fn event_id() -> String {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("fs.{pid}.{nanos}.{counter}")
}

/// Fire-and-forget emit of a filesys op onto the SecurityBus. Reads are
/// `Info`, mutations are `Warn` — the live monitor can surface a louder
/// chip for anything that touched bytes on disk. `dangerous` is true for
/// mutations so the UI can badge them alongside other write-class tools.
/// Never propagates errors — the bus may not even be installed yet in
/// early-boot code paths.
fn emit_filesys(op: &str, path: &str, ok: bool, bytes: Option<usize>) {
    let is_mutation = matches!(
        op,
        "write" | "delete" | "rename" | "mkdir" | "append" | "edit"
    );
    let severity = if is_mutation {
        if ok { Severity::Warn } else { Severity::Warn }
    } else {
        Severity::Info
    };
    let scrubbed = scrub_path_for_event(path);
    security::emit(SecurityEvent::ToolCall {
        at: security::now(),
        id: event_id(),
        tool: format!("file_{op}"),
        risk: if is_mutation { "write" } else { "read" },
        dangerous: is_mutation,
        agent: "filesys".to_string(),
        input_preview: scrubbed,
        ok: Some(ok),
        output_bytes: bytes,
        duration_ms: None,
        severity,
    });
}

/// Write `content` to `path` atomically. If `create_dirs` is true, any
/// missing parents are created. Returns whether the file was freshly created
/// (vs overwritten).
pub async fn file_write(
    path: String,
    content: String,
    create_dirs: bool,
) -> Result<FileOpResult, String> {
    let result = (|| -> Result<FileOpResult, String> {
        let p = check_path(&path, true)?;
        if create_dirs {
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("create parents: {e}"))?;
            }
        }
        let created = !p.exists();
        let bytes = content.as_bytes();
        atomic_write(&p, bytes)?;
        Ok(FileOpResult {
            path: p.to_string_lossy().to_string(),
            bytes: bytes.len(),
            created,
        })
    })();
    let (ok, out_bytes, report_path) = match &result {
        Ok(r) => (true, Some(r.bytes), r.path.clone()),
        Err(_) => (false, None, path.clone()),
    };
    emit_filesys("write", &report_path, ok, out_bytes);
    result
}

/// Append `content` to `path`. If the file doesn't exist it is created.
/// Append is not atomic in the tmp-rename sense — it uses O_APPEND which
/// gives atomicity per-write on POSIX for small writes. For very large
/// payloads the caller should prefer file_write.
pub async fn file_append(path: String, content: String) -> Result<FileOpResult, String> {
    let result = (|| -> Result<FileOpResult, String> {
        let p = check_path(&path, true)?;
        let created = !p.exists();
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| format!("open append: {e}"))?;
        let bytes = content.as_bytes();
        f.write_all(bytes).map_err(|e| format!("append: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync append: {e}"))?;
        Ok(FileOpResult {
            path: p.to_string_lossy().to_string(),
            bytes: bytes.len(),
            created,
        })
    })();
    let (ok, out_bytes, report_path) = match &result {
        Ok(r) => (true, Some(r.bytes), r.path.clone()),
        Err(_) => (false, None, path.clone()),
    };
    emit_filesys("append", &report_path, ok, out_bytes);
    result
}

/// Read text content from `path`. Default cap is 2 MiB; callers may request
/// up to 10 MiB. If the file exceeds the effective cap we return the first
/// `cap` bytes (snapped to a UTF-8 boundary) plus a truncation marker.
pub async fn file_read_text(
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    // Reads don't have to be under $HOME — user might want to read from
    // /tmp, ~/Library/..., /usr/share, etc. But we still deny the truly
    // sensitive roots.
    let result = (|| -> Result<String, String> {
        let p = check_path(&path, false)?;
        if !p.exists() {
            return Err(format!("file does not exist: {}", p.display()));
        }
        let cap = max_bytes.unwrap_or(DEFAULT_READ_CAP).min(MAX_READ_CAP);
        let md = fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
        let size = md.len() as usize;

        // Fast path: small file, slurp it.
        if size <= cap {
            return fs::read_to_string(&p).map_err(|e| format!("read: {e}"));
        }

        // Truncating path: read up to cap+some slack so we can back off to a
        // char boundary. We read exactly `cap` bytes then trim any trailing
        // partial UTF-8 codepoint.
        let mut f = fs::File::open(&p).map_err(|e| format!("open: {e}"))?;
        let mut buf = vec![0u8; cap];
        let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        buf.truncate(n);
        // Walk back to a valid UTF-8 boundary.
        let mut end = n;
        while end > 0 {
            if std::str::from_utf8(&buf[..end]).is_ok() {
                break;
            }
            end -= 1;
        }
        let mut out = String::from_utf8_lossy(&buf[..end]).to_string();
        out.push_str(TRUNCATION_MARKER);
        Ok(out)
    })();
    let (ok, out_bytes) = match &result {
        Ok(s) => (true, Some(s.len())),
        Err(_) => (false, None),
    };
    emit_filesys("read", &path, ok, out_bytes);
    result
}

/// Find-and-replace inside a file. The caller declares `expect_count` so we
/// can reject the edit if the find-pattern matched an unexpected number of
/// times (the default is exactly one replacement — the safe, precise case).
/// Passing `None` opts out of the check and allows any count. If the pattern
/// does not appear at all, or appears more times than expected, the file is
/// left untouched and we return an error.
pub async fn file_edit(
    path: String,
    find: String,
    replace: String,
    expect_count: Option<u32>,
) -> Result<FileEditResult, String> {
    let result = (|| -> Result<FileEditResult, String> {
        let p = check_path(&path, true)?;
        if find.is_empty() {
            return Err("find pattern cannot be empty".into());
        }
        let original = fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
        let bytes_before = original.len();

        // Note: we use byte-literal matching. Unicode normalization (NFC/NFD) is
        // the caller's responsibility — we do not silently transform either the
        // haystack or the needle, since doing so would change the file contents.
        // If a caller needs NFC-agnostic matching they should pre-normalize both
        // strings before invoking file_edit.
        let actual = original.matches(find.as_str()).count() as u32;

        // Safety check: if the caller passes Some(n), the number of matches
        // must equal n exactly, otherwise we reject without touching the file.
        // This is the primary guard against an agent accidentally performing a
        // global substitution of a common token like "true" or "id". The
        // frontend wrapper always supplies Some(1) by default; callers that
        // genuinely want "replace all" must pass None to explicitly opt out of
        // the check. When at least one match is found we always proceed.
        if let Some(expected) = expect_count {
            if actual != expected {
                return Err(format!(
                    "expected {expected} replacement(s) but found {actual} match(es) of pattern in {}; no changes written",
                    p.display()
                ));
            }
        } else if actual == 0 {
            return Err(format!(
                "pattern not found in {}; no changes written",
                p.display()
            ));
        }

        let updated = original.replace(find.as_str(), &replace);
        let bytes_after = updated.len();
        atomic_write(&p, updated.as_bytes())?;
        Ok(FileEditResult {
            path: p.to_string_lossy().to_string(),
            replacements: actual,
            bytes_before,
            bytes_after,
        })
    })();
    let (ok, out_bytes, report_path) = match &result {
        Ok(r) => (true, Some(r.bytes_after), r.path.clone()),
        Err(_) => (false, None, path.clone()),
    };
    emit_filesys("edit", &report_path, ok, out_bytes);
    result
}

/// Delete a single file. Refuses directories — use explicit rmdir semantics
/// via caller code if directory deletion is ever needed.
pub async fn file_delete(path: String) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let p = check_path(&path, true)?;
        let md = fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
        if md.is_dir() {
            return Err(format!(
                "refusing to delete a directory via file_delete: {}",
                p.display()
            ));
        }
        fs::remove_file(&p).map_err(|e| format!("remove: {e}"))
    })();
    emit_filesys("delete", &path, result.is_ok(), None);
    result
}

/// Rename/move a file. Both endpoints must pass the write safety check.
pub async fn file_rename(from: String, to: String) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let src = check_path(&from, true)?;
        let dst = check_path(&to, true)?;
        fs::rename(&src, &dst).map_err(|e| format!("rename: {e}"))
    })();
    // Encode both endpoints in the event preview so the audit trail
    // captures the full from→to move, not just the source.
    let from_scrubbed = scrub_path_for_event(&from);
    let to_scrubbed = scrub_path_for_event(&to);
    let combined = format!("{from_scrubbed} → {to_scrubbed}");
    emit_filesys("rename", &combined, result.is_ok(), None);
    result
}

/// Make a directory. When `recursive` is true, all missing parents are
/// created; otherwise only the final component is created and the call fails
/// if any parent is missing.
pub async fn file_mkdir(path: String, recursive: bool) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let p = check_path(&path, true)?;
        if recursive {
            fs::create_dir_all(&p).map_err(|e| format!("mkdir -p: {e}"))
        } else {
            fs::create_dir(&p).map_err(|e| format!("mkdir: {e}"))
        }
    })();
    emit_filesys("mkdir", &path, result.is_ok(), None);
    result
}

/// Stat-like existence check. Never errors for a missing file — returns
/// `exists: false`. Errors only when metadata retrieval itself fails.
pub async fn file_exists(path: String) -> Result<FileInfo, String> {
    let result = (|| -> Result<FileInfo, String> {
        let p = check_path(&path, false)?;
        if !p.exists() {
            return Ok(FileInfo {
                exists: false,
                is_file: false,
                is_dir: false,
                size: 0,
                modified_secs: 0,
            });
        }
        let md = fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
        let modified_secs = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        Ok(FileInfo {
            exists: true,
            is_file: md.is_file(),
            is_dir: md.is_dir(),
            size: md.len(),
            modified_secs,
        })
    })();
    emit_filesys("exists", &path, result.is_ok(), None);
    result
}

// --- Tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Unique scratch dir under std::env::temp_dir(), removed on drop.
    struct Scratch {
        path: PathBuf,
    }
    impl Scratch {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sunny-filesys-test-{tag}-{pid}-{nanos}-{seq}",
                pid = std::process::id()
            ));
            fs::create_dir_all(&path).expect("create scratch");
            Self { path }
        }
        fn join(&self, name: &str) -> String {
            self.path.join(name).to_string_lossy().to_string()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn write_then_read_text_roundtrip() {
        let s = Scratch::new("roundtrip");
        let target = s.join("hello.txt");
        let payload = "hello, world\nline two".to_string();

        let res = file_write(target.clone(), payload.clone(), false)
            .await
            .expect("write");
        assert!(res.created);
        assert_eq!(res.bytes, payload.len());

        let got = file_read_text(target, None).await.expect("read");
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn append_extends_existing_file() {
        let s = Scratch::new("append");
        let target = s.join("log.txt");

        file_write(target.clone(), "first\n".into(), false)
            .await
            .expect("write");
        let r = file_append(target.clone(), "second\n".into())
            .await
            .expect("append");
        assert!(!r.created, "file already existed before append");

        let got = file_read_text(target, None).await.expect("read");
        assert_eq!(got, "first\nsecond\n");
    }

    #[tokio::test]
    async fn edit_with_expect_one_succeeds_and_mismatch_rejects() {
        let s = Scratch::new("edit");
        let target = s.join("code.rs");
        let src = "let x = 1;\nlet y = 1;\n".to_string();
        file_write(target.clone(), src.clone(), false)
            .await
            .expect("write");

        // Mismatched expectation: find=1 appears twice, expect=1 → reject.
        let err = file_edit(target.clone(), "1".into(), "2".into(), Some(1))
            .await
            .expect_err("should reject on mismatch");
        assert!(err.contains("expected 1"), "unexpected err: {err}");

        // File must be untouched.
        let still = file_read_text(target.clone(), None).await.expect("read");
        assert_eq!(still, src);

        // Unique pattern → expect=1 succeeds.
        let r = file_edit(target.clone(), "let x".into(), "let a".into(), Some(1))
            .await
            .expect("edit");
        assert_eq!(r.replacements, 1);

        let after = file_read_text(target, None).await.expect("read");
        assert_eq!(after, "let a = 1;\nlet y = 1;\n");
    }

    #[tokio::test]
    async fn delete_removes_file() {
        let s = Scratch::new("delete");
        let target = s.join("goodbye.txt");
        file_write(target.clone(), "bye".into(), false)
            .await
            .expect("write");

        let before = file_exists(target.clone()).await.expect("exists");
        assert!(before.exists && before.is_file);

        file_delete(target.clone()).await.expect("delete");

        let after = file_exists(target).await.expect("exists");
        assert!(!after.exists);
    }

    #[tokio::test]
    async fn mkdir_recursive_creates_parents() {
        let s = Scratch::new("mkdir");
        let nested = s.join("a/b/c/d");

        file_mkdir(nested.clone(), true).await.expect("mkdir -p");

        let info = file_exists(nested).await.expect("exists");
        assert!(info.exists);
        assert!(info.is_dir);
        assert!(!info.is_file);
    }

    #[tokio::test]
    async fn exists_reports_correct_fields() {
        let s = Scratch::new("exists");
        let missing = s.join("nope.txt");
        let present = s.join("yes.txt");
        let subdir = s.join("sub");

        // Missing.
        let m = file_exists(missing).await.expect("stat missing");
        assert!(!m.exists);
        assert_eq!(m.size, 0);
        assert_eq!(m.modified_secs, 0);

        // File.
        file_write(present.clone(), "abc".into(), false)
            .await
            .expect("write");
        let f = file_exists(present).await.expect("stat file");
        assert!(f.exists);
        assert!(f.is_file);
        assert!(!f.is_dir);
        assert_eq!(f.size, 3);
        assert!(f.modified_secs > 0);

        // Directory.
        file_mkdir(subdir.clone(), false).await.expect("mkdir");
        let d = file_exists(subdir).await.expect("stat dir");
        assert!(d.exists);
        assert!(d.is_dir);
        assert!(!d.is_file);
    }
}

// === REGISTER IN lib.rs ===
// mod filesys;
// #[tauri::command]s: file_write, file_append, file_read_text, file_edit, file_delete, file_rename, file_mkdir, file_exists
// invoke_handler: same names
// No new Cargo deps.
// === END REGISTER ===
