//! Apple XProtect posture probe.
//!
//! XProtect is Apple's built-in YARA-based malware signature engine,
//! updated silently via the XProtectPlistConfigData update channel.
//! We don't execute its rules ourselves — Apple already does that
//! via XProtectService — but we do surface its current version +
//! rule count on the SYSTEM tab so the user can see that Apple's
//! layer is active alongside Sunny's own signature DB.
//!
//! On newer macOS (13+) the YARA rule file lives at:
//!
//!   /Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.yara
//!
//! The version is in the same bundle's Info.plist under
//! `CFBundleShortVersionString`.  Both files are world-readable so
//! no special permission is needed.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use ts_rs::TS;

const XPROTECT_BUNDLE: &str =
    "/Library/Apple/System/Library/CoreServices/XProtect.bundle";

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct XprotectStatus {
    pub present: bool,
    pub version: String,
    pub rules_path: String,
    #[ts(type = "number")]
    pub rules_count: u32,
    #[ts(type = "number")]
    pub rules_size: u64,
    /// SHA-256 of the rules file; changes when Apple pushes an update.
    pub rules_sha256: String,
}

pub async fn snapshot() -> XprotectStatus {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(probe).await.unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        XprotectStatus::default()
    }
}

#[cfg(target_os = "macos")]
fn probe() -> XprotectStatus {
    let bundle = PathBuf::from(XPROTECT_BUNDLE);
    let rules = bundle
        .join("Contents")
        .join("Resources")
        .join("XProtect.yara");
    let info = bundle.join("Contents").join("Info.plist");

    if !rules.exists() {
        return XprotectStatus {
            present: false,
            rules_path: rules.to_string_lossy().to_string(),
            ..Default::default()
        };
    }

    let body = fs::read(&rules).unwrap_or_default();
    let size = body.len() as u64;

    // Count YARA rules — every rule block starts with the keyword
    // `rule ` at the start of a line.  Apple's YARA file is
    // line-oriented, so a byte-scan is enough.
    let rules_count = body
        .split(|b| *b == b'\n')
        .filter(|line| line.starts_with(b"rule ") || line.starts_with(b"private rule "))
        .count() as u32;

    // SHA-256 of the rules body — stable fingerprint the UI can
    // compare across probes to detect when Apple pushed an update.
    let rules_sha256 = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&body);
        format!("{:x}", h.finalize())
    };

    // Version extraction from Info.plist — plist parsing without a
    // dep: read the file as text and pull `CFBundleShortVersionString`.
    let version = read_plist_version(&info).unwrap_or_default();

    XprotectStatus {
        present: true,
        version,
        rules_path: rules.to_string_lossy().to_string(),
        rules_count,
        rules_size: size,
        rules_sha256,
    }
}

#[cfg(target_os = "macos")]
fn read_plist_version(path: &std::path::Path) -> Option<String> {
    let body = fs::read_to_string(path).ok()?;
    // Most XProtect Info.plist files are XML.  Find
    // `CFBundleShortVersionString` and the next `<string>…</string>`.
    let key_idx = body.find("CFBundleShortVersionString")?;
    let after = &body[key_idx..];
    let open = after.find("<string>")? + "<string>".len();
    let close = after[open..].find("</string>")?;
    Some(after[open..open + close].trim().to_string())
}

#[cfg(target_os = "macos")]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_never_panics_even_offline() {
        // Probe runs real IO; on a box without /Library/Apple we
        // expect `present=false` and no crash.
        let s = probe();
        assert!(s.rules_path.contains("XProtect"));
    }
}
