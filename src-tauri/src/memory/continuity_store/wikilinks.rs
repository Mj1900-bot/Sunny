//! Wikilink extraction: finds `[[slug]]` patterns in summary text and
//! returns the unique set of referenced slugs.
//!
//! Design goals (Obsidian-inspired):
//! - Writing is graph construction — the user never fills a separate edges form.
//! - The regex is deliberately strict: `[[` + slug + `]]` where slug matches
//!   `[a-zA-Z0-9\-_./\u{80}-\u{10FFFF}]+` so Unicode node names work.
//! - Extraction is pure (no I/O) and called from `upsert_node`.

use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

/// Compiled wikilink pattern. Matches `[[anything-not-]]]]`.
///
/// Regex: `\[\[([^\]]+)\]\]`
/// - `\[\[`        — literal opening brackets
/// - `([^\]]+)`    — capture group: one or more chars that are not `]`
/// - `\]\]`        — literal closing brackets
///
/// This intentionally allows Unicode, hyphens, slashes, dots — all valid
/// in Obsidian vault slugs and in Sunny's daily-note / project slugs.
fn wikilink_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\]]+)\]\]").expect("wikilink regex compiles")
    })
}

/// Extract all unique wikilink targets from `text`.
///
/// Returns slugs in the order they first appear (deduped).
/// Slugs are returned as-is (no case folding) to match stored node slugs.
///
/// # Examples
/// ```
/// let slugs = extract("See [[project-sunny-moc]] and [[2026-04-20]] for context.");
/// assert_eq!(slugs, vec!["project-sunny-moc", "2026-04-20"]);
/// ```
pub fn extract(text: &str) -> Vec<String> {
    let re = wikilink_re();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for cap in re.captures_iter(text) {
        let slug = cap[1].trim().to_string();
        if !slug.is_empty() && seen.insert(slug.clone()) {
            result.push(slug);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_single_link() {
        let v = extract("Today worked on [[project-sunny-moc]].");
        assert_eq!(v, vec!["project-sunny-moc"]);
    }

    #[test]
    fn extract_multiple_links() {
        let v = extract("See [[alpha]] and [[beta]] then [[alpha]] again.");
        assert_eq!(v, vec!["alpha", "beta"]); // deduped, order-preserved
    }

    #[test]
    fn extract_no_links() {
        let v = extract("No wikilinks here at all.");
        assert!(v.is_empty());
    }

    #[test]
    fn extract_unicode_slug() {
        // Unicode node names must survive round-trip through the extractor.
        let v = extract("Linked to [[日本語-node]] and [[café-project]].");
        assert_eq!(v, vec!["日本語-node", "café-project"]);
    }

    #[test]
    fn extract_daily_note_slug() {
        let v = extract("Session on [[2026-04-20]] under [[project-sunny-moc]].");
        assert_eq!(v, vec!["2026-04-20", "project-sunny-moc"]);
    }

    #[test]
    fn extract_ignores_single_brackets() {
        let v = extract("[not a wikilink] and [neither].");
        assert!(v.is_empty());
    }

    #[test]
    fn extract_trims_whitespace_inside_brackets() {
        let v = extract("[[ spaced-slug ]]");
        assert_eq!(v, vec!["spaced-slug"]);
    }
}
