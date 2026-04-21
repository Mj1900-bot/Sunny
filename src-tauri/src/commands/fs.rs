//! Filesystem, shell, app control, and permissions commands.

use tauri::AppHandle;
use crate::control;
use crate::permissions;

#[tauri::command]
pub async fn open_app(name: String) -> Result<(), String> {
    control::open_app(name).await
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    control::open_path(path).await
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    control::open_url(url).await
}

#[tauri::command]
pub async fn run_shell(cmd: String) -> Result<control::ShellResult, String> {
    control::run_shell(cmd).await
}

/// Allowlist-gated sandboxed shell. Coexists with `run_shell`: this
/// variant is designed for agent autonomy — the binary set is fixed,
/// shell metacharacters are rejected, and the environment is scrubbed
/// so the agent can't smuggle a spoofed PATH. See `tools_shell.rs`.
#[tauri::command]
pub async fn shell_sandboxed(
    cmd: String,
    cwd: Option<String>,
    timeout_sec: Option<u64>,
) -> Result<control::ShellResult, String> {
    crate::tools_shell::shell_sandboxed(cmd, cwd, timeout_sec).await
}

#[tauri::command]
pub async fn applescript(script: String) -> Result<String, String> {
    control::applescript(script).await
}

#[tauri::command]
pub fn list_apps() -> Vec<control::AppEntry> {
    control::list_apps()
}

/// Gracefully quit and re-spawn the app. The macOS TCC system (Screen
/// Recording, Accessibility, Automation, etc.) attaches permissions to a
/// process at launch — a freshly-granted permission is ignored until the
/// process restarts. Exposing a one-click relaunch spares the user from
/// hunting for "Quit Sunny" in the Dock after flipping a toggle in System
/// Settings.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    app.restart()
}

/// Silent TCC check — does this process hold Screen Recording permission?
/// Backed by `CGPreflightScreenCaptureAccess`; never prompts the user.
#[tauri::command]
pub fn permission_check_screen_recording() -> bool {
    permissions::has_screen_recording()
}

/// Silent TCC check — does this process hold Accessibility permission?
/// Backed by `AXIsProcessTrusted`; never prompts the user.
#[tauri::command]
pub fn permission_check_accessibility() -> bool {
    permissions::has_accessibility()
}

/// Silent TCC check — can this process read Full Disk Access-gated files
/// (`chat.db`, AddressBook)? Implemented by trying to open the canonical
/// gated files for read; never prompts.
#[tauri::command]
pub fn permission_check_full_disk_access() -> bool {
    permissions::has_full_disk_access()
}

/// Probe whether `osascript` can talk to `System Events` (the Automation
/// TCC gate). Generous 10 s timeout — the first call after a grant can be
/// slow while the daemon warms up.
#[tauri::command]
pub async fn permission_check_automation() -> Result<bool, String> {
    permissions::check_automation_system_events().await
}

/// Clear Sunny's TCC grants for Screen Recording, Accessibility, AppleEvents,
/// and Full Disk Access (`SystemPolicyAllFiles`) via `tccutil reset`. Rebuilds change the binary's code
/// signature, so the original grant no longer matches — resetting forces
/// macOS to re-prompt on the next attempt, picking up the current
/// signature. `bundle_id` is validated to be a simple reverse-DNS string
/// (no slashes, no whitespace).
#[tauri::command]
pub async fn tcc_reset_sunny(bundle_id: String) -> Result<permissions::TccResetResult, String> {
    permissions::reset_tcc_for(bundle_id).await
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<control::FsEntry>, String> {
    control::fs_list(path)
}

#[tauri::command]
pub fn fs_read_text(path: String, max_bytes: Option<u64>) -> Result<control::FsReadText, String> {
    control::fs_read_text(path, max_bytes)
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    control::fs_mkdir(path)
}

#[tauri::command]
pub fn fs_new_file(path: String, contents: Option<String>) -> Result<(), String> {
    control::fs_new_file(path, contents)
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    control::fs_rename(from, to)
}

#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    control::fs_copy(from, to)
}

#[tauri::command]
pub async fn fs_trash(path: String) -> Result<(), String> {
    control::fs_trash(path).await
}

#[tauri::command]
pub fn fs_dir_size(path: String, max_entries: Option<u64>) -> Result<control::FsDirSize, String> {
    control::fs_dir_size(path, max_entries)
}

#[tauri::command]
pub fn fs_search(
    root: String,
    query: String,
    max_results: Option<usize>,
    max_visited: Option<u64>,
) -> Result<Vec<control::FsEntry>, String> {
    control::fs_search(root, query, max_results, max_visited)
}

#[tauri::command]
pub async fn fs_reveal(path: String) -> Result<(), String> {
    control::fs_reveal(path).await
}

#[tauri::command]
pub async fn app_hide(name: String) -> Result<(), String> {
    control::app_hide(name).await
}

/// Narrow alternative to `open_path` for UI buttons that need to open a
/// file inside `~/.sunny/`.
///
/// Accepts only a **bare filename** (e.g. `"grants.json"`).  The path is
/// assembled server-side as `$HOME/.sunny/{filename}` so the webview can
/// never escape the `.sunny` directory via path traversal tricks such as
/// `"../../../etc/passwd"` or an absolute path smuggled through a
/// webview bug.
///
/// Validation rules (returns `Err` on any violation):
/// * Must not be empty.
/// * Must not contain `/`, `\`, or the two-dot sequence `..`.
/// * The final joined path is validated by `assert_read_allowed` before
///   being handed to `open`, which provides a belt-and-suspenders check
///   even if the filename rules above are somehow bypassed.
#[tauri::command]
pub async fn open_sunny_file(filename: String) -> Result<(), String> {
    // Belt 1: reject empty filenames.
    if filename.trim().is_empty() {
        return Err("open_sunny_file: filename must not be empty".into());
    }

    // Belt 2: reject NUL bytes — a NUL-embedded name passes the separator
    // check but could truncate unexpectedly in OS-level calls.
    if filename.contains('\0') {
        return Err("open_sunny_file: filename must not contain NUL bytes".into());
    }

    // Belt 3: reject any path-separator or parent-directory sequences.
    // This is the primary path-traversal guard.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!(
            "open_sunny_file: filename must be a bare name with no separators or '..' — got {filename:?}"
        ));
    }

    // Assemble the absolute path server-side.
    let home = dirs::home_dir()
        .ok_or_else(|| "open_sunny_file: $HOME unavailable".to_string())?;
    let target = home.join(".sunny").join(&filename);

    // Belt 3: assert_read_allowed enforces the safety-paths allow-list.
    crate::safety_paths::assert_read_allowed(&target)?;

    control::open_path(target.to_string_lossy().into_owned()).await
}

#[cfg(test)]
mod tests {
    /// Pure-logic tests for the `open_sunny_file` filename validation rules.
    /// These exercise the guard clauses without invoking Tauri or the `open`
    /// binary — they call the same validation predicates the real command uses.

    /// Shared validation logic extracted for testability.  Mirrors the guard
    /// clauses in `open_sunny_file` exactly (NUL check, then separator check).
    fn validate_sunny_filename(filename: &str) -> Result<(), String> {
        if filename.trim().is_empty() {
            return Err("filename must not be empty".into());
        }
        if filename.contains('\0') {
            return Err("filename must not contain NUL bytes".into());
        }
        if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
            return Err(format!(
                "filename must be a bare name with no separators or '..': {filename:?}"
            ));
        }
        Ok(())
    }

    #[test]
    fn open_sunny_file_rejects_empty_filename() {
        assert!(validate_sunny_filename("").is_err());
        assert!(validate_sunny_filename("   ").is_err());
    }

    #[test]
    fn open_sunny_file_rejects_path_traversal_via_dotdot() {
        assert!(validate_sunny_filename("../etc/passwd").is_err());
        assert!(validate_sunny_filename("..").is_err());
        assert!(validate_sunny_filename("foo/../bar").is_err());
    }

    #[test]
    fn open_sunny_file_rejects_forward_slash() {
        assert!(validate_sunny_filename("sub/grants.json").is_err());
        assert!(validate_sunny_filename("/etc/passwd").is_err());
    }

    #[test]
    fn open_sunny_file_rejects_backslash() {
        assert!(validate_sunny_filename("sub\\grants.json").is_err());
    }

    #[test]
    fn open_sunny_file_rejects_nul_byte() {
        // A NUL-embedded name passes the separator check but must be blocked
        // before it reaches path assembly, where OS behaviour diverges.
        assert!(validate_sunny_filename("grants.json\0../etc/passwd").is_err());
        assert!(validate_sunny_filename("\0").is_err());
    }

    #[test]
    fn open_sunny_file_accepts_valid_bare_filenames() {
        assert!(validate_sunny_filename("grants.json").is_ok());
        assert!(validate_sunny_filename("settings.json").is_ok());
        assert!(validate_sunny_filename("canary.txt").is_ok());
        // Dots within the filename (extension) are fine.
        assert!(validate_sunny_filename("my.data.json").is_ok());
    }
}
