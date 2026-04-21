//! Path safety helpers specific to Spotlight/Finder tools.
//!
//! Rules:
//!   * `..` components are rejected after expansion — no traversal.
//!   * Paths are canonicalized via `safety_paths::canonicalize_best_effort`.
//!   * Mutating operations (move, rename, trash, compress) are additionally
//!     checked against `safety_paths::assert_write_allowed`.
//!   * System directories (`/System`, `/Library`, `/usr`, `/bin`, `/sbin`,
//!     `/etc`, `/private`, `/var`) are absolutely denied for mutations.
//!   * Mutations outside `$HOME` are denied unless the path is inside an
//!     explicitly allowed sandbox root from `safety_paths`.

use std::path::{Component, Path, PathBuf};

use crate::safety_paths::{assert_write_allowed, canonicalize_best_effort, expand_home};

/// Absolute-deny list for mutation operations.  Even if `assert_write_allowed`
/// were somehow bypassed (e.g. a weird symlink resolved inside $HOME pointing
/// out), these prefixes stop mutations cold.
const SYSTEM_DENY: &[&str] = &[
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/private",
    "/var",
];

/// Expand, canonicalize, and reject any `..` components.
///
/// Returns the resolved [`PathBuf`] or a human-readable error string.
/// This is the entry-point for ALL tools — read-only and mutating alike.
///
/// Rejection is based on the RAW (expanded-but-not-canonicalized) path so
/// `..` can't sneak through a lexical collapse that `canonicalize_best_effort`
/// would perform.
pub fn resolve(raw: &str) -> Result<PathBuf, String> {
    let expanded = expand_home(raw)?;

    // Reject `..` components BEFORE canonicalization — a lexical collapse
    // would mask traversal attempts like `~/a/../../etc/passwd`.
    if expanded.components().any(|c| c == Component::ParentDir) {
        return Err(format!(
            "path rejected: `..` traversal detected in `{raw}`"
        ));
    }

    let canonical = canonicalize_best_effort(&expanded);

    // Double-check after canonicalization as defense-in-depth.
    if canonical.components().any(|c| c == Component::ParentDir) {
        return Err(format!(
            "path rejected: `..` traversal detected in `{}`",
            canonical.display()
        ));
    }

    if !canonical.is_absolute() {
        return Err(format!(
            "path rejected: could not produce an absolute path from `{raw}`"
        ));
    }

    Ok(canonical)
}

/// Like [`resolve`], but additionally verifies the path is safe to mutate
/// (move, rename, trash, compress output).
pub fn resolve_for_mutation(raw: &str) -> Result<PathBuf, String> {
    let path = resolve(raw)?;

    // Hard system-directory deny — checked before `assert_write_allowed` so
    // the error message is always unambiguous.
    for denied in SYSTEM_DENY {
        let deny_path = Path::new(denied);
        if path == deny_path || path.starts_with(deny_path) {
            return Err(format!(
                "mutation denied: `{}` is inside a protected system directory",
                path.display()
            ));
        }
    }

    assert_write_allowed(&path)?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        dirs::home_dir().expect("home dir required for tests")
    }

    // -- resolve: basic cases --------------------------------------------------

    #[test]
    fn resolve_tilde_expands() {
        let got = resolve("~/Downloads/foo.txt").unwrap();
        assert!(got.is_absolute());
        assert!(got.starts_with(home()));
    }

    #[test]
    fn resolve_absolute_path_passes() {
        let got = resolve("/tmp/foo.txt").unwrap();
        // On macOS `/tmp` is a symlink to `/private/tmp`, so accept either.
        let s = got.to_string_lossy().to_string();
        assert!(
            s == "/tmp/foo.txt" || s == "/private/tmp/foo.txt",
            "unexpected resolution: {s}"
        );
    }

    #[test]
    fn resolve_rejects_dotdot_in_raw() {
        // A raw `..` that survives expansion must be rejected.
        // We craft a path that lexically contains `..` and cannot be
        // collapsed by the filesystem canonicalizer because the child dir
        // does not exist.
        let ghost = format!("{}/nonexistent/../../../etc/passwd", home().display());
        let err = resolve(&ghost).unwrap_err();
        assert!(
            err.contains(".."),
            "expected dotdot rejection, got: {err}"
        );
    }

    #[test]
    fn resolve_rejects_dotdot_prefix() {
        let err = resolve("../etc/passwd").unwrap_err();
        // Either the `..` is caught or we get a non-absolute error.
        assert!(
            err.contains("..") || err.contains("absolute"),
            "got: {err}"
        );
    }

    // -- resolve_for_mutation: system dir deny --------------------------------

    #[test]
    fn mutation_denies_system() {
        let err = resolve_for_mutation("/System/Library/foo").unwrap_err();
        assert!(
            err.contains("denied") || err.contains("protected"),
            "got: {err}"
        );
    }

    #[test]
    fn mutation_denies_usr() {
        let err = resolve_for_mutation("/usr/bin/python").unwrap_err();
        assert!(err.contains("denied") || err.contains("protected"), "got: {err}");
    }

    #[test]
    fn mutation_denies_library_root() {
        let err = resolve_for_mutation("/Library/Preferences/com.apple.foo.plist").unwrap_err();
        assert!(err.contains("denied") || err.contains("protected"), "got: {err}");
    }

    // -- resolve_for_mutation: home allow -------------------------------------

    #[test]
    fn mutation_allows_home_downloads() {
        let p = home().join("Downloads").join("test.txt");
        assert!(resolve_for_mutation(&p.to_string_lossy()).is_ok());
    }

    #[test]
    fn mutation_allows_home_desktop() {
        let p = home().join("Desktop").join("note.txt");
        assert!(resolve_for_mutation(&p.to_string_lossy()).is_ok());
    }
}
