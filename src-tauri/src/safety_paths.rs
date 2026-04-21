//! Path-safety helpers shared across filesys, daemons, and future tools.
//!
//! Centralizes:
//!   * home expansion (`~` / `~/...`)
//!   * best-effort canonicalization for not-yet-existing paths
//!   * write / read / delete allow-list enforcement
//!   * a quick heuristic for obviously dangerous shell snippets
//!
//! Pure lib module — no Tauri commands, no new deps.

use std::path::{Component, Path, PathBuf};

// ---------------------------------------------------------------------------
// Constants — deny lists
// ---------------------------------------------------------------------------

/// Top-level system directories where writes are always denied.
/// Note: `/Applications` is allowed for read/open but NOT for writes.
const WRITE_DENY_TOP_LEVEL: &[&str] = &[
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/private",
    "/var",
];

/// Filesystem roots that are always readable even though they are outside $HOME.
fn sandbox_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        home.join("Library/Application Support/ai.kinglystudio.sunny"),
        home.join(".sunny"),
    ]
}

/// Sensitive files that must never be read, even though /etc may otherwise
/// be readable in some flows.
const READ_DENY_FILES: &[&str] = &[
    "/etc/sudoers",
    "/etc/shadow",
    "/etc/master.passwd",
    "/var/root",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Expand a leading `~` to `$HOME`. Leaves non-tilde input unchanged.
pub fn expand_home(path: &str) -> Result<PathBuf, String> {
    if path == "~" {
        return home_dir().map_err(|e| format!("home directory unavailable: {}", e));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = home_dir().map_err(|e| format!("home directory unavailable: {}", e))?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(path))
}

/// Canonicalize `path`. When the path doesn't exist yet (common for new file
/// writes), walk upward until we hit an existing ancestor, canonicalize that,
/// then re-append the non-existent tail. This avoids the `std::fs::canonicalize`
/// failure mode while still resolving any symlink trickery above the new leaf.
pub fn canonicalize_best_effort(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };

    if let Ok(resolved) = std::fs::canonicalize(&absolute) {
        return resolved;
    }

    // Walk up until we find an existing ancestor.
    let mut tail: Vec<PathBuf> = Vec::new();
    let mut cursor = absolute.clone();
    loop {
        if let Ok(resolved) = std::fs::canonicalize(&cursor) {
            let mut out = resolved;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return normalize_lexical(&out);
        }
        match (cursor.file_name().map(|s| s.to_os_string()), cursor.parent().map(|p| p.to_path_buf())) {
            (Some(name), Some(parent)) => {
                tail.push(PathBuf::from(name));
                cursor = parent;
            }
            _ => {
                // Reached the root with nothing canonicalizable — fall back to
                // a lexical normalization of the original path.
                return normalize_lexical(&absolute);
            }
        }
    }
}

/// Returns `Ok(())` if `path` is safe to write. Denies system directories and
/// anything outside the user's home unless the path sits inside an allowed
/// sandbox root (`/tmp`, `/private/tmp`, App Support dir, `~/.sunny`).
pub fn assert_write_allowed(path: &Path) -> Result<(), String> {
    let resolved = canonicalize_best_effort(path);
    let display = resolved.display().to_string();

    if resolved.as_os_str().is_empty() || resolved == Path::new("/") {
        return Err("/ denied: refusing to write to filesystem root".to_string());
    }

    let home = match home_dir() {
        Ok(h) => h,
        Err(_) => {
            return Err(format!("{} denied: home directory unavailable", display));
        }
    };

    // Allow-list first. Some sandbox roots are nested inside otherwise-denied
    // system directories (eg `/tmp` resolves to `/private/tmp` on macOS, and
    // `/private` is on the deny list), so we must greenlight them before the
    // deny sweep.
    for root in sandbox_roots(&home) {
        if resolved.starts_with(&root) {
            return Ok(());
        }
    }

    for deny in WRITE_DENY_TOP_LEVEL {
        let deny_path = Path::new(deny);
        if resolved == deny_path || resolved.starts_with(deny_path) {
            return Err(format!("{} denied: system directory is write-protected", display));
        }
    }

    if resolved.starts_with(&home) {
        return Ok(());
    }

    Err(format!(
        "{} denied: path is outside $HOME and allowed sandbox roots",
        display
    ))
}

/// Returns `Ok(())` if `path` is safe to read. More permissive than writes:
/// anything in `$HOME` or the sandbox roots is fine; a small blocklist of
/// credential files is always denied.
pub fn assert_read_allowed(path: &Path) -> Result<(), String> {
    let resolved = canonicalize_best_effort(path);
    let display = resolved.display().to_string();

    // Credential deny-list first — these win over any sandbox allow.
    for deny in READ_DENY_FILES {
        let deny_path = Path::new(deny);
        if resolved == deny_path || resolved.starts_with(deny_path) {
            return Err(format!("{} denied: sensitive credential file", display));
        }
    }

    let home = match home_dir() {
        Ok(h) => h,
        Err(_) => {
            return Err(format!("{} denied: home directory unavailable", display));
        }
    };

    if resolved.starts_with(&home) {
        return Ok(());
    }

    for root in sandbox_roots(&home) {
        if resolved.starts_with(&root) {
            return Ok(());
        }
    }

    // Reads are intentionally more permissive than writes: the system deny
    // list (/System, /Library, etc.) exists to stop accidental writes, not
    // to hide read-only system content from the agent. Outside $HOME and
    // sandbox roots we still bail out so fs_list doesn't become an
    // unbounded machine-wide walker.
    Err(format!(
        "{} denied: path is outside $HOME and allowed sandbox roots",
        display
    ))
}

/// Like `assert_write_allowed`, but ALSO refuses to delete the whole-user
/// landmarks (`$HOME`, `~/Documents`, `~/Desktop`, `~/Downloads`). Deleting
/// individual files inside those directories is fine.
pub fn assert_delete_allowed(path: &Path) -> Result<(), String> {
    assert_write_allowed(path)?;

    let resolved = canonicalize_best_effort(path);
    let display = resolved.display().to_string();

    let home = home_dir().map_err(|e| format!("{} denied: {}", display, e))?;

    let protected: [PathBuf; 4] = [
        home.clone(),
        home.join("Documents"),
        home.join("Desktop"),
        home.join("Downloads"),
    ];

    for guarded in protected.iter() {
        if &resolved == guarded {
            return Err(format!(
                "{} denied: refusing to delete a top-level user directory",
                display
            ));
        }
    }

    Ok(())
}

/// Fast, coarse heuristic over raw AppleScript text. Blocks the most common
/// AppleScript escape hatches: `do shell script` (which would bypass the
/// shell preflight) and obvious system-destroying osascript idioms. NOT a
/// parser — just defense in depth, same spirit as is_dangerous_shell_snippet.
///
/// `do shell script` is blocked unconditionally — all variants, including
/// those without `with administrator privileges`. Any legitimate shell need
/// must be routed through `run_shell` so the shell preflight applies.
pub fn is_dangerous_applescript(script: &str) -> Option<String> {
    let lower = script.to_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();

    // Block ALL `do shell script` variants — the presence of shell access via
    // AppleScript bypasses the shell preflight entirely, regardless of whether
    // administrator privileges are requested. Route through run_shell instead.
    if compact.contains("doshellscript") {
        return Some(
            "AppleScript `do shell script` is unconditionally blocked —              route shell commands through run_shell for preflight checks"
                .into(),
        );
    }
    // Common AppleScript idioms for wiping disks or shutting down without
    // the user's knowledge.
    if lower.contains("tell application \"finder\" to empty trash") && lower.contains("security") {
        return Some("secure-empty-trash via AppleScript detected".into());
    }
    if lower.contains("shut down") || lower.contains("restart computer") || lower.contains("log out") {
        if !lower.contains("display dialog") {
            return Some("silent shutdown/restart/logout via AppleScript detected".into());
        }
    }
    None
}

/// Fast, coarse heuristic over raw shell text. Returns `Some(reason)` for
/// classic catastrophic patterns. NOT a parser — just defense in depth.
pub fn is_dangerous_shell_snippet(cmd: &str) -> Option<String> {
    let lower = cmd.to_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();

    // rm -rf against root / home
    if contains_rm_rf_target(&lower, "/") {
        return Some("rm -rf / detected".into());
    }
    if contains_rm_rf_target(&lower, "~") {
        return Some("rm -rf ~ detected".into());
    }
    if contains_rm_rf_target(&lower, "$home") {
        return Some("rm -rf $HOME detected".into());
    }

    // Raw disk writes
    if lower.contains("dd if=") {
        return Some("dd if= disk write detected".into());
    }
    if lower.contains("/dev/sda") || lower.contains("/dev/nvme") || lower.contains("/dev/disk") {
        return Some("raw block device reference detected".into());
    }
    if lower.contains("mkfs") {
        return Some("mkfs filesystem format detected".into());
    }

    // File truncation shortcut `: >` or `:>`
    if compact.contains(":>") {
        return Some(":> truncation redirect detected".into());
    }

    // Classic bash fork bomb — match both whitespace-stripped and raw forms.
    if compact.contains(":(){:|:&};:") || lower.contains(":(){ :|:& };:") {
        return Some("fork bomb pattern detected".into());
    }

    None
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())
}

/// Lexical-only normalization: resolves `.` and `..` components without
/// touching the filesystem. Used as a last-resort fallback when nothing on
/// the path can be canonicalized.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if let Some(last) = out.last() {
                    if !matches!(last, Component::RootDir | Component::Prefix(_)) {
                        out.pop();
                        continue;
                    }
                }
                out.push(comp);
            }
            other => out.push(other),
        }
    }
    let mut buf = PathBuf::new();
    for c in out {
        buf.push(c.as_os_str());
    }
    if buf.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        buf
    }
}

/// True if `haystack` contains `rm -rf <target>` (with optional flag variants
/// like `-Rf`, `-fr`, `--force --recursive`). The target must appear as a
/// standalone token (whitespace- or quote-bounded).
fn contains_rm_rf_target(haystack: &str, target: &str) -> bool {
    let variants = ["rm -rf", "rm -fr", "rm -r -f", "rm -f -r", "rm -rf ", "rm -Rf"];
    // Simpler: look for "rm " followed by flags containing both r and f, then target.
    let bytes = haystack.as_bytes();
    let needle = "rm";
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &haystack[i..i + needle.len()] == needle {
            // Must be at start or preceded by whitespace/;/&/|
            let ok_prefix = i == 0
                || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b';' | b'&' | b'|');
            if ok_prefix {
                let rest = &haystack[i + needle.len()..];
                if let Some(tail) = rest.strip_prefix(' ') {
                    if let Some((flags_and_target, _)) = split_rm_tail(tail) {
                        if has_rf_flags(&flags_and_target.flags)
                            && flags_and_target.targets.iter().any(|t| t == target)
                        {
                            return true;
                        }
                    }
                }
            }
        }
        i += 1;
    }
    // Also catch the canonical literal forms for robustness.
    for v in variants {
        if let Some(idx) = haystack.find(v) {
            let after = &haystack[idx + v.len()..];
            let trimmed = after.trim_start();
            for tok in trimmed.split_whitespace() {
                let cleaned = tok.trim_matches(|c: char| c == '"' || c == '\'' || c == ';');
                if cleaned == target {
                    return true;
                }
                break;
            }
        }
    }
    false
}

struct RmTail {
    flags: String,
    targets: Vec<String>,
}

fn split_rm_tail(tail: &str) -> Option<(RmTail, usize)> {
    // Split tail (the argv after `rm `) into flag tokens (start with '-') and
    // remaining targets until we hit a shell separator.
    let mut flags = String::new();
    let mut targets: Vec<String> = Vec::new();
    for tok in tail.split_whitespace() {
        if matches!(tok, ";" | "&&" | "||" | "|") {
            break;
        }
        if let Some(flag) = tok.strip_prefix("--") {
            flags.push_str(flag);
        } else if let Some(flag) = tok.strip_prefix('-') {
            flags.push_str(flag);
        } else {
            let cleaned: String = tok
                .trim_matches(|c: char| c == '"' || c == '\'' || c == ';')
                .to_string();
            targets.push(cleaned);
        }
    }
    Some((RmTail { flags, targets }, 0))
}

fn has_rf_flags(flags: &str) -> bool {
    let lower = flags.to_lowercase();
    let has_r = lower.contains('r') || lower.contains("recursive");
    let has_f = lower.contains('f') || lower.contains("force");
    has_r && has_f
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        dirs::home_dir().expect("home dir in tests")
    }

    // ---- expand_home ------------------------------------------------------

    #[test]
    fn expand_home_bare_tilde() {
        let got = expand_home("~").expect("expand ~");
        assert_eq!(got, home());
    }

    #[test]
    fn expand_home_with_subpath() {
        let got = expand_home("~/Documents").expect("expand ~/Documents");
        assert_eq!(got, home().join("Documents"));
    }

    #[test]
    fn expand_home_non_tilde_unchanged() {
        let got = expand_home("/tmp/foo").expect("no-op");
        assert_eq!(got, PathBuf::from("/tmp/foo"));
    }

    #[test]
    fn expand_home_relative_unchanged() {
        let got = expand_home("relative/path").expect("no-op");
        assert_eq!(got, PathBuf::from("relative/path"));
    }

    // ---- canonicalize_best_effort ----------------------------------------

    #[test]
    fn canonicalize_walks_up_for_nonexistent_file() {
        // /tmp exists on macOS; child does not.
        let ghost = PathBuf::from("/tmp/__safety_paths_no_such_dir__/child/leaf.txt");
        let resolved = canonicalize_best_effort(&ghost);
        // On macOS /tmp canonicalizes to /private/tmp, so we check the suffix.
        let s = resolved.to_string_lossy().to_string();
        assert!(
            s.ends_with("__safety_paths_no_such_dir__/child/leaf.txt"),
            "expected tail preserved, got {}",
            s
        );
    }

    #[test]
    fn canonicalize_existing_path_resolves() {
        let resolved = canonicalize_best_effort(Path::new("/tmp"));
        // Must produce an absolute path.
        assert!(resolved.is_absolute());
    }

    // ---- assert_write_allowed --------------------------------------------

    #[test]
    fn write_denies_root() {
        let err = assert_write_allowed(Path::new("/")).unwrap_err();
        assert!(err.contains("denied"), "err: {}", err);
    }

    #[test]
    fn write_denies_etc() {
        let err = assert_write_allowed(Path::new("/etc/hosts")).unwrap_err();
        assert!(err.to_lowercase().contains("denied"));
    }

    #[test]
    fn write_denies_system() {
        let err = assert_write_allowed(Path::new("/System/Library/foo")).unwrap_err();
        assert!(err.to_lowercase().contains("denied"));
    }

    #[test]
    fn write_allows_home_downloads() {
        let p = home().join("Downloads").join("x.txt");
        assert!(assert_write_allowed(&p).is_ok());
    }

    #[test]
    fn write_allows_tmp() {
        assert!(assert_write_allowed(Path::new("/tmp/x.txt")).is_ok());
    }

    #[test]
    fn write_allows_sunny_settings() {
        let p = home().join(".sunny").join("settings.json");
        assert!(assert_write_allowed(&p).is_ok());
    }

    // ---- assert_read_allowed ---------------------------------------------

    #[test]
    fn read_denies_sudoers() {
        let err = assert_read_allowed(Path::new("/etc/sudoers")).unwrap_err();
        assert!(err.to_lowercase().contains("denied"));
    }

    #[test]
    fn read_allows_home_anything() {
        let p = home().join("Downloads").join("something.pdf");
        assert!(assert_read_allowed(&p).is_ok());
    }

    // ---- assert_delete_allowed -------------------------------------------

    #[test]
    fn delete_denies_home_itself() {
        let err = assert_delete_allowed(&home()).unwrap_err();
        assert!(err.to_lowercase().contains("denied"));
    }

    #[test]
    fn delete_denies_documents_dir() {
        let err = assert_delete_allowed(&home().join("Documents")).unwrap_err();
        assert!(err.to_lowercase().contains("denied"));
    }

    #[test]
    fn delete_allows_file_inside_documents() {
        let p = home().join("Documents").join("foo.txt");
        assert!(assert_delete_allowed(&p).is_ok());
    }

    // ---- is_dangerous_shell_snippet --------------------------------------

    #[test]
    fn shell_detects_rm_rf_root() {
        assert!(is_dangerous_shell_snippet("rm -rf /").is_some());
    }

    #[test]
    fn shell_detects_rm_rf_home_tilde() {
        assert!(is_dangerous_shell_snippet("rm -rf ~").is_some());
    }

    #[test]
    fn shell_detects_rm_rf_home_var() {
        assert!(is_dangerous_shell_snippet("rm -rf $HOME").is_some());
    }

    #[test]
    fn shell_detects_dd_if() {
        assert!(is_dangerous_shell_snippet("dd if=/dev/zero of=/dev/sda").is_some());
    }

    #[test]
    fn shell_detects_fork_bomb() {
        assert!(is_dangerous_shell_snippet(":(){ :|:& };:").is_some());
    }

    #[test]
    fn shell_detects_mkfs() {
        assert!(is_dangerous_shell_snippet("mkfs.ext4 /dev/sda1").is_some());
    }

    #[test]
    fn shell_detects_truncate_redirect() {
        assert!(is_dangerous_shell_snippet(":> /etc/hosts").is_some());
    }

    #[test]
    fn shell_allows_normal_command() {
        assert!(is_dangerous_shell_snippet("ls -la ~/Downloads").is_none());
        assert!(is_dangerous_shell_snippet("rm -i foo.txt").is_none());
    }

    // ---- is_dangerous_applescript ----------------------------------------

    #[test]
    fn applescript_blocks_do_shell_script_unconditionally() {
        // Plain `do shell script` must be blocked even without admin privileges.
        assert!(
            is_dangerous_applescript(r#"do shell script "echo hello""#).is_some(),
            "plain do shell script should be blocked"
        );
        // Admin variant must also be blocked.
        assert!(
            is_dangerous_applescript(
                r#"do shell script "rm -rf /tmp/x" with administrator privileges"#
            )
            .is_some(),
            "admin do shell script should be blocked"
        );
        // Whitespace variations must not bypass the check.
        assert!(
            is_dangerous_applescript("do  shell  script \"ls\"").is_some(),
            "whitespace-padded do shell script should be blocked"
        );
    }

    #[test]
    fn applescript_allows_safe_scripts() {
        // A tell block that doesn't invoke shell should pass.
        assert!(
            is_dangerous_applescript(
                r#"tell application "Finder" to open POSIX file "/tmp/foo.txt""#
            )
            .is_none(),
            "safe Finder tell should not be blocked"
        );
        // Display dialog is allowed.
        assert!(
            is_dangerous_applescript(r#"display dialog "Hello" buttons {"OK"}"#).is_none(),
            "display dialog should not be blocked"
        );
    }
}

// === REGISTER IN lib.rs ===
// mod safety_paths;
// (No Tauri commands — this is a pure lib module consumed by filesys, daemons, etc.)
// No new deps.
// === END REGISTER ===
