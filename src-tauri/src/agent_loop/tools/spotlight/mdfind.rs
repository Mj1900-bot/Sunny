//! mdfind query builder and runner.
//!
//! Wraps the macOS `mdfind` CLI. All query strings are passed as a single
//! argument to avoid shell injection — we use `Command::arg` (not `arg_os`
//! with a shell) so the OS sees the query as one literal token.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// A single Spotlight search result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpotlightEntry {
    /// Absolute path to the item.
    pub path: String,
    /// Coarse kind: `"file"`, `"folder"`, `"app"`, `"email"`, or `"other"`.
    pub kind: String,
    /// Last-modified Unix timestamp in seconds (0 if unavailable).
    pub modified_secs: i64,
}

/// Build an `mdfind` query that respects the optional `kind` filter.
///
/// `kind` supports the shorthand strings the user writes (`pdf`, `image`,
/// `app`, `email`, `folder`, `today`, `yesterday`, `thisweek`) and maps them
/// to the appropriate `kMDItem*` predicates.  The text query is escaped so
/// special characters (`"`, `\`) cannot escape the predicate string.
///
/// Returns the full predicate string ready to pass as `mdfind`'s `-onlyin` /
/// positional argument.
pub fn build_mdfind_query(text: &str, kind: Option<&str>) -> String {
    // Escape the user-supplied text: backslash then double-quote.
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");

    let text_pred = format!("kMDItemTextContent == \"*{escaped}*\"cdw || kMDItemDisplayName == \"*{escaped}*\"cdw");

    match kind.map(|k| k.to_lowercase()).as_deref() {
        Some("pdf") => format!("({text_pred}) && kMDItemContentTypeTree == \"com.adobe.pdf\""),
        Some("image") | Some("img") => {
            format!("({text_pred}) && kMDItemContentTypeTree == \"public.image\"")
        }
        Some("app") | Some("application") => {
            format!("({text_pred}) && kMDItemContentTypeTree == \"com.apple.application\"")
        }
        Some("email") | Some("mail") => {
            format!("({text_pred}) && kMDItemContentTypeTree == \"com.apple.mail.emlx\"")
        }
        Some("folder") | Some("directory") => {
            format!("({text_pred}) && kMDItemContentType == \"public.folder\"")
        }
        Some("today") => {
            let since = epoch_secs_ago(86_400);
            format!("({text_pred}) && kMDItemFSContentChangeDate >= $time.iso({since})")
        }
        Some("yesterday") => {
            let from = epoch_secs_ago(2 * 86_400);
            let to = epoch_secs_ago(86_400);
            format!("({text_pred}) && kMDItemFSContentChangeDate >= $time.iso({from}) && kMDItemFSContentChangeDate < $time.iso({to})")
        }
        Some("thisweek") => {
            let since = epoch_secs_ago(7 * 86_400);
            format!("({text_pred}) && kMDItemFSContentChangeDate >= $time.iso({since})")
        }
        _ => text_pred,
    }
}

/// Build a recency query: items modified within `hours` hours.
pub fn build_recency_query(hours: u64, kind: Option<&str>) -> String {
    let since = epoch_secs_ago(hours * 3600);
    let time_pred = format!("kMDItemFSContentChangeDate >= $time.iso({since})");

    match kind.map(|k| k.to_lowercase()).as_deref() {
        Some("pdf") => {
            format!("({time_pred}) && kMDItemContentTypeTree == \"com.adobe.pdf\"")
        }
        Some("image") | Some("img") => {
            format!("({time_pred}) && kMDItemContentTypeTree == \"public.image\"")
        }
        Some("app") | Some("application") => {
            format!("({time_pred}) && kMDItemContentTypeTree == \"com.apple.application\"")
        }
        Some("folder") | Some("directory") => {
            format!("({time_pred}) && kMDItemContentType == \"public.folder\"")
        }
        _ => time_pred,
    }
}

/// Run `mdfind` with the given predicate. Returns at most `limit` entries.
pub async fn run_mdfind(predicate: &str, limit: usize) -> Result<Vec<SpotlightEntry>, String> {
    // Budget-gate: agents can issue rapid-fire searches while narrowing
    // on files — acquire a permit so each search still runs but the
    // kernel fork budget stays protected.
    let _guard = crate::process_budget::SpawnGuard::acquire().await?;

    let output = Command::new("mdfind")
        .arg(predicate)
        .output()
        .await
        .map_err(|e| format!("mdfind spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("mdfind exited with error: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<SpotlightEntry> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .take(limit)
        .map(|path| {
            let kind = infer_kind(path);
            let modified_secs = file_modified_secs(path);
            SpotlightEntry {
                path: path.to_string(),
                kind,
                modified_secs,
            }
        })
        .collect();

    Ok(entries)
}

/// Run a tag-specific mdfind query.
pub async fn run_tag_search(tag: &str, limit: usize) -> Result<Vec<SpotlightEntry>, String> {
    // Escape tag value: only allow alphanumeric + space + dash for safety.
    let safe_tag: String = tag
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect();

    if safe_tag.is_empty() {
        return Err("tag must contain at least one alphanumeric character".to_string());
    }

    let predicate = format!("kMDItemUserTags == \"{safe_tag}\"");
    run_mdfind(&predicate, limit).await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn epoch_secs_ago(secs: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    let past = now.saturating_sub(secs);
    // mdfind expects ISO-8601; we use the numeric epoch variant which mdfind
    // also accepts as a POSIX timestamp after `$time.iso()`.
    // Actually use the RFC3339 form that mdfind understands: YYYY-MM-DDTHH:MM:SSZ
    let dt = chrono::DateTime::from_timestamp(past as i64, 0)
        .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH);
    dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn infer_kind(path: &str) -> String {
    // Check extension-based kinds first. On macOS app bundles are directories,
    // so `.app` must win over the `is_dir` folder check below.
    let lower = path.to_lowercase();
    if lower.ends_with(".app") {
        return "app".to_string();
    }
    if lower.ends_with(".emlx") || lower.ends_with(".eml") {
        return "email".to_string();
    }
    if path.ends_with('/') || std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
        return "folder".to_string();
    }
    "file".to_string()
}

fn file_modified_secs(path: &str) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .and_then(|t| t.duration_since(UNIX_EPOCH).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- query escaping -------------------------------------------------------

    #[test]
    fn query_escapes_double_quotes() {
        let q = build_mdfind_query(r#"he said "hello""#, None);
        // Must not contain unescaped double quotes inside the predicate values.
        assert!(q.contains(r#"he said \"hello\""#), "got: {q}");
    }

    #[test]
    fn query_escapes_backslash() {
        let q = build_mdfind_query(r"C:\Users\foo", None);
        assert!(q.contains(r"C:\\Users\\foo"), "got: {q}");
    }

    #[test]
    fn query_no_kind_is_text_only() {
        let q = build_mdfind_query("budget", None);
        assert!(q.contains("kMDItemDisplayName"));
        assert!(!q.contains("ContentTypeTree"));
    }

    #[test]
    fn query_kind_pdf() {
        let q = build_mdfind_query("invoice", Some("pdf"));
        assert!(q.contains("com.adobe.pdf"), "got: {q}");
    }

    #[test]
    fn query_kind_image() {
        let q = build_mdfind_query("photo", Some("image"));
        assert!(q.contains("public.image"), "got: {q}");
    }

    #[test]
    fn query_kind_app() {
        let q = build_mdfind_query("xcode", Some("app"));
        assert!(q.contains("com.apple.application"), "got: {q}");
    }

    #[test]
    fn query_kind_email() {
        let q = build_mdfind_query("invoice", Some("email"));
        assert!(q.contains("com.apple.mail"), "got: {q}");
    }

    #[test]
    fn query_kind_today_has_time_pred() {
        let q = build_mdfind_query("notes", Some("today"));
        assert!(q.contains("kMDItemFSContentChangeDate"), "got: {q}");
        assert!(q.contains("$time.iso("), "got: {q}");
    }

    #[test]
    fn query_kind_thisweek_has_time_pred() {
        let q = build_mdfind_query("notes", Some("thisweek"));
        assert!(q.contains("kMDItemFSContentChangeDate"), "got: {q}");
    }

    // -- recency query --------------------------------------------------------

    #[test]
    fn recency_query_bare() {
        let q = build_recency_query(24, None);
        assert!(q.contains("kMDItemFSContentChangeDate"));
        assert!(q.contains("$time.iso("));
    }

    #[test]
    fn recency_query_pdf_kind() {
        let q = build_recency_query(1, Some("pdf"));
        assert!(q.contains("com.adobe.pdf"));
        assert!(q.contains("kMDItemFSContentChangeDate"));
    }

    // -- tag search -----------------------------------------------------------

    #[test]
    fn tag_search_strips_dangerous_chars() {
        // This is a pure-compute test — no async runtime needed.
        // We test `safe_tag` construction directly.
        let tag = "red; rm -rf /";
        let safe: String = tag
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
            .collect();
        assert_eq!(safe, "red rm -rf ");
        assert!(!safe.contains(';'));
        assert!(!safe.contains('/'));
    }

    #[test]
    fn tag_search_empty_after_strip_is_caught() {
        // Characters that would all be stripped leave an empty safe_tag,
        // which the async fn would catch. We validate the same logic inline.
        let tag = ";;;///";
        let safe: String = tag
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
            .collect();
        assert!(safe.trim().is_empty());
    }

    // -- infer_kind -----------------------------------------------------------

    #[test]
    fn infer_kind_app() {
        assert_eq!(infer_kind("/Applications/Xcode.app"), "app");
    }

    #[test]
    fn infer_kind_email() {
        assert_eq!(infer_kind("/var/mail/msg.emlx"), "email");
    }

    #[test]
    fn infer_kind_file_fallback() {
        assert_eq!(infer_kind("/tmp/foo.pdf"), "file");
    }
}
