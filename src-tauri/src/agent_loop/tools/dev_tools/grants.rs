//! Project-path grant check — verifies that a given path is listed in
//! `~/.sunny/grants.json` under `"dev_tool_paths"` before any dev-tool
//! launch is allowed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The slice of `~/.sunny/grants.json` we care about.
#[derive(Debug, Deserialize, Default)]
struct GrantsFile {
    #[serde(default)]
    dev_tool_paths: Vec<String>,
}

fn grants_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".sunny")
        .join("grants.json")
}

fn load_grants() -> GrantsFile {
    let path = grants_path();
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return GrantsFile::default(),
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Returns `Ok(())` if `project_path` is under one of the granted paths,
/// or `Err` with an explanatory message.
pub fn check_project_path(project_path: &str) -> Result<(), String> {
    let target = Path::new(project_path);
    let grants = load_grants();

    // An empty dev_tool_paths list is treated as "no paths granted".
    if grants.dev_tool_paths.is_empty() {
        return Err(format!(
            "project path `{project_path}` not granted: \
             add it to dev_tool_paths in ~/.sunny/grants.json"
        ));
    }

    for allowed in &grants.dev_tool_paths {
        let allowed_path = shellexpand::tilde(allowed.as_str());
        let allowed_path = Path::new(allowed_path.as_ref());
        if target.starts_with(allowed_path) {
            return Ok(());
        }
    }

    Err(format!(
        "project path `{project_path}` is not in the dev_tool_paths grant list \
         in ~/.sunny/grants.json"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_grants_denies_any_path() {
        // We can't reliably test with the real grants file, so we test the
        // logic with an empty list directly.
        let grants = GrantsFile { dev_tool_paths: vec![] };
        // Re-implement the check inline to avoid touching disk.
        let project_path = "/Users/sunny/Projects/myapp";
        let target = Path::new(project_path);
        let is_granted = grants.dev_tool_paths.iter().any(|a| {
            let expanded = shellexpand::tilde(a.as_str());
            target.starts_with(Path::new(expanded.as_ref()))
        });
        assert!(!is_granted, "empty list must not grant anything");
    }

    #[test]
    fn matching_prefix_is_granted() {
        let grants = GrantsFile {
            dev_tool_paths: vec!["/Users/sunny/Projects".to_string()],
        };
        let project_path = "/Users/sunny/Projects/myapp";
        let target = Path::new(project_path);
        let is_granted = grants.dev_tool_paths.iter().any(|a| {
            let expanded = shellexpand::tilde(a.as_str());
            target.starts_with(Path::new(expanded.as_ref()))
        });
        assert!(is_granted, "path under granted prefix must be allowed");
    }

    #[test]
    fn sibling_path_not_granted() {
        let grants = GrantsFile {
            dev_tool_paths: vec!["/Users/sunny/Projects/allowed".to_string()],
        };
        let project_path = "/Users/sunny/Projects/other";
        let target = Path::new(project_path);
        let is_granted = grants.dev_tool_paths.iter().any(|a| {
            let expanded = shellexpand::tilde(a.as_str());
            target.starts_with(Path::new(expanded.as_ref()))
        });
        assert!(!is_granted, "sibling path must not be granted");
    }
}
