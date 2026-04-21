//! Typed error enum for all CDP operations.

use std::fmt;

/// All errors that can come out of the CDP browser layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpError {
    /// Chrome could not be found or failed to launch.
    LaunchFailed(String),
    /// The requested tab ID does not exist (closed or never opened).
    TabNotFound(String),
    /// A CSS selector produced no element within the wait budget.
    SelectorTimeout { selector: String, timeout_ms: u64 },
    /// The page did not reach `networkidle` within the wait budget.
    NetworkIdleTimeout(u64),
    /// A CDP protocol-level error from `chromiumoxide`.
    Protocol(String),
    /// Invalid or unsafe URL supplied by the caller.
    InvalidUrl(String),
    /// JS evaluation returned a value that cannot be serialised as JSON.
    EvalError(String),
    /// Screenshot capture failed.
    ScreenshotFailed(String),
    /// A filesystem operation (profile dir, downloads dir) failed.
    Io(String),
    /// The caller is missing the required capability / confirm gate blocked
    /// the call.
    PermissionDenied(String),
}

impl fmt::Display for CdpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LaunchFailed(m) => write!(f, "Chrome launch failed: {m}"),
            Self::TabNotFound(id) => write!(f, "tab not found: {id}"),
            Self::SelectorTimeout { selector, timeout_ms } => write!(
                f,
                "selector `{selector}` not found within {timeout_ms} ms"
            ),
            Self::NetworkIdleTimeout(ms) => {
                write!(f, "network-idle wait timed out after {ms} ms")
            }
            Self::Protocol(m) => write!(f, "CDP protocol error: {m}"),
            Self::InvalidUrl(m) => write!(f, "invalid URL: {m}"),
            Self::EvalError(m) => write!(f, "JS eval error: {m}"),
            Self::ScreenshotFailed(m) => write!(f, "screenshot failed: {m}"),
            Self::Io(m) => write!(f, "I/O error: {m}"),
            Self::PermissionDenied(m) => write!(f, "permission denied: {m}"),
        }
    }
}

/// Convenience alias used throughout the CDP layer.
pub type CdpResult<T> = Result<T, CdpError>;

impl From<CdpError> for String {
    fn from(e: CdpError) -> String {
        e.to_string()
    }
}
