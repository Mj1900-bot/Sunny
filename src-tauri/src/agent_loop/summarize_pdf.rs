//! `summarize_pdf` — read a PDF off disk, run it through `pdftotext`, and
//! hand the extracted text to a summariser sub-agent for a five-bullet
//! précis.
//!
//! Canonical use: Sunny says "SUNNY, summarise this contract at
//! ~/Downloads/foo.pdf". The composite tool:
//!   1. Locates `pdftotext` on PATH (poppler). If missing, returns a
//!      structured error telling Sunny to `brew install poppler`.
//!   2. Runs `pdftotext -layout <path> -` and captures stdout.
//!   3. Trims the extracted text to `max_chars` (default 32 KB) so the
//!      sub-agent context stays cheap.
//!   4. Spawns a `summarizer` sub-agent with a short prompt asking for
//!      exactly five bullets.
//!
//! The tool is read-only — no ConfirmGate required.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use tokio::process::Command;

use super::helpers::{string_arg, usize_arg};
use super::subagents::spawn_subagent;

/// Default ceiling on extracted text we pass to the summariser. 32 KB is
/// plenty for a short paper or contract; longer docs get clipped head +
/// tail so the summary still surfaces conclusions.
const DEFAULT_MAX_CHARS: usize = 32_768;
const HARD_MAX_CHARS: usize = 200_000;
const PDFTOTEXT_TIMEOUT_SECS: u64 = 60;
/// Cap on the summariser sub-agent call. A 32 KB chunk fed to a small
/// model should never take more than 90s; cap it tightly so a hanging
/// sub-agent doesn't block the tool indefinitely.
const SUMMARISER_TIMEOUT_SECS: u64 = 90;

pub async fn summarize_pdf(
    app: &AppHandle,
    path: &str,
    max_chars: Option<usize>,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("summarize_pdf: 'path' is empty".to_string());
    }

    // 1. Resolve + sanity-check the path.
    let expanded = crate::safety_paths::expand_home(trimmed)?;
    crate::safety_paths::assert_read_allowed(&expanded)?;
    if !expanded.is_file() {
        return Err(format!(
            "summarize_pdf: not a readable file: {}",
            expanded.display()
        ));
    }

    // 2. Locate pdftotext. Use our PATH-aware helper so the tool still
    //    works when SUNNY is launched from Finder (stripped PATH).
    let pdftotext_bin = crate::paths::which("pdftotext").ok_or_else(|| {
        "summarize_pdf: pdftotext not found on PATH — install poppler via \
         `brew install poppler` (macOS) or apt-get install poppler-utils (Linux)."
            .to_string()
    })?;

    // 3. Run pdftotext <path> - → stdout. `-layout` preserves column
    //    structure for tables; `-q` silences noisy warnings.
    let run = Command::new(&pdftotext_bin)
        .arg("-layout")
        .arg("-q")
        .arg(&expanded)
        .arg("-")
        .output();

    let output = tokio::time::timeout(
        Duration::from_secs(PDFTOTEXT_TIMEOUT_SECS),
        run,
    )
    .await
    .map_err(|_| {
        format!(
            "summarize_pdf: pdftotext timed out after {PDFTOTEXT_TIMEOUT_SECS}s"
        )
    })?
    .map_err(|e| format!("summarize_pdf: failed to spawn pdftotext: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "summarize_pdf: pdftotext exit {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(format!(
            "No extractable text in {}. The file may be scanned-image only — \
             try screen_ocr or a dedicated OCR step.",
            expanded.display()
        ));
    }

    // 4. Clip to max_chars. For very long PDFs we keep a head + tail
    //    window so the summariser can still see the conclusion.
    let cap = max_chars.unwrap_or(DEFAULT_MAX_CHARS).min(HARD_MAX_CHARS);
    let clipped = clip_head_and_tail(&text, cap);
    let clipped_len = clipped.chars().count();
    let original_len = text.chars().count();

    // 5. Hand to summariser sub-agent. Prompt asks for exactly 5 bullets
    //    in plain prose with no preamble.
    let task = format!(
        "You are summarising a PDF document for Sunny. The document \
         is delimited by <document>...</document> below (extracted via \
         pdftotext, may contain layout artefacts).\n\n\
         Produce EXACTLY five bullet points. Each bullet:\n\
           • one complete sentence\n\
           • a distinct theme / fact / action item\n\
           • plain text, no markdown, no emoji, no preamble\n\n\
         Do not include a heading, intro, or closing remark. Start \
         directly with the first bullet.\n\n\
         Filename: {filename}\n\
         Extracted length: {original_len} chars (passed: {clipped_len} chars)\n\n\
         <document>\n{clipped}\n</document>\n\n\
         Write the five bullets now.",
        filename = expanded
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| expanded.display().to_string()),
    );

    let summary = tokio::time::timeout(
        Duration::from_secs(SUMMARISER_TIMEOUT_SECS),
        spawn_subagent(
            app,
            "summarizer",
            &task,
            None,
            parent_session_id.map(String::from),
            depth,
        ),
    )
    .await
    .map_err(|_| format!("summarize_pdf: summariser timed out after {SUMMARISER_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("summarize_pdf: summariser failed: {e}"))?;

    Ok(format!(
        "Summary of {filename} ({original_len} chars extracted):\n\n{summary}",
        filename = expanded
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| expanded.display().to_string()),
        original_len = original_len,
        summary = summary.trim()
    ))
}

/// Keep the first 60% and last 40% of `s` when it exceeds `cap` chars.
/// Short inputs are returned unchanged.
fn clip_head_and_tail(s: &str, cap: usize) -> String {
    let total = s.chars().count();
    if total <= cap {
        return s.to_string();
    }
    let head = (cap as f64 * 0.6).round() as usize;
    let tail = cap.saturating_sub(head);
    let head_s: String = s.chars().take(head).collect();
    let tail_s: String = s.chars().skip(total.saturating_sub(tail)).collect();
    format!(
        "{head_s}\n\n…[truncated {n} chars]…\n\n{tail_s}",
        n = total.saturating_sub(head + tail)
    )
}

pub fn parse_input(input: &Value) -> Result<(String, Option<usize>), String> {
    let path = string_arg(input, "path")?;
    let max_chars = usize_arg(input, "max_chars");
    Ok((path, max_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_returns_short_unchanged() {
        let s = "hello world";
        assert_eq!(clip_head_and_tail(s, 1_000), s);
    }

    #[test]
    fn clip_splits_head_and_tail() {
        let s: String = "x".repeat(1_000);
        let out = clip_head_and_tail(&s, 100);
        assert!(out.contains("…[truncated"));
        assert!(out.chars().count() < s.chars().count());
    }

    #[test]
    fn parse_input_requires_path() {
        let v: Value = serde_json::json!({});
        assert!(parse_input(&v).is_err());
    }

    #[test]
    fn parse_input_accepts_max_chars() {
        let v: Value = serde_json::json!({"path":"~/foo.pdf","max_chars":500});
        let (path, mc) = parse_input(&v).unwrap();
        assert_eq!(path, "~/foo.pdf");
        assert_eq!(mc, Some(500));
    }
}
