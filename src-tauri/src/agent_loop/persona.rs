//! Persona writes — mutate `~/.sunny/HEARTBEAT.md`.
//!
//! DANGEROUS. The only tool here rewrites the autogen block of
//! HEARTBEAT.md — the three-paragraph TONE / FOCUS / NOTES body refreshed
//! nightly by the `heartbeat-refresh` scheduler template.
//!
//! Only the text between `<!-- heartbeat:autogen:begin -->` and
//! `<!-- heartbeat:autogen:end -->` is replaced. Everything outside the
//! fence (architecture, passive / active heartbeats, continuity) is
//! preserved byte-for-byte. Missing markers are a structured error —
//! never an append.

use std::path::PathBuf;

const BEGIN_MARK: &str = "<!-- heartbeat:autogen:begin -->";
const END_MARK: &str = "<!-- heartbeat:autogen:end -->";

/// Resolve `~/.sunny/HEARTBEAT.md`. Fails when `HOME` isn't set.
fn heartbeat_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home_dir unavailable".to_string())?;
    Ok(home.join(".sunny").join("HEARTBEAT.md"))
}

/// Replace the autogen block with `body`, preserving the wrapper markers
/// and everything outside them. Trims whitespace on `body` then pads a
/// blank line above and below so the markdown renders cleanly.
pub fn splice_autogen(current: &str, body: &str) -> Result<String, String> {
    let begin = current
        .find(BEGIN_MARK)
        .ok_or_else(|| format!("HEARTBEAT.md missing {BEGIN_MARK} marker"))?;
    let end = current
        .find(END_MARK)
        .ok_or_else(|| format!("HEARTBEAT.md missing {END_MARK} marker"))?;
    if end < begin {
        return Err("HEARTBEAT.md markers are out of order".to_string());
    }

    let prefix_end = begin + BEGIN_MARK.len();
    let prefix = &current[..prefix_end];
    let suffix = &current[end..];
    let trimmed = body.trim();

    Ok(format!("{prefix}\n\n{trimmed}\n\n{suffix}"))
}

/// Tool entry — read HEARTBEAT.md, splice `body` into the autogen fence,
/// write it back. Returns a short confirmation on success.
pub async fn update_heartbeat(body: &str) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("persona_update_heartbeat: body is empty".to_string());
    }
    if body.len() > 8_000 {
        return Err(format!(
            "persona_update_heartbeat: body is {} bytes, cap is 8000",
            body.len()
        ));
    }
    let path = heartbeat_path()?;
    let current = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let next = splice_autogen(&current, body)?;
    tokio::fs::write(&path, next.as_bytes())
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(format!(
        "HEARTBEAT.md updated ({} bytes).",
        body.trim().len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# HEARTBEAT\n\npreamble text\n\n---\n<!-- heartbeat:autogen:begin -->\n\nold tone.\n\nold focus.\n\nold notes.\n\n<!-- heartbeat:autogen:end -->\n";

    #[test]
    fn splice_replaces_autogen_block() {
        let out = splice_autogen(SAMPLE, "new body").expect("splice ok");
        assert!(out.contains("preamble text"), "preamble preserved");
        assert!(out.contains("new body"), "new body injected");
        assert!(!out.contains("old tone"), "old body gone");
        assert!(out.contains(BEGIN_MARK));
        assert!(out.contains(END_MARK));
    }

    #[test]
    fn splice_trims_body_whitespace() {
        let out = splice_autogen(SAMPLE, "\n\n   padded body   \n\n").expect("splice ok");
        assert!(out.contains("\n\npadded body\n\n"));
    }

    #[test]
    fn splice_fails_without_begin_marker() {
        let bad = "# no markers here\n\nbody\n";
        let err = splice_autogen(bad, "x").unwrap_err();
        assert!(err.contains("heartbeat:autogen:begin"));
    }

    #[test]
    fn splice_fails_without_end_marker() {
        let bad = "<!-- heartbeat:autogen:begin -->\nbody with no closer\n";
        let err = splice_autogen(bad, "x").unwrap_err();
        assert!(err.contains("heartbeat:autogen:end"));
    }

    #[test]
    fn splice_fails_on_swapped_markers() {
        let bad = "<!-- heartbeat:autogen:end -->\nbody\n<!-- heartbeat:autogen:begin -->\n";
        let err = splice_autogen(bad, "x").unwrap_err();
        assert!(err.contains("out of order"));
    }
}
