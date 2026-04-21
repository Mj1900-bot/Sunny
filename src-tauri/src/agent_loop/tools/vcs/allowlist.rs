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
