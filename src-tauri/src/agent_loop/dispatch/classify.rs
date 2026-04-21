//! Error classification — three-way taxonomy (`Transient` / `Permanent` /
//! `Unknown`) plus the `classify_error` heuristic used by the dispatch
//! retry policy to decide whether a tool failure is worth retrying and what
//! `error_kind` tag to attach to the envelope the LLM sees.

use once_cell::sync::Lazy;
use regex::Regex;

/// Regex for anchored HTTP status-code detection in classify_tool_error.
/// Requires the literal string "http " before the digits so that a message
/// like "processed 400 items" does NOT match 400, but "http 400 bad request"
/// and "anthropic http 400:" both do. The word-boundary  before the digit
/// group prevents matching inside longer numbers (e.g. "error 14003").
pub(super) static HTTP_STATUS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)http (4\d{2}|5\d{2})").expect("HTTP_STATUS_RE is valid")
});

/// Three-way classification used by the dispatch retry policy.
///
/// `Transient` = worth retrying (network flap, upstream 5xx, rate
/// limited). `Permanent` = retrying is wasteful / wrong (validation
/// error, missing resource, permission denied). `Unknown` = we can't
/// tell — treat as permanent so we don't drown a failing upstream in
/// automatic retries.
#[derive(Debug, PartialEq, Eq)]
pub enum ToolErrorClass {
    Transient,
    Permanent,
    Unknown,
}

/// Classify a free-form tool error string for retry eligibility.
///
/// Pattern match is case-insensitive and substring-based so it catches
/// error messages from reqwest, hyper, std::io, and the hand-formatted
/// strings our own tool arms produce.
///
/// Transient matches (retry ok):
///   - "timeout" / "timed out"
///   - "connection refused" / "connection reset" / "connection closed"
///   - "temporarily unavailable" / "temporary failure"
///   - HTTP 502 / 503 / 504
///   - HTTP 429 / "rate limit" / "too many requests"
///   - "dns" lookup failures
///
/// Permanent matches (retry is wasteful):
///   - "not found" / HTTP 404
///   - "permission denied" / HTTP 401 / HTTP 403 / "unauthorized" /
///     "forbidden"
///   - "invalid input" / "invalid argument" / "validation" /
///     "arg_validation" / "missing" + "arg" / "bad request" /
///     HTTP 400 / HTTP 422
///   - "constitution:" / "policy:" / "denied" (our own refusals)
///   - "unknown tool" / "not implemented"
pub fn classify_tool_error(message: &str) -> ToolErrorClass {
    let m = message.to_ascii_lowercase();

    // --- Permanent ---------------------------------------------------
    // Check permanent first so a string like "validation timeout" (the
    // word "timeout" embedded in a validation context) still classifies
    // as permanent rather than triggering a pointless retry.
    // Use the anchored regex for HTTP status codes so that strings like
    // "processed 400 items" do not accidentally trigger permanent-error routing.
    let http_status_match = HTTP_STATUS_RE.find(&m).map(|m| m.as_str().to_string());
    let http_4xx = http_status_match.as_deref().map(|s| s.starts_with("http 4")).unwrap_or(false);
    let http_5xx = http_status_match.as_deref().map(|s| s.starts_with("http 5")).unwrap_or(false);
    // Permanent 4xx codes (client errors): 400, 401, 403, 404, 422.
    let is_permanent_4xx = if http_4xx {
        let code: u16 = http_status_match.as_deref()
            .and_then(|s| s.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        matches!(code, 400 | 401 | 403 | 404 | 422)
    } else {
        false
    };
    // Transient 4xx: only 429 (rate-limited).
    let is_transient_4xx = if http_4xx {
        let code: u16 = http_status_match.as_deref()
            .and_then(|s| s.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        code == 429
    } else {
        false
    };

    if m.contains("arg_validation")
        || m.contains("validation error")
        || m.contains("invalid input")
        || m.contains("invalid argument")
        || m.contains("bad request")
        || is_permanent_4xx
        || (m.contains("missing") && m.contains("arg"))
        || m.contains("not found")
        || m.contains("permission denied")
        || m.contains("unauthorized")
        || m.contains("forbidden")
        || m.contains("constitution:")
        || m.contains("policy:")
        || m.contains("panic_mode")
        || m.contains("user declined")
        || m.starts_with("denied")
        || m.contains("unknown tool")
        || m.contains("not implemented")
        || m.contains("depth_limit")
    {
        return ToolErrorClass::Permanent;
    }

    // --- Transient ---------------------------------------------------
    if m.contains("timeout")
        || m.contains("timed out")
        || m.contains("connection refused")
        || m.contains("connection reset")
        || m.contains("connection closed")
        || m.contains("connection aborted")
        || m.contains("broken pipe")
        || m.contains("temporarily unavailable")
        || m.contains("temporary failure")
        || m.contains("service unavailable")
        || http_5xx
        || m.contains("bad gateway")
        || m.contains("gateway timeout")
        || is_transient_4xx
        || m.contains("rate limit")
        || m.contains("too many requests")
        || m.contains("dns")
    {
        return ToolErrorClass::Transient;
    }

    ToolErrorClass::Unknown
}

/// Classify a free-form error string into an error kind the LLM can
/// reason about. Best-effort heuristic — false negatives are OK (they
/// just default to `transient`).
pub fn classify_error(message: &str) -> (&'static str, bool) {
    let m = message.to_ascii_lowercase();
    // Pre-dispatch JSON-schema validation failures — structurally
    // recoverable, so mark them retriable so the LLM gets a chance to
    // fix its args and try again.  Checked BEFORE the generic
    // `invalid`/`schema`/`missing arg` fallbacks below so this branch
    // wins.
    if m.starts_with("arg_validation:") {
        return ("arg_validation", true);
    }
    // Capability enforcement — the trait dispatch branch emits
    // `capability_denied: <reason>`. Mirror the TS policy decision:
    // NOT retriable — re-asking the same tool with the same initiator
    // won't suddenly grant capabilities.
    if m.starts_with("capability_denied:") {
        return ("capability_denied", false);
    }
    if m.starts_with("depth_limit") || m.contains("depth_limit:") {
        return ("depth_limit", false);
    }
    if m.contains("missing") && m.contains("arg") {
        return ("validation", false);
    }
    if m.contains("invalid") || m.contains("parse") || m.contains("schema") {
        return ("validation", false);
    }
    if m.contains("timeout") || m.contains("timed out") {
        return ("timeout", true);
    }
    if m.contains("not implemented") || m.contains("unknown tool") {
        return ("fatal", false);
    }
    ("transient", true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_tool_error_timeouts_are_transient() {
        assert_eq!(
            classify_tool_error("reqwest error: operation timed out"),
            ToolErrorClass::Transient
        );
        assert_eq!(
            classify_tool_error("tool `web_fetch` timeout after 30s"),
            ToolErrorClass::Transient
        );
    }

    #[test]
    fn classify_tool_error_connection_refused_is_transient() {
        assert_eq!(
            classify_tool_error("error trying to connect: Connection refused (os error 61)"),
            ToolErrorClass::Transient
        );
        assert_eq!(
            classify_tool_error("io error: connection reset by peer"),
            ToolErrorClass::Transient
        );
    }

    #[test]
    fn classify_tool_error_5xx_is_transient() {
        assert_eq!(
            classify_tool_error("server returned HTTP 502 Bad Gateway"),
            ToolErrorClass::Transient
        );
        assert_eq!(
            classify_tool_error("upstream status 503 service unavailable"),
            ToolErrorClass::Transient
        );
        assert_eq!(
            classify_tool_error("504 gateway timeout"),
            ToolErrorClass::Transient
        );
    }

    #[test]
    fn classify_tool_error_rate_limited_is_transient() {
        assert_eq!(
            classify_tool_error("HTTP 429 Too Many Requests"),
            ToolErrorClass::Transient
        );
        assert_eq!(
            classify_tool_error("rate limit exceeded, retry in 5s"),
            ToolErrorClass::Transient
        );
    }

    #[test]
    fn classify_tool_error_not_found_is_permanent() {
        assert_eq!(
            classify_tool_error("file not found: /tmp/missing"),
            ToolErrorClass::Permanent
        );
        assert_eq!(
            classify_tool_error("HTTP 404 Not Found"),
            ToolErrorClass::Permanent
        );
    }

    #[test]
    fn classify_tool_error_permission_denied_is_permanent() {
        assert_eq!(
            classify_tool_error("os error: Permission denied"),
            ToolErrorClass::Permanent
        );
        assert_eq!(
            classify_tool_error("HTTP 403 Forbidden"),
            ToolErrorClass::Permanent
        );
        assert_eq!(
            classify_tool_error("HTTP 401 Unauthorized"),
            ToolErrorClass::Permanent
        );
    }

    #[test]
    fn classify_tool_error_validation_is_permanent() {
        assert_eq!(
            classify_tool_error("arg_validation: tool `x` args do not match schema"),
            ToolErrorClass::Permanent
        );
        assert_eq!(
            classify_tool_error("invalid input: city must be a string"),
            ToolErrorClass::Permanent
        );
        assert_eq!(
            classify_tool_error("missing string arg `city`"),
            ToolErrorClass::Permanent
        );
    }

    #[test]
    fn classify_tool_error_unknown_by_default() {
        assert_eq!(
            classify_tool_error("something weird happened at layer 7"),
            ToolErrorClass::Unknown
        );
    }

    #[test]
    fn dispatch_classify_error_marks_arg_validation_retriable() {
        let (kind, retriable) = classify_error(
            "arg_validation: tool `x` args do not match schema — /city: is required",
        );
        assert_eq!(kind, "arg_validation");
        assert!(retriable);
    }

    #[test]
    fn dispatch_classify_error_preserves_validation_not_retriable() {
        let (kind, retriable) = classify_error("missing string arg `city`");
        assert_eq!(kind, "validation");
        assert!(!retriable);
    }

    // -----------------------------------------------------------------------
    // HTTP_STATUS_RE — anchored regex for classify_tool_error
    // -----------------------------------------------------------------------

    #[test]
    fn http_status_re_matches_http_400_bad_request() {
        let re = regex::Regex::new(r"(?i)http (4\d{2}|5\d{2})").unwrap();
        assert!(re.is_match("http 400 bad request"), "must match canonical 4xx");
        assert_eq!(
            classify_tool_error("http 400 bad request"),
            ToolErrorClass::Permanent,
        );
    }

    #[test]
    fn http_status_re_matches_anthropic_http_503() {
        let re = regex::Regex::new(r"(?i)http (4\d{2}|5\d{2})").unwrap();
        assert!(re.is_match("anthropic http 503:"), "must match provider-prefixed 5xx");
    }

    #[test]
    fn http_status_re_matches_uppercase_http_429() {
        let re = regex::Regex::new(r"(?i)http (4\d{2}|5\d{2})").unwrap();
        assert!(re.is_match("HTTP 429 too many requests"), "must be case-insensitive");
        assert_eq!(
            classify_tool_error("HTTP 429 too many requests"),
            ToolErrorClass::Transient,
            "429 must be Transient"
        );
    }

    #[test]
    fn http_status_re_matches_mixed_case_http_502() {
        let re = regex::Regex::new(r"(?i)http (4\d{2}|5\d{2})").unwrap();
        assert!(re.is_match("Http 502 bad gateway"), "must match mixed-case HTTP prefix");
        assert_eq!(
            classify_tool_error("Http 502 bad gateway"),
            ToolErrorClass::Transient,
        );
    }

    #[test]
    fn http_status_re_matches_embedded_http_503() {
        let re = regex::Regex::new(r"(?i)http (4\d{2}|5\d{2})").unwrap();
        assert!(
            re.is_match("server returned HTTP 503 Service Unavailable"),
            "must match 'http <code>' embedded in a longer message"
        );
        assert_eq!(
            classify_tool_error("server returned HTTP 503 Service Unavailable"),
            ToolErrorClass::Transient,
        );
    }

    #[test]
    fn http_status_re_matches_upstream_http_401() {
        let re = regex::Regex::new(r"(?i)http (4\d{2}|5\d{2})").unwrap();
        assert!(re.is_match("upstream: http 401 unauthorized"), "must match 4xx with colon prefix");
        assert_eq!(
            classify_tool_error("upstream: http 401 unauthorized"),
            ToolErrorClass::Permanent,
            "401 must be Permanent"
        );
    }

    #[test]
    fn http_status_re_does_not_match_processed_400_items() {
        assert!(
            !HTTP_STATUS_RE.is_match("processed 400 items"),
            "bare '400' without 'http' prefix must not match"
        );
    }

    #[test]
    fn http_status_re_does_not_match_code_5000() {
        assert!(
            !HTTP_STATUS_RE.is_match("code 5000"),
            "4-digit number must not match even if it starts with 5"
        );
    }

    #[test]
    fn http_status_re_does_not_match_error_14003() {
        assert!(
            !HTTP_STATUS_RE.is_match("error 14003"),
            "'14003' is not a valid 3-digit HTTP code; should not match"
        );
    }

    #[test]
    fn http_status_re_does_not_match_bare_500() {
        assert!(
            !HTTP_STATUS_RE.is_match("internal error 500 occurred"),
            "bare '500' without 'http ' prefix must not match"
        );
    }
}
