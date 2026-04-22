//! Shared path helpers for document tools.
//!
//! Resolves `~/`-prefixed paths and validates that the resolved path is a
//! regular file the process can read. Network paths (`smb://`, `afp://`,
//! etc.) are rejected up front — L0 document tools are local-only. A
//! caller that genuinely needs remote paths must hold the
//! `documents.network` capability and resolve through a dedicated code
//! path, not `resolve_local`.

use std::path::PathBuf;

/// Resolve `~/` to the home directory and return the canonical [`PathBuf`].
/// Rejects network paths (SMB/AFP/FTP/NFS/UNC) and returns `Err` when the
/// resolved path does not exist or is not a regular file.
pub fn resolve_local(raw: &str) -> Result<PathBuf, String> {
    // Gate network paths at L0 — document tools must not quietly follow
    // an `smb://` URL that would exfiltrate from a network mount. A
    // dispatcher that legitimately wants network access has to check
    // `is_network_path` and confirm the `documents.network` cap before
    // reaching for a separate resolver.
    if is_network_path(raw) {
        return Err(format!(
            "network path requires documents.network capability: {raw}"
        ));
    }
    let expanded = shellexpand::tilde(raw).into_owned();
    let p = PathBuf::from(&expanded);
    if !p.exists() {
        return Err(format!("file not found: {expanded}"));
    }
    if !p.is_file() {
        return Err(format!("path is not a regular file: {expanded}"));
    }
    Ok(p)
}

/// Returns `true` if the raw path looks like a network URL or UNC share.
/// Callers that return `true` here must hold the `documents.network` cap.
pub fn is_network_path(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.starts_with("smb://")
        || lower.starts_with("afp://")
        || lower.starts_with("ftp://")
        || lower.starts_with("nfs://")
        || lower.starts_with("//")
        || lower.starts_with("\\\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_path_smb() {
        assert!(is_network_path("smb://server/share/file.pdf"));
    }

    #[test]
    fn test_network_path_afp() {
        assert!(is_network_path("afp://nas/volume/doc.docx"));
    }

    #[test]
    fn test_local_path_not_network() {
        assert!(!is_network_path("/Users/sunny/docs/report.pdf"));
        assert!(!is_network_path("~/Documents/file.xlsx"));
    }
}
