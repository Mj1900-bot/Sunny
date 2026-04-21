//! Shared AppleScript helpers used by `tools_browser`, `mail`, and
//! `scan/commands`.
//!
//! A single canonical `escape_applescript` lives here so callers don't each
//! maintain their own copy. The semantics chosen: char-by-char substitution
//! of the escape sequences AppleScript's `osascript -e` recognises — `\"`,
//! `\\`, `\n`, `\r`, `\t` — while passing all other characters (including
//! multi-byte Unicode) through unchanged. Control-character stripping is
//! deliberately omitted; callers that need it can pre-filter their input.

/// Escape a Rust string for safe embedding inside an AppleScript double-quoted
/// string literal.
///
/// AppleScript recognises `\"`, `\\`, `\n`, `\r`, `\t` inside a `-e` argument
/// passed to `osascript`; everything else (including arbitrary Unicode) is
/// UTF-8 clean via the `-e` path and can be left alone.
pub fn escape_applescript(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"'  => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _    => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_applescript_handles_standard_escapes() {
        assert_eq!(escape_applescript("plain"), "plain");
        assert_eq!(escape_applescript(r#"a"b"#), r#"a\"b"#);
        assert_eq!(escape_applescript(r#"a\b"#), r#"a\\b"#);
        assert_eq!(escape_applescript("a\nb"), "a\\nb");
        assert_eq!(escape_applescript("a\rb"), "a\\rb");
        assert_eq!(escape_applescript("a\tb"), "a\\tb");
    }

    #[test]
    fn escape_applescript_preserves_unicode() {
        assert_eq!(escape_applescript("café"), "café");
        assert_eq!(escape_applescript("日本語"), "日本語");
    }
}
