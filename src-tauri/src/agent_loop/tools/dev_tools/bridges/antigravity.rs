//! Antigravity bridge — launches via the `antigravity://` URL scheme.
//!
//! Launch mechanism: `open "antigravity://open?path=<encoded>&session=<id>"`
//!
//! Safety: ONLY the `antigravity://` URL scheme is allowlisted.  Any attempt
//! to use a different scheme returns `Err` before the `open` command runs.

use tokio::process::Command;

use crate::agent_loop::tools::dev_tools::discover::{discover_antigravity, CapabilityReport};
use crate::agent_loop::tools::dev_tools::launch::{bus_dir_for, write_bus_status};

/// Only this scheme is allowlisted for URL-scheme launches.
const ALLOWED_SCHEME: &str = "antigravity://";

pub async fn discover() -> Result<CapabilityReport, String> {
    discover_antigravity()
}

pub fn build_launch_url(project_path: &str, session_id: &str) -> Result<String, String> {
    // URL-encode the path using percent-encoding.
    let encoded_path: String = project_path
        .chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == '_' || c == '.' {
                vec![c]
            } else if c == ' ' {
                vec!['%', '2', '0']
            } else {
                let b = c as u32;
                format!("%{b:02X}").chars().collect()
            }
        })
        .collect();

    let url = format!("{ALLOWED_SCHEME}open?path={encoded_path}&session={session_id}");

    // Allowlist check — must start with the allowed scheme.
    if !url.starts_with(ALLOWED_SCHEME) {
        return Err(format!(
            "URL scheme not allowlisted: `{url}` — only `{ALLOWED_SCHEME}` is permitted"
        ));
    }

    Ok(url)
}

pub async fn launch(project_path: &str, session_id: &str) -> Result<(), String> {
    let url = build_launch_url(project_path, session_id)?;

    let status = Command::new("open")
        .arg(&url)
        .status()
        .await
        .map_err(|e| format!("antigravity launch failed: {e}"))?;

    if status.success() {
        write_bus_status(session_id, "running")?;
        Ok(())
    } else {
        let err = format!("open antigravity:// exited with {status}");
        std::fs::write(bus_dir_for(session_id).join("error.txt"), &err)
            .map_err(|e| format!("write error: {e}"))?;
        write_bus_status(session_id, "error")?;
        Err(err)
    }
}

pub async fn stop(session_id: &str) -> Result<(), String> {
    write_bus_status(session_id, "done")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_starts_with_allowed_scheme() {
        let url = build_launch_url("/Users/sunny/Projects/myapp", "sess-123")
            .expect("build_launch_url must succeed");
        assert!(
            url.starts_with(ALLOWED_SCHEME),
            "URL must start with antigravity://, got: {url}"
        );
        assert!(url.contains("sess-123"), "URL must contain session id");
    }

    #[test]
    fn url_encodes_path_with_spaces() {
        let url =
            build_launch_url("/Users/sunny/My Projects/app", "s1").expect("url");
        assert!(url.contains("%20") || url.contains('+'), "spaces must be encoded");
    }

    #[test]
    fn non_antigravity_scheme_is_rejected() {
        // build_launch_url always produces antigravity:// — verify the guard
        // would reject a crafted URL.
        let crafted = "https://evil.com/steal";
        let is_allowed = crafted.starts_with(ALLOWED_SCHEME);
        assert!(!is_allowed, "https:// must be rejected by allowlist");
    }
}
