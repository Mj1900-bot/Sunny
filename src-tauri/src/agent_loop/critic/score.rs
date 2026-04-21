//! # Critic score parsing helpers
//!
//! Extracted from `critic.rs` to keep that file under the 800-line budget.
//! All helpers are pure functions — no I/O, no `AppHandle` dependency.

use serde_json::Value;

/// Hard sanity cap on how many issues we'll accept from the critic. A
/// model that returns 200 "issues" is either hallucinating, being
/// prompt-injected, or looping — none of which should trigger a
/// refiner hop.
pub(super) const MAX_CRITIC_ISSUES: usize = 20;

/// Parse the critic's reply and decide whether there are actionable
/// issues worth spending a refiner hop on.
///
/// Accepted shapes (in preference order):
///   1. `{"issues": [ {...}, ... ]}` — the canonical envelope.
///   2. `[ {...}, ... ]` — a bare issues array, for backwards
///      compatibility with critics that haven't been re-prompted yet.
///
/// Anything else — prose, malformed JSON, the wrong top-level shape —
/// is treated as "no issues" (safe default: the original draft ships).
///
/// We also enforce sanity bounds: 0-`MAX_CRITIC_ISSUES` entries, each
/// of which must be an object. A reply claiming 200 issues is almost
/// certainly a hallucination or an injection attempt, and we refuse
/// to honour it.
pub(super) fn has_actionable_issues(s: &str) -> bool {
    matches!(parse_critic_issues(s), Some(n) if n > 0)
}

/// Parse the critic's reply into an issue count, or `None` if the
/// reply is not a recognisable envelope. Extracted so tests can assert
/// on the exact count, not just the boolean.
pub(super) fn parse_critic_issues(s: &str) -> Option<usize> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }

    let first_obj = trimmed.find('{');
    let first_arr = trimmed.find('[');

    let try_object_first = match (first_obj, first_arr) {
        (Some(o), Some(a)) => o < a,
        (Some(_), None) => true,
        (None, _) => false,
    };

    if try_object_first {
        if let Some(slice) = outermost_json_span(trimmed, '{', '}') {
            if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(slice) {
                return match obj.get("issues") {
                    Some(Value::Array(items)) => validate_issues_array(items),
                    _ => None,
                };
            }
        }
        return None;
    }

    if let Some(slice) = outermost_json_span(trimmed, '[', ']') {
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(slice) {
            return validate_issues_array(&items);
        }
    }
    None
}

/// Validate an `issues` array: every element must be a JSON object,
/// length must be within `[0, MAX_CRITIC_ISSUES]`. Returns the count
/// when valid, `None` when the array is malformed or out of bounds.
pub(super) fn validate_issues_array(items: &[Value]) -> Option<usize> {
    if items.len() > MAX_CRITIC_ISSUES {
        return None;
    }
    if !items.iter().all(|v| v.is_object()) {
        return None;
    }
    Some(items.len())
}

/// Locate the outermost balanced span delimited by `open`/`close`,
/// respecting JSON string literals so braces inside quoted values
/// don't throw off the nesting count. Returns the slice *including*
/// the delimiters, ready for `serde_json::from_str`.
pub(super) fn outermost_json_span(s: &str, open: char, close: char) -> Option<&str> {
    let bytes = s.as_bytes();
    let start = s.find(open)?;
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
            continue;
        }
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(&s[start..=i]);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critic_envelope_parses_canonical_object_shape() {
        let reply = r#"{"issues": [{"issue": "wrong date", "severity": "high"}]}"#;
        assert_eq!(parse_critic_issues(reply), Some(1));
        assert!(has_actionable_issues(reply));
    }

    #[test]
    fn critic_envelope_empty_issues_is_no_op() {
        assert_eq!(parse_critic_issues(r#"{"issues": []}"#), Some(0));
        assert!(!has_actionable_issues(r#"{"issues": []}"#));
    }

    #[test]
    fn critic_envelope_accepts_bare_array_fallback() {
        let reply = r#"[{"issue": "tone", "severity": "low"}]"#;
        assert_eq!(parse_critic_issues(reply), Some(1));
        assert!(has_actionable_issues(reply));
    }

    #[test]
    fn critic_envelope_rejects_prose_with_fake_brackets() {
        let reply = "Sure, I'll help [see [the page] for details]";
        assert!(!has_actionable_issues(reply));
        assert_eq!(parse_critic_issues(reply), None);
    }

    #[test]
    fn critic_envelope_rejects_malformed_json() {
        assert_eq!(parse_critic_issues("{issues: [1, 2, 3]}"), None);
        assert_eq!(parse_critic_issues("not json at all"), None);
        assert_eq!(parse_critic_issues(""), None);
        assert_eq!(parse_critic_issues("   "), None);
    }

    #[test]
    fn critic_envelope_rejects_over_bound_issue_count() {
        let entries: Vec<String> = (0..=MAX_CRITIC_ISSUES)
            .map(|i| format!(r#"{{"issue": "i{i}", "severity": "low"}}"#))
            .collect();
        let reply = format!(r#"{{"issues": [{}]}}"#, entries.join(","));
        assert_eq!(parse_critic_issues(&reply), None);
        assert!(!has_actionable_issues(&reply));
    }

    #[test]
    fn critic_envelope_rejects_non_object_entries() {
        let reply = r#"{"issues": ["just a string", "another"]}"#;
        assert_eq!(parse_critic_issues(reply), None);
    }

    #[test]
    fn critic_envelope_rejects_wrong_top_level_key() {
        let reply = r#"{"problems": [{"issue": "x"}]}"#;
        assert_eq!(parse_critic_issues(reply), None);
    }

    #[test]
    fn critic_envelope_ignores_surrounding_prose() {
        let reply = r#"Here you go: {"issues": [{"issue": "typo"}]} hope that helps!"#;
        assert_eq!(parse_critic_issues(reply), Some(1));
    }

    #[test]
    fn critic_envelope_tolerates_braces_in_quoted_strings() {
        let reply = r#"{"issues": [{"issue": "use {key} placeholder", "severity": "low"}]}"#;
        assert_eq!(parse_critic_issues(reply), Some(1));
    }

    #[test]
    fn outermost_json_span_respects_string_literals() {
        let s = r#"prefix {"a": "}{"} suffix"#;
        let span = outermost_json_span(s, '{', '}').expect("found span");
        assert_eq!(span, r#"{"a": "}{"}"#);
    }
}
