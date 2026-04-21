//! Computer control — open apps, run shell, AppleScript, notifications.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

use crate::safety_paths;

/// Hard cap on a single `run_shell` invocation. The agent loop generally
/// issues short commands; anything longer-running should go through the
/// PTY agent (`pty_agent_*`) which is designed for streaming/interactive
/// processes and has its own timeouts.
const RUN_SHELL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug, TS)]
#[ts(export)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    /// Wire name is `exit_code` — frontend consumers (ConsolePage, CodePage,
    /// etc.) already read it that way. Kept as `code` in Rust for brevity
    /// and so existing callers inside the crate aren't forced to rename.
    #[serde(rename = "exit_code")]
    #[ts(rename = "exit_code")]
    pub code: i32,
}

pub async fn open_app(name: String) -> Result<(), String> {
    Command::new("open")
        .arg("-a")
        .arg(&name)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

pub async fn open_path(path: String) -> Result<(), String> {
    let expanded = safety_paths::expand_home(&path)?;
    safety_paths::assert_read_allowed(&expanded)?;
    // Fire the codesign tripwire so the Security module records any
    // unsigned binary we're about to launch. Non-blocking — the
    // actual verify runs on a background task.
    crate::security::watchers::codesign::probe(
        &expanded.to_string_lossy(),
        "control::open_path",
    );
    Command::new("open")
        .arg(&expanded)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

/// Open an external URL in the user's default browser via `/usr/bin/open`.
///
/// Separated from `open_path` because the filesystem-safety pipeline
/// (expand-home / assert-read-allowed) doesn't apply to a URL string and
/// would either reject or silently canonicalize it into nonsense.
///
/// We allowlist three schemes — anything else is refused:
///   * `http://` / `https://` — external links (API dashboards, docs).
///   * `x-apple.systempreferences:` — deep-link into a specific macOS
///     Privacy pane. Settings → PERMISSIONS needs this; no other scheme
///     reliably lands on the right sub-pane across macOS 13 → 15.
///
/// A compromised component can't use us to launch `file://`,
/// `javascript:`, custom app schemes, or shell-escape tricks — the
/// allowlist + `Command::arg` (no shell interpolation) are the gates.
pub async fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("x-apple.systempreferences:");
    if !allowed {
        return Err(format!("open_url blocked: unsupported scheme in {trimmed:?}"));
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("open_url blocked: control chars in URL".into());
    }
    Command::new("open")
        .arg(trimmed)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

pub async fn run_shell(cmd: String) -> Result<ShellResult, String> {
    if cmd.trim().is_empty() {
        return Err("shell blocked: empty command".into());
    }
    if let Some(reason) = safety_paths::is_dangerous_shell_snippet(&cmd) {
        return Err(format!("shell blocked: {reason}"));
    }
    let fut = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(&cmd)
        .kill_on_drop(true)
        .output();
    let output = match timeout(RUN_SHELL_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("shell: {e}")),
        Err(_) => return Err(format!(
            "shell timed out after {}s — long-running commands should use pty_agent_*",
            RUN_SHELL_TIMEOUT.as_secs(),
        )),
    };
    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

pub async fn applescript(script: String) -> Result<String, String> {
    if script.trim().is_empty() {
        return Err("applescript blocked: empty script".into());
    }
    if let Some(reason) = safety_paths::is_dangerous_applescript(&script) {
        return Err(format!("applescript blocked: {reason}"));
    }
    let fut = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .kill_on_drop(true)
        .output();
    let output = match timeout(RUN_SHELL_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript: {e}")),
        Err(_) => return Err(format!(
            "osascript timed out after {}s",
            RUN_SHELL_TIMEOUT.as_secs(),
        )),
    };
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export)]
pub struct AppEntry {
    pub name: String,
    pub path: String,
}

pub fn list_apps() -> Vec<AppEntry> {
    let mut apps = Vec::new();
    for dir in ["/Applications", "/System/Applications"] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.ends_with(".app") {
                        apps.push(AppEntry {
                            name: name.trim_end_matches(".app").to_string(),
                            path: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[derive(Serialize, Deserialize, Debug, TS)]
#[ts(export)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub modified_secs: i64,
}

pub fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    use std::time::UNIX_EPOCH;
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_read_allowed(&p)?;

    let read = std::fs::read_dir(&p).map_err(|e| format!("read_dir: {e}"))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified_secs: modified,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Extra filesystem operations used by the FILES module UI. All go through
// `safety_paths` for read/write/delete allow-list enforcement.
// ---------------------------------------------------------------------------

/// Read a text file, capped at `max_bytes` (defaults to 256 KiB). Refuses
/// to decode obviously binary content (NUL byte in the first 4 KiB) so the
/// preview pane never renders gibberish.
#[derive(Serialize, Deserialize, Debug, TS)]
#[ts(export)]
pub struct FsReadText {
    pub content: String,
    pub truncated: bool,
    #[ts(type = "number")]
    pub total_size: u64,
    pub is_binary: bool,
}

pub fn fs_read_text(path: String, max_bytes: Option<u64>) -> Result<FsReadText, String> {
    use std::io::Read;
    let cap = max_bytes.unwrap_or(256 * 1024).min(4 * 1024 * 1024);
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_read_allowed(&p)?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
    if meta.is_dir() {
        return Err("fs_read_text: path is a directory".into());
    }
    let total = meta.len();
    let mut f = std::fs::File::open(&p).map_err(|e| format!("open: {e}"))?;
    let mut buf = vec![0u8; cap as usize];
    let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
    buf.truncate(n);
    let probe_end = n.min(4096);
    let is_binary = buf[..probe_end].contains(&0u8);
    let content = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };
    Ok(FsReadText {
        content,
        truncated: (n as u64) < total,
        total_size: total,
        is_binary,
    })
}

/// Create a directory (recursively).
pub fn fs_mkdir(path: String) -> Result<(), String> {
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_write_allowed(&p)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir: {e}"))
}

/// Create a new file. Fails if the target already exists (the caller picks a
/// unique name) so we never silently clobber a file.
pub fn fs_new_file(path: String, contents: Option<String>) -> Result<(), String> {
    use std::io::Write;
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_write_allowed(&p)?;
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
        }
    }
    let mut f = std::fs::File::create(&p).map_err(|e| format!("create: {e}"))?;
    if let Some(body) = contents {
        f.write_all(body.as_bytes()).map_err(|e| format!("write: {e}"))?;
    }
    Ok(())
}

/// Rename / move a file or directory. Both paths must be writeable.
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    let a = safety_paths::expand_home(&from)?;
    let b = safety_paths::expand_home(&to)?;
    safety_paths::assert_write_allowed(&a)?;
    safety_paths::assert_write_allowed(&b)?;
    if b.exists() {
        return Err(format!("destination exists: {}", b.display()));
    }
    std::fs::rename(&a, &b).map_err(|e| format!("rename: {e}"))
}

/// Copy a file or directory tree. Cross-filesystem safe (unlike `rename`).
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    let a = safety_paths::expand_home(&from)?;
    let b = safety_paths::expand_home(&to)?;
    safety_paths::assert_read_allowed(&a)?;
    safety_paths::assert_write_allowed(&b)?;
    if b.exists() {
        return Err(format!("destination exists: {}", b.display()));
    }
    let meta = std::fs::metadata(&a).map_err(|e| format!("stat: {e}"))?;
    if meta.is_dir() {
        copy_dir_recursive(&a, &b).map_err(|e| format!("copy_dir: {e}"))?;
    } else {
        if let Some(parent) = b.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
            }
        }
        std::fs::copy(&a, &b).map_err(|e| format!("copy: {e}"))?;
    }
    Ok(())
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Move a file or folder to the macOS Trash via Finder AppleScript. Preferred
/// over `rm` because it stays undoable and plays nicely with Finder's UI.
pub async fn fs_trash(path: String) -> Result<(), String> {
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_delete_allowed(&p)?;
    let abs = p.to_string_lossy().into_owned();
    // POSIX path -> Finder item -> move to trash. Quote the path via
    // AppleScript string quoting (double any embedded quotes).
    let escaped = abs.replace('"', "\\\"");
    let script = format!(
        "tell application \"Finder\" to delete (POSIX file \"{}\" as alias)",
        escaped
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .await
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

/// Compute total size of a directory tree. Bounded by `max_entries` so the
/// UI can't accidentally stall on huge trees (default 50k entries).
#[derive(Serialize, Deserialize, Debug, TS)]
#[ts(export)]
pub struct FsDirSize {
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub files: u64,
    #[ts(type = "number")]
    pub dirs: u64,
    pub truncated: bool,
}

pub fn fs_dir_size(path: String, max_entries: Option<u64>) -> Result<FsDirSize, String> {
    let cap = max_entries.unwrap_or(50_000);
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_read_allowed(&p)?;
    let mut total: u64 = 0;
    let mut files: u64 = 0;
    let mut dirs: u64 = 0;
    let mut visited: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![p];
    while let Some(cur) = stack.pop() {
        if visited >= cap {
            return Ok(FsDirSize { size: total, files, dirs, truncated: true });
        }
        let rd = match std::fs::read_dir(&cur) { Ok(r) => r, Err(_) => continue };
        for entry in rd.flatten() {
            visited += 1;
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() {
                dirs += 1;
                stack.push(entry.path());
            } else {
                files += 1;
                total += meta.len();
            }
            if visited >= cap {
                return Ok(FsDirSize { size: total, files, dirs, truncated: true });
            }
        }
    }
    Ok(FsDirSize { size: total, files, dirs, truncated: false })
}

/// Recursive name search under `root`. Matches on lowercase substring. Bounded
/// by `max_results` (default 500) and `max_visited` (default 50k) so the walk
/// always terminates on a huge tree.
pub fn fs_search(
    root: String,
    query: String,
    max_results: Option<usize>,
    max_visited: Option<u64>,
) -> Result<Vec<FsEntry>, String> {
    use std::time::UNIX_EPOCH;
    let hits_cap = max_results.unwrap_or(500).max(1);
    let visit_cap = max_visited.unwrap_or(50_000);
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let start = safety_paths::expand_home(&root)?;
    safety_paths::assert_read_allowed(&start)?;

    let mut out: Vec<FsEntry> = Vec::new();
    let mut visited: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![start];
    while let Some(cur) = stack.pop() {
        if out.len() >= hits_cap || visited >= visit_cap {
            break;
        }
        let rd = match std::fs::read_dir(&cur) { Ok(r) => r, Err(_) => continue };
        for entry in rd.flatten() {
            visited += 1;
            if visited >= visit_cap { break; }
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skip dotfile descent — searching all of ~ through .cache is hostile.
            let is_hidden = name.starts_with('.');
            if meta.is_dir() && !is_hidden {
                stack.push(entry.path());
            }
            if name.to_lowercase().contains(&needle) {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                out.push(FsEntry {
                    name,
                    path: entry.path().to_string_lossy().into_owned(),
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                    modified_secs: modified,
                });
                if out.len() >= hits_cap { break; }
            }
        }
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Reveal a path in Finder (selects the item in its parent folder). Falls
/// back to `open_path` when the path is a directory with no parent.
pub async fn fs_reveal(path: String) -> Result<(), String> {
    let p = safety_paths::expand_home(&path)?;
    safety_paths::assert_read_allowed(&p)?;
    Command::new("open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(|e| format!("open -R: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// App control — reveal / quit / hide. Scoped to the two app roots we
// enumerate (`/Applications` + `/System/Applications`) so these don't turn
// into arbitrary shell escape hatches.
// ---------------------------------------------------------------------------

fn validate_app_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() { return Err("app name empty".into()); }
    if trimmed.len() > 80 { return Err("app name too long".into()); }
    if trimmed.chars().any(|c| c == '"' || c == '\\' || c == '\n' || c == '\r') {
        return Err("app name contains illegal character".into());
    }
    Ok(())
}

/// Hide an app's windows without quitting it (`⌘H` equivalent). The graceful
/// "quit" path and Finder reveal already live in `tools_macos` (`app_quit`,
/// `finder_reveal`); we only add the missing "hide" verb here.
pub async fn app_hide(name: String) -> Result<(), String> {
    validate_app_name(&name)?;
    let script = format!(
        "tell application \"System Events\" to set visible of process \"{}\" to false",
        name
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .await
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}
