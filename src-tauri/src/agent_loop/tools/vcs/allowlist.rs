//! URL allowlist for clone/push operations.
//!
//! Reads `~/.sunny/grants.json` and checks whether a remote URL matches
//! the `allowed_repo_hosts` list.  The default (empty list) permits
//! `github.com/*` and `gitlab.com/*`; an explicit list replaces those
//! defaults entirely so users can lock down to private hosts.

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

/// The slice of `~/.sunny/grants.json` we care about for VCS operations.
#[derive(Debug, Deserialize, Default)]
pub struct VcsGrants {
    /// Allowed remote hostnames.  When absent or empty the built-in
    /// defaults (`github.com`, `gitlab.com`) apply.
    #[serde(default)]
    pub allowed_repo_hosts: Vec<String>,
    /// Allowed `git_clone` target-directory prefixes (absolute paths).
    /// When absent or empty the built-in defaults (`$HOME/Projects`,
    /// `$HOME/src`, `$HOME/code`, `$HOME/workspace`) apply. The agent
    /// refuses to clone outside these prefixes so a prompt-injected
    /// sub-agent can't write into `~/.ssh`, `~/Library`, or system paths
    /// even if ConfirmGate is bypassed or mis-approved.
    #[serde(default)]
    pub allowed_clone_dirs: Vec<String>,
}

fn grants_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".sunny")
        .join("grants.json")
}

fn load_vcs_grants() -> VcsGrants {
    let bytes = match fs::read(grants_path()) {
        Ok(b) => b,
        Err(_) => return VcsGrants::default(),
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn default_hosts() -> &'static [&'static str] {
    &["github.com", "gitlab.com"]
}

fn default_clone_subdirs() -> &'static [&'static str] {
    &["Projects", "src", "code", "workspace"]
}

/// Sensitive HOME-relative path segments that must NEVER host a clone,
/// even if the user's allowlist somehow would admit them. Defence in
/// depth — the prefix allowlist below is the primary control; this
/// catches anyone who casually adds a broad prefix like `"."` or
/// `"/Users/sunny"` to `allowed_clone_dirs`.
const FORBIDDEN_CLONE_SEGMENTS: &[&str] = &[
    ".ssh", ".sunny", ".aws", ".gcp", ".gnupg", ".config",
    "Library", ".Trash",
];

/// Extract the hostname from a git remote URL.
///
/// Handles both HTTPS (`https://github.com/…`) and SCP-style SSH
/// (`git@github.com:…`) forms.
pub fn extract_host(url: &str) -> Option<&str> {
    // HTTPS / HTTP
    if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        return rest.split('/').next();
    }
    // SCP-style: git@github.com:user/repo.git
    if let Some(rest) = url.strip_prefix("git@") {
        return rest.split(':').next();
    }
    // ssh://git@github.com/…
    if let Some(rest) = url.strip_prefix("ssh://") {
        let after_at = if let Some(a) = rest.find('@') { &rest[a + 1..] } else { rest };
        return after_at.split('/').next();
    }
    None
}

/// Return `Ok(())` when `target_dir` sits under an allowed clone prefix
/// AND doesn't cross a forbidden segment; `Err` otherwise.
///
/// The target must be an absolute path. The parent of the target must
/// exist (we're not going to create intermediate directories on behalf
/// of a prompt-injected agent), and the resolved path must start with
/// one of the configured allowed prefixes.
pub fn check_clone_target_dir(target_dir: &str) -> Result<(), String> {
    let path = PathBuf::from(target_dir);
    if !path.is_absolute() {
        return Err(format!(
            "git_clone: target_dir `{target_dir}` must be an absolute path"
        ));
    }

    // Parent must exist — we clone into a new sibling, not a new tree
    // underneath a directory the agent imagines exists.
    let parent = path.parent().ok_or_else(|| {
        format!("git_clone: target_dir `{target_dir}` has no parent directory")
    })?;
    if !parent.exists() {
        return Err(format!(
            "git_clone: parent directory of `{target_dir}` does not exist"
        ));
    }

    // Forbidden-segment check — defence in depth against an overly
    // permissive `allowed_clone_dirs` entry.
    let path_str = path.to_string_lossy();
    for seg in FORBIDDEN_CLONE_SEGMENTS {
        // match a path segment, not a substring — look for `/seg/` OR
        // `/seg$` at the tail.
        let mid = format!("/{seg}/");
        let tail = format!("/{seg}");
        if path_str.contains(&*mid) || path_str.ends_with(&*tail) {
            return Err(format!(
                "git_clone: target_dir `{target_dir}` crosses forbidden segment `{seg}`"
            ));
        }
    }

    // Allowlist check — user-configured prefixes OR the built-in
    // defaults under $HOME.
    let grants = load_vcs_grants();
    let home = dirs::home_dir();
    let allowed: Vec<PathBuf> = if !grants.allowed_clone_dirs.is_empty() {
        grants
            .allowed_clone_dirs
            .iter()
            .map(PathBuf::from)
            .collect()
    } else {
        let home = home
            .as_ref()
            .ok_or_else(|| "git_clone: $HOME not set; cannot resolve default clone allowlist".to_string())?;
        default_clone_subdirs()
            .iter()
            .map(|sub| home.join(sub))
            .collect()
    };

    if allowed.iter().any(|prefix| path.starts_with(prefix)) {
        Ok(())
    } else {
        let shown: Vec<String> = allowed
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        Err(format!(
            "git_clone: target_dir `{target_dir}` is not under any allowed_clone_dirs \
             prefix in ~/.sunny/grants.json (allowed: {})",
            shown.join(", ")
        ))
    }
}

/// Return `Ok(())` when `url` matches the allowed host list; `Err` otherwise.
pub fn check_url(url: &str) -> Result<(), String> {
    let host = extract_host(url).ok_or_else(|| {
        format!("cannot determine hostname from remote URL `{url}`; only HTTPS and SCP-SSH forms are supported")
    })?;

    let grants = load_vcs_grants();
    let allowed: Vec<&str> = if grants.allowed_repo_hosts.is_empty() {
        default_hosts().to_vec()
    } else {
        grants.allowed_repo_hosts.iter().map(String::as_str).collect()
    };

    if allowed.iter().any(|h| host.eq_ignore_ascii_case(h)) {
        Ok(())
    } else {
        Err(format!(
            "remote host `{host}` is not in the allowed_repo_hosts list \
             in ~/.sunny/grants.json (allowed: {})",
            allowed.join(", ")
        ))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_https_host() {
        assert_eq!(extract_host("https://github.com/user/repo"), Some("github.com"));
    }

    #[test]
    fn extract_scp_host() {
        assert_eq!(extract_host("git@github.com:user/repo.git"), Some("github.com"));
    }

    #[test]
    fn extract_ssh_url_host() {
        assert_eq!(extract_host("ssh://git@gitlab.com/user/repo.git"), Some("gitlab.com"));
    }

    #[test]
    fn unknown_scheme_returns_none() {
        assert_eq!(extract_host("ftp://example.com/repo"), None);
    }

    #[test]
    fn default_allows_github() {
        // Simulate empty grants → defaults apply.
        let host = "github.com";
        let allowed: Vec<&str> = default_hosts().to_vec();
        assert!(allowed.iter().any(|h| host.eq_ignore_ascii_case(h)));
    }

    #[test]
    fn clone_target_relative_rejected() {
        let err = check_clone_target_dir("Projects/foo").unwrap_err();
        assert!(err.contains("must be an absolute path"), "got: {err}");
    }

    #[test]
    fn clone_target_forbidden_segment_rejected() {
        let err = check_clone_target_dir("/Users/x/.ssh/keys").unwrap_err();
        assert!(err.contains("forbidden segment"), "got: {err}");
        let err = check_clone_target_dir("/Users/x/Library/Mail").unwrap_err();
        assert!(err.contains("forbidden segment"), "got: {err}");
    }

    #[test]
    fn default_clone_subdirs_contains_projects() {
        let subs: Vec<&str> = default_clone_subdirs().to_vec();
        assert!(subs.iter().any(|s| *s == "Projects"));
    }

    #[test]
    fn default_allows_gitlab() {
        let host = "gitlab.com";
        let allowed: Vec<&str> = default_hosts().to_vec();
        assert!(allowed.iter().any(|h| host.eq_ignore_ascii_case(h)));
    }

    #[test]
    fn default_denies_arbitrary_host() {
        let host = "evil.example.com";
        let allowed: Vec<&str> = default_hosts().to_vec();
        assert!(!allowed.iter().any(|h| host.eq_ignore_ascii_case(h)));
    }

    #[test]
    fn custom_grants_override_defaults() {
        // Custom list that includes a private host but NOT github.com.
        let custom = vec!["git.internal.corp"];
        let host_private = "git.internal.corp";
        let host_github = "github.com";
        assert!(custom.iter().any(|h| *h == host_private));
        assert!(!custom.iter().any(|h| *h == host_github));
    }
}
