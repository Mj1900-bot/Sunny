//! `document_summarize` — route document text through GLM-5.1 for a summary.
//!
//! Detects file type from extension, extracts text via the appropriate
//! extractor, then calls `glm_turn` with a concise summarization prompt.
//! Reuses the existing Z.AI/GLM provider — no new network dependency.
//!
//! Supported: `.pdf`, `.docx`, `.xlsx`, `.xls`, `.ods`, `.csv`
//! `max_length` controls the approximate target word count (default 500).

use serde_json::Value;

use crate::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use crate::agent_loop::types::TurnOutcome;

use super::csv_read;
use super::docx_extract;
use super::pdf_extract;
use super::xlsx_read;
use super::path_util;

/// Summarize a document via GLM-5.1.  Extracts text from the given path,
/// then asks the model for a summary of at most `max_length` words.
pub async fn summarize(raw_path: &str, max_length: u32) -> Result<String, String> {
    let text = extract_document_text(raw_path)?;

    if text.trim().is_empty() {
        return Ok("Document appears to contain no extractable text (may be image-only or empty).".to_string());
    }

    // Truncate to ~16 000 chars so we don't blow the GLM context window.
    const TEXT_LIMIT: usize = 16_000;
    let truncated = if text.len() > TEXT_LIMIT {
        format!("{}…[truncated]", &text[..TEXT_LIMIT])
    } else {
        text.clone()
    };

    let prompt = format!(
        "Summarize the following document in approximately {max_length} words or fewer. \
         Be concise, accurate, and preserve key facts, dates, and names.\n\n{truncated}"
    );

    let history = [serde_json::json!({ "role": "user", "content": prompt })];

    match glm_turn(DEFAULT_GLM_MODEL, "You are a precise document summarizer.", &history).await {
        Ok(TurnOutcome::Final { text, .. }) => Ok(text),
        Ok(TurnOutcome::Tools { .. }) => Err(
            "unexpected tool call from summarizer — please retry".to_string(),
        ),
        Err(e) => Err(format!("summarization failed: {e}")),
    }
}

/// Route to the appropriate text extractor based on file extension.
fn extract_document_text(raw_path: &str) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "pdf" => {
            let json_out = pdf_extract::extract_text(raw_path, None)?;
            let v: Value =
                serde_json::from_str(&json_out).map_err(|e| format!("json parse: {e}"))?;
            let mut parts: Vec<String> = Vec::new();
            if let Some(arr) = v.as_array() {
                for page in arr {
                    if let Some(t) = page.get("text").and_then(|x| x.as_str()) {
                        parts.push(t.to_string());
                    }
                }
            }
            Ok(parts.join("\n\n"))
        }
        "docx" => {
            let json_out = docx_extract::extract_text(raw_path)?;
            let v: Value =
                serde_json::from_str(&json_out).map_err(|e| format!("json parse: {e}"))?;
            Ok(v["text"].as_str().unwrap_or("").to_string())
        }
        "xlsx" | "xls" | "ods" => {
            let json_out = xlsx_read::read(raw_path, None, None)?;
            let v: Value =
                serde_json::from_str(&json_out).map_err(|e| format!("json parse: {e}"))?;
            Ok(format_spreadsheet_as_text(&v))
        }
        "csv" => {
            let json_out = csv_read::read(raw_path, true)?;
            let v: Value =
                serde_json::from_str(&json_out).map_err(|e| format!("json parse: {e}"))?;
            Ok(format_csv_as_text(&v))
        }
        other => Err(format!(
            "unsupported file extension `.{other}` — supported: pdf, docx, xlsx, xls, ods, csv"
        )),
    }
}

fn format_spreadsheet_as_text(v: &Value) -> String {
    let sheet = v["sheet"].as_str().unwrap_or("sheet");
    let rows = v["rows"].as_array().cloned().unwrap_or_default();
    let lines: Vec<String> = rows
        .iter()
        .map(|row| {
            row.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .map(|c| match c {
                            Value::Null => String::new(),
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join("\t")
                })
                .unwrap_or_default()
        })
        .collect();
    format!("[Sheet: {sheet}]\n{}", lines.join("\n"))
}

fn format_csv_as_text(v: &Value) -> String {
    let headers = v["headers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|h| h.as_str().unwrap_or("").to_string())
        .collect::<Vec<_>>()
        .join(",");

    let rows = v["rows"].as_array().cloned().unwrap_or_default();
    let lines: Vec<String> = rows
        .iter()
        .map(|row| {
            row.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .map(|c| c.as_str().unwrap_or("").to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default()
        })
        .collect();

    if headers.is_empty() {
        lines.join("\n")
    } else {
        format!("{headers}\n{}", lines.join("\n"))
    }
}
