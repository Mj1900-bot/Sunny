//! Path resolution for CLI tools that live outside the GUI-process PATH.
//!
//! macOS apps launched from Finder/Dock inherit a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`). Tools installed via nvm, Homebrew,
//! or asdf are invisible. We work around that by:
//!   1. Checking a curated list of well-known install locations.
//!   2. Falling back to an interactive login shell resolution
//!      (`/bin/zsh -lc 'command -v <bin>'`) which loads the user's
//!      ~/.zshenv/.zprofile/.zshrc and therefore has their full PATH.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

static CACHE: Mutex<Option<std::collections::HashMap<String, Option<PathBuf>>>> = Mutex::new(None);

pub fn which(bin: &str) -> Option<PathBuf> {
    {
        let guard = CACHE.lock().unwrap();
        if let Some(map) = guard.as_ref() {
            if let Some(cached) = map.get(bin) {
                return cached.clone();
            }
        }
    }

    let resolved = resolve(bin);

    let mut guard = CACHE.lock().unwrap();
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    map.insert(bin.to_string(), resolved.clone());
    resolved
}

fn resolve(bin: &str) -> Option<PathBuf> {
    // 1) Common install locations (cheap file checks).
    let candidates: Vec<PathBuf> = candidate_bin_dirs()
        .into_iter()
        .map(|d| d.join(bin))
        .collect();

    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }

    // 2) Login-shell fallback — lets user env (.zshrc etc) resolve it.
    if let Ok(out) = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(format!("command -v {bin}"))
        .output()
    {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).is_file() {
                return Some(PathBuf::from(path));
            }
        }
    }

    None
}

/// Directories we expect user-installed CLI tools to live in.
/// Also used to build a PATH env var for child processes so shebang-based
/// scripts (e.g. `#!/usr/bin/env node` for openclaw) can find their runtime.
fn candidate_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/opt/local/bin"),
    ];

    if let Some(home) = dirs::home_dir() {
        let nvm_root = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
            }
        }
        dirs.push(home.join(".volta").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
    }

    dirs
}

/// Merge the candidate directories into `PATH` and export it to this process.
/// Every child process spawned thereafter inherits the fat PATH, which lets
/// shebang scripts find `node`, `python3`, etc.
pub fn augment_process_path() {
    if let Some(p) = fat_path() {
        std::env::set_var("PATH", p);
    }
}

/// Fat PATH string: candidate bin dirs + whatever PATH was inherited.
/// Use this explicitly on `Command::env("PATH", ..)` for guaranteed coverage
/// regardless of process-level env mutation.
pub fn fat_path() -> Option<std::ffi::OsString> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut parts: Vec<PathBuf> = candidate_bin_dirs();
    // existing PATH may hold many entries joined by `:`, so split it before
    // re-joining — join_paths rejects any segment that contains a separator.
    for p in std::env::split_paths(&existing) {
        if !p.as_os_str().is_empty() {
            parts.push(p);
        }
    }
    std::env::join_paths(parts).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Tests mutate the process-wide PATH env var, so they must run serially.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Snapshot PATH, run a closure with `new_path` installed, restore PATH.
    fn with_path<F: FnOnce() -> R, R>(new_path: Option<&str>, f: F) -> R {
        let _g = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("PATH");
        match new_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        let out = f();
        match saved {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        out
    }

    #[test]
    fn fat_path_merges_candidate_dirs_with_existing_path() {
        let existing = "/a:/b:/c";
        let joined = with_path(Some(existing), || {
            fat_path().expect("fat_path should succeed")
        });
        let joined_str = joined.to_string_lossy().to_string();

        // Split by `:` and confirm no segment itself contains `:` — that was
        // the original bug: the whole existing PATH was pushed as one segment,
        // and join_paths rejected it.
        for seg in joined_str.split(':') {
            assert!(
                !seg.contains(':'),
                "segment {seg:?} contains separator — split was skipped"
            );
        }

        // Homebrew candidate must be present.
        assert!(
            joined_str.contains("/opt/homebrew/bin"),
            "missing homebrew bin in {joined_str}"
        );

        // Each existing entry shows up as its own segment.
        let segs: Vec<&str> = joined_str.split(':').collect();
        for expected in ["/a", "/b", "/c"] {
            assert!(
                segs.iter().any(|s| *s == expected),
                "expected segment {expected} not found in {segs:?}"
            );
        }
    }

    #[test]
    fn fat_path_splits_multi_entry_path_so_join_paths_accepts_it() {
        // Regression: the earlier bug pushed the entire existing PATH as a
        // single PathBuf, which std::env::join_paths rejects on unix because
        // the segment itself contains `:`. If that bug returned, fat_path()
        // would be None here.
        let joined = with_path(Some("/a:/b:/c"), || fat_path());
        assert!(
            joined.is_some(),
            "fat_path returned None — multi-entry PATH was not split"
        );
    }

    #[test]
    fn fat_path_handles_missing_path_env_var_gracefully() {
        let joined = with_path(None, || fat_path());
        // Candidate dirs alone should still be joinable.
        let joined = joined.expect("fat_path should still build from candidates alone");
        let s = joined.to_string_lossy().to_string();
        assert!(
            s.contains("/opt/homebrew/bin"),
            "expected candidate bin dirs when PATH is unset, got {s}"
        );
    }

    #[test]
    fn fat_path_skips_empty_segments_in_existing_path() {
        // "/a::/b" contains an empty middle segment; we should skip it rather
        // than emit a stray ":" that round-trips as an empty path.
        let joined = with_path(Some("/a::/b"), || {
            fat_path().expect("fat_path should succeed")
        });
        let s = joined.to_string_lossy().to_string();
        // No adjacent colons anywhere in the output.
        assert!(!s.contains("::"), "empty segment leaked into output: {s}");
    }
}
