//! Security helpers for the CDP browser layer.
//!
//! # URL validation
//!
//! Same strict allowlist as `tools_browser::validate_url` — only `http://`
//! and `https://` with a non-empty host, no `user:pass@host`, no control
//! characters.  Kept here as a standalone function so the CDP layer does
//! not import from the Safari module.
//!
//! # Risk classification (L-levels)
//!
//! | Level | Meaning                                     |
//! |-------|---------------------------------------------|
//! | L1    | Read-only, no side effects                  |
//! | L4    | Network-write / code execution risk         |
//!
//! `browser_cdp_eval` is always L4. `browser_cdp_click` and
//! `browser_cdp_type` are L4 **when the current page URL contains "password"
//! or the selector targets an `input[type=password]` element** — checked
//! at call time by `is_sensitive_context`.

use crate::browser::cdp::error::{CdpError, CdpResult};

/// Validate a URL for CDP use. Only `http://` and `https://` pass.
pub fn validate_url(url: &str) -> CdpResult<()> {
    if url.trim().is_empty() {
        return Err(CdpError::InvalidUrl("url must not be empty".into()));
    }
    if url.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7F) {
        return Err(CdpError::InvalidUrl(
            "url contains control characters".into(),
        ));
    }
    let colon = url
        .find(':')
        .ok_or_else(|| CdpError::InvalidUrl("url missing scheme".into()))?;
    let scheme = url[..colon].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(CdpError::InvalidUrl(format!(
            "scheme '{scheme}' is not allowed; only http and https"
        )));
    }
    let rest = &url[colon + 1..];
    let after_slashes = rest
        .strip_prefix("//")
        .ok_or_else(|| CdpError::InvalidUrl("url missing '//' after scheme".into()))?;
    let auth_end = after_slashes
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_slashes.len());
    let authority = &after_slashes[..auth_end];
    if authority.contains('@') {
        return Err(CdpError::InvalidUrl(
            "url must not contain userinfo (user:pass@host)".into(),
        ));
    }
    let host = match authority.rfind(':') {
        Some(idx)
            if !(authority.starts_with('[')
                && idx < authority.rfind(']').unwrap_or(0)) =>
        {
            &authority[..idx]
        }
        _ => authority,
    };
    let host_trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if host_trimmed.is_empty() {
        return Err(CdpError::InvalidUrl("url has empty host".into()));
    }
    Ok(())
}

/// Risk level for confirm-gate decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskLevel {
    /// Read/screenshot — no user prompt required.
    L1,
    /// Write/execute — requires user confirmation.
    L4,
}

/// Determine whether a click or type action should be treated as L4.
///
/// L4 is triggered when:
/// - `page_url` contains the substring `"password"` or `"login"` or `"signin"`, or
/// - `selector` contains `"password"` (covers `input[type=password]`).
pub fn action_risk(page_url: &str, selector: &str) -> RiskLevel {
    let url_lc = page_url.to_ascii_lowercase();
    let sel_lc = selector.to_ascii_lowercase();
    let sensitive_url = url_lc.contains("password")
        || url_lc.contains("login")
        || url_lc.contains("signin")
        || url_lc.contains("auth");
    let sensitive_selector = sel_lc.contains("password")
        || sel_lc.contains("passwd")
        || sel_lc.contains("secret")
        || sel_lc.contains("token");
    if sensitive_url || sensitive_selector {
        RiskLevel::L4
    } else {
        RiskLevel::L1
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_url_accepts_http_https() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://example.com/path?q=1").is_ok());
    }

    #[test]
    fn validate_url_rejects_empty_and_control_chars() {
        assert!(validate_url("").is_err());
        assert!(validate_url("   ").is_err());
        assert!(validate_url("https://evil\x00.com").is_err());
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("ftp://example.com/").is_err());
    }

    #[test]
    fn validate_url_rejects_userinfo() {
        assert!(validate_url("https://user:pass@host.com/").is_err());
        assert!(validate_url("https://apple.com@evil.example/").is_err());
    }

    #[test]
    fn validate_url_rejects_empty_host() {
        assert!(validate_url("https://").is_err());
        assert!(validate_url("http:///path").is_err());
    }

    #[test]
    fn action_risk_plain_page_is_l1() {
        assert_eq!(action_risk("https://example.com/shop", "button.buy"), RiskLevel::L1);
    }

    #[test]
    fn action_risk_login_page_is_l4() {
        assert_eq!(action_risk("https://github.com/login", "input[name=login]"), RiskLevel::L4);
    }

    #[test]
    fn action_risk_password_selector_is_l4() {
        assert_eq!(action_risk("https://example.com/settings", "input[type=password]"), RiskLevel::L4);
    }

    #[test]
    fn action_risk_signin_url_is_l4() {
        assert_eq!(action_risk("https://accounts.google.com/signin/v2", "#identifierId"), RiskLevel::L4);
    }

}
