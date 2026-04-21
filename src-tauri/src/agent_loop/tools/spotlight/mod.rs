//! Spotlight + Finder tools — full-Mac file search and file operations.
//!
//! ## Tool inventory
//!
//! | Tool                    | L-level | Description                                     |
//! |-------------------------|---------|-------------------------------------------------|
//! | `spotlight_search`      | L0 read | `mdfind` text + kind filter                     |
//! | `spotlight_recent_files`| L0 read | files modified in the last N hours              |
//! | `file_reveal_in_finder` | L2      | `open -R` — reveal in Finder                    |
//! | `file_open_default`     | L2      | `open` — open with default handler              |
//! | `file_open_with`        | L2      | `open -a <App>` — open with specific app        |
//! | `file_tag_list`         | L0 read | read `_kMDItemUserTags` xattr (binary plist)    |
//! | `file_tag_search`       | L0 read | `mdfind kMDItemUserTags`                        |
//! | `file_tag_add`          | L2      | write tags via xattr binary plist               |
//! | `file_move`             | L3      | `fs::rename` — clobber-refused, confirm-gated   |
//! | `file_rename`           | L3      | rename in place, bare name only                 |
//! | `trash_file`            | L3      | move to `~/.Trash` (reversible)                 |
//! | `file_compress`         | L3      | `zip -r` wrapper                                |
//! | `file_decompress`       | L3      | `unzip` wrapper                                 |
//!
//! ## Capability strings
//!
//! | Capability        | Tools                                                 |
//! |-------------------|-------------------------------------------------------|
//! | `spotlight.search`| spotlight_search, spotlight_recent_files, file_tag_list, file_tag_search |
//! | `finder.reveal`   | file_reveal_in_finder                                 |
//! | `finder.open`     | file_open_default, file_open_with                     |
//! | `finder.tags`     | file_tag_add                                          |
//! | `finder.mutate`   | file_move, file_rename, trash_file, file_compress, file_decompress |
//!
//! ## Path safety
//!
//! All paths flow through `path_guard::resolve` (or `resolve_for_mutation`),
//! which:
//!   1. Expands `~` via `safety_paths::expand_home`.
//!   2. Canonicalizes via `safety_paths::canonicalize_best_effort`.
//!   3. Rejects any surviving `..` components.
//!   4. For mutations: additionally calls `safety_paths::assert_write_allowed`,
//!      which refuses `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc`,
//!      `/private`, `/var`, `/Applications` and anything outside `$HOME` +
//!      approved sandbox roots.
//!
//! ## Tag xattr format
//!
//! macOS stores Finder tags in `com.apple.metadata:_kMDItemUserTags` as a
//! **binary property list** (bplist00).  The top-level NSArray contains one
//! NSString per tag; each string is the tag name optionally followed by
//! `\n<color-index>` (0–7).  `tags::build_bplist` hand-assembles the bplist
//! byte stream; `tags::parse_tag_xattr` parses the hex-encoded xattr output
//! from `xattr -px`.

pub(super) mod mdfind;
pub(super) mod path_guard;
pub(super) mod tags;

pub mod file_compress;
pub mod file_decompress;
pub mod file_move;
pub mod file_open_default;
pub mod file_open_with;
pub mod file_rename;
pub mod file_reveal_in_finder;
pub mod file_tag_add;
pub mod file_tag_list;
pub mod file_tag_search;
pub mod spotlight_recent_files;
pub mod spotlight_search;
pub mod trash_file;

// ---------------------------------------------------------------------------
// Module-level tests that exercise cross-cutting concerns
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    // These tests live here (rather than in path_guard/mdfind/tags) because
    // they exercise the *integration* of the path guard with tool inputs.

    use super::path_guard::{resolve, resolve_for_mutation};

    fn home() -> std::path::PathBuf {
        dirs::home_dir().expect("home dir required for tests")
    }

    #[test]
    fn dotdot_in_middle_of_path_rejected() {
        let bad = format!("{}/Downloads/../../../etc/passwd", home().display());
        let err = resolve(&bad).unwrap_err();
        assert!(
            err.contains("..") || err.contains("denied") || err.contains("absolute"),
            "expected rejection, got: {err}"
        );
    }

    #[test]
    fn dotdot_at_start_rejected() {
        let err = resolve("../../etc/shadow").unwrap_err();
        assert!(
            err.contains("..") || err.contains("absolute"),
            "got: {err}"
        );
    }

    #[test]
    fn system_lib_denied_for_mutation() {
        let err = resolve_for_mutation("/Library/Application Support/com.apple.foo").unwrap_err();
        assert!(err.contains("denied") || err.contains("protected"), "got: {err}");
    }

    #[test]
    fn usr_bin_denied_for_mutation() {
        let err = resolve_for_mutation("/usr/bin/python3").unwrap_err();
        assert!(err.contains("denied") || err.contains("protected"), "got: {err}");
    }

    #[test]
    fn private_etc_denied_for_mutation() {
        let err = resolve_for_mutation("/private/etc/hosts").unwrap_err();
        assert!(err.contains("denied") || err.contains("protected"), "got: {err}");
    }

    #[test]
    fn home_path_allowed_for_mutation() {
        let p = home().join("Documents").join("safe.txt");
        assert!(resolve_for_mutation(&p.to_string_lossy()).is_ok());
    }

    #[test]
    fn tilde_resolves_correctly() {
        let got = resolve("~/Desktop/test.txt").unwrap();
        assert!(got.starts_with(home()), "got: {}", got.display());
    }
}
