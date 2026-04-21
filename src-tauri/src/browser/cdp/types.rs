//! Immutable return-value types for CDP tool results.
//!
//! All structs implement `Clone` + `Debug` and are fully owned (no borrows).
//! Callers receive one of these and serialize it to JSON for the LLM; the
//! tool handler never mutates an in-flight struct.

use serde::{Deserialize, Serialize};

/// Summary of an open tab returned by `browser_cdp_list_tabs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabInfo {
    /// Stable opaque identifier for this tab (UUID).
    pub tab_id: String,
    /// Current page URL.
    pub url: String,
    /// Page `<title>` text, or `"(untitled)"` if absent.
    pub title: String,
}

/// Text content returned by `browser_cdp_read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CdpText {
    pub tab_id: String,
    /// Selector that was used, or `"body"` for the default full-page read.
    pub selector: String,
    /// Normalised text content.
    pub text: String,
    /// `true` if the text was truncated to the cap.
    pub truncated: bool,
}

/// Result from `browser_cdp_screenshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpScreenshot {
    pub tab_id: String,
    /// Absolute path to the saved PNG on disk.
    pub path: String,
    /// File size in bytes.
    pub bytes: u64,
}

/// Result from `browser_cdp_open`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CdpOpenResult {
    pub tab_id: String,
    pub url: String,
}

/// Result from `browser_cdp_click` or `browser_cdp_type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CdpActionResult {
    pub tab_id: String,
    pub selector: String,
    pub action: String,
}

/// Result from `browser_cdp_eval`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpEvalResult {
    pub tab_id: String,
    /// JSON-serialised return value of the expression, or `"undefined"`.
    pub value: serde_json::Value,
}

/// Result from `browser_cdp_wait`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CdpWaitResult {
    pub tab_id: String,
    /// What we waited for: a CSS selector or `"networkidle"`.
    pub waited_for: String,
    /// Actual elapsed milliseconds.
    pub elapsed_ms: u64,
}
