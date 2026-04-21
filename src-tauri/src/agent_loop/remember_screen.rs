//! `remember_screen` — capture the screen, OCR it, describe it, write to memory.
//!
//! Canonical use: Sunny is looking at something (a receipt, a long thread, a
//! whiteboard photo, a banking statement) and says "SUNNY, remember this."
//! The composite tool:
//!   1. Full-screen capture via `vision::capture_full_screen`
//!   2. OCR via `ocr::ocr_image_base64` (tesseract + vision heuristics)
//!   3. Vision description via local Ollama (minicpm-v / llava) — best
//!      effort; skipped silently if no vision model is installed so a
//!      missing `minicpm-v:8b` doesn't break the OCR-only workflow.
//!   4. Write to episodic memory via `memory::episodic::note_add`
//!
//! Optional `note` parameter appends a human-written tag so the user can
//! find the capture later ("remember this — Sunny's receipt from last week").
//! The memory row is tagged `screen-capture` for programmatic retrieval.

use serde_json::Value;

use super::tools_vision::{image_describe, ImageDescribeInput};
use crate::memory;
use crate::ocr;
use crate::vision;

/// Cap the text we actually write into memory. OCR can produce tens of
/// thousands of characters from a full desktop; storing all of it
/// bloats the memory DB and poisons future FTS queries with noise.
/// 8 KB is plenty to remember a receipt, an email thread, or a photo
/// of a whiteboard.
const MAX_OCR_CHARS: usize = 8_192;

pub async fn remember_screen(note: Option<&str>) -> Result<String, String> {
    // 1. Capture. None = the primary display.
    let img = vision::capture_full_screen(None)
        .await
        .map_err(|e| format!("remember_screen capture: {e}"))?;

    // Keep the base64 around for the vision describe pass — `ocr_image_base64`
    // takes ownership, so we clone before handing it over.
    let png_b64 = img.base64.clone();

    // 2. OCR. Default options are fine for general desktop text.
    let result = ocr::ocr_image_base64(img.base64, None)
        .await
        .map_err(|e| format!("remember_screen ocr: {e}"))?;

    let ocr_text = result.text.trim();
    if ocr_text.is_empty() {
        return Ok(
            "Captured the screen but OCR found no readable text. \
             Nothing worth remembering."
                .to_string(),
        );
    }

    // 3. Ask the local vision model for a short description. This is
    //    best-effort: if Ollama isn't running, neither vision model is
    //    pulled, or the call times out, we log and continue with OCR-only
    //    rather than fail the whole save. Voice commands like "remember
    //    this" should keep working even if vision is offline.
    let description = match image_describe(ImageDescribeInput {
        path: None,
        base64: Some(png_b64),
        prompt: None,
    })
    .await
    {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(e) => {
            log::info!("remember_screen: vision describe unavailable ({e}); saving OCR-only");
            None
        }
    };

    // 4. Compose the memory body. Shape it so future FTS queries can
    //    find it — the note (if any) goes first, then the vision
    //    description (if any), then a separator, then the OCR text
    //    truncated to MAX_OCR_CHARS.
    let mut body = String::with_capacity(MAX_OCR_CHARS + 512);
    if let Some(n) = note.map(str::trim).filter(|s| !s.is_empty()) {
        body.push_str(n);
        body.push_str("\n---\n");
    }
    if let Some(desc) = description.as_deref() {
        body.push_str("Vision description: ");
        body.push_str(desc);
        body.push_str("\n---\n");
    }
    let clipped = if ocr_text.chars().count() > MAX_OCR_CHARS {
        let mut s: String = ocr_text.chars().take(MAX_OCR_CHARS).collect();
        s.push_str("\n…[truncated]");
        s
    } else {
        ocr_text.to_string()
    };
    body.push_str(&clipped);

    // Tags — 'screen-capture' plus any word-tokens from the note so
    // "remember my banking statement" surfaces the right capture when
    // Sunny later asks "find my banking statement". A second tag
    // ("vision-described") lets future recall queries tell captures
    // with a model-generated description apart from OCR-only ones.
    let mut tags = vec!["screen-capture".to_string()];
    if description.is_some() {
        tags.push("vision-described".to_string());
    }
    if let Some(n) = note {
        for tok in n.split_whitespace() {
            let t = tok.trim_matches(|c: char| !c.is_alphanumeric()).to_ascii_lowercase();
            if t.len() >= 3 && !tags.iter().any(|x| *x == t) {
                tags.push(t);
            }
        }
    }

    let item = memory::episodic::note_add(body.clone(), tags)
        .map_err(|e| format!("remember_screen write: {e}"))?;

    let summary_len = std::cmp::min(body.chars().count(), 200);
    let preview: String = body.chars().take(summary_len).collect();

    let vision_tag = if description.is_some() {
        " + vision description"
    } else {
        ""
    };
    Ok(format!(
        "Saved a screen capture to memory ({} OCR chars{}, id={}). Preview: {}",
        clipped.chars().count(),
        vision_tag,
        item.id,
        preview
    ))
}

pub fn parse_input(input: &Value) -> Result<Option<String>, String> {
    Ok(input
        .get("note")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}
