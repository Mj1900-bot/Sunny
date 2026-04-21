//! SUNNY OCR — give the assistant the ability to *read* the screen as text.
//!
//! The assistant captures the screen via `crate::vision` and then feeds the
//! PNG into `tesseract`, parsing the TSV bounding-box output back into a
//! structured `OcrResult`. That enables "click the blue Submit button" style
//! instructions: the UI can look up a word/phrase, get its bounding box, and
//! drive the cursor from there.
//!
//! ## Why tesseract instead of macOS Vision?
//!
//! macOS ships VisionKit's `VNRecognizeTextRequest` in frameworks but there
//! is **no stock CLI** for it — the "Extract Text from Image" Shortcut is a
//! user-installable convenience, not a guaranteed install. Requiring a
//! pre-installed Shortcut means the feature silently breaks on every fresh
//! Mac. Instead we shell out to `tesseract`, which gives us portable OCR
//! plus bounding boxes out of the box (`--psm 6 tsv`).
//!
//! The user can `brew install tesseract` in one command; if it's missing we
//! return a clear error pointing them at that.
//!
//! ## Pipeline
//!
//! 1. Capture (or decode the caller's) PNG.
//! 2. Write it to `$TMPDIR/sunny_ocr_*.png` so tesseract can open it.
//! 3. Run `tesseract <tmp> - -l <lang> --psm <psm> -c preserve_interword_spaces=1 tsv`
//!    with a 10s timeout. PSM and language are caller-selectable via
//!    `OcrOptions`; defaults (psm=6, lang=eng) keep legacy behaviour.
//! 4. Parse the TSV into `OcrBox`es, grouping words into lines via the
//!    `(block_num, par_num, line_num)` tuple and reconstruct the plain text
//!    using each word's `left` coordinate so inter-word gaps in columnar UI
//!    text are preserved rather than collapsed to a single space.
//! 5. Always delete the tmp file, success or failure.
//!
//! All child processes get `paths::fat_path()` so a launchctl-minimal PATH
//! doesn't hide `tesseract` installed via Homebrew.
//
// NOTE: no new Cargo deps — `base64` and `tokio` are already pulled in by
// `vision.rs` and the rest of the crate.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use ts_rs::TS;

const TESSERACT_TIMEOUT: Duration = Duration::from_secs(10);
const ENGINE_TESSERACT: &str = "tesseract";

/// Structured OCR result suitable for handing to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OcrResult {
    /// Recognized text, lines joined by `\n` (reading order per tesseract).
    pub text: String,
    /// One box per recognized word.
    pub boxes: Vec<OcrBox>,
    /// Engine that produced the result — today always "tesseract".
    pub engine: String,
    /// Image width in pixels (from the PNG IHDR).
    #[ts(type = "number")]
    pub width: u32,
    /// Image height in pixels (from the PNG IHDR).
    #[ts(type = "number")]
    pub height: u32,
    /// Echo of the PSM used, so the UI can display it next to the stats.
    #[ts(type = "number")]
    pub psm: u32,
    /// Average confidence across surviving boxes (0–100). 0 if no words.
    pub avg_confidence: f64,
}

/// Caller-tunable OCR parameters. Every field is optional and defaults to
/// the classic behaviour (psm=6, lang="eng", no filter).
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct OcrOptions {
    /// Tesseract page-segmentation mode. Common useful values:
    /// `3` = fully automatic, `4` = single column, `6` = uniform block
    /// (default), `7` = single line, `11` = sparse text, `12` = sparse+OSD.
    #[ts(type = "number | null")]
    pub psm: Option<u32>,
    /// Tesseract language code(s), e.g. `"eng"`, `"eng+fra"`. Requires the
    /// corresponding `tessdata` language pack to be installed.
    pub lang: Option<String>,
    /// Minimum confidence (0–100) for a word to appear in `boxes` / `text`.
    /// Anything below is dropped. `None` or `0` means no filter.
    pub min_conf: Option<f64>,
}

/// Axis-aligned bounding box for a recognized word.
///
/// Coordinates are in **image pixel space** (top-left origin), matching the
/// PNG that was fed in. Callers can map them back to screen coordinates by
/// adding the capture region's origin.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OcrBox {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 0.0 — 100.0, as reported by tesseract's `conf` column.
    pub confidence: f64,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// OCR a rectangle of the screen. Delegates to `vision::capture_region` and
/// then runs the tesseract pipeline.
pub async fn ocr_region(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    options: Option<OcrOptions>,
) -> Result<OcrResult, String> {
    let img = crate::vision::capture_region(x, y, w, h).await?;
    ocr_png_base64_inner(&img.base64, options.unwrap_or_default()).await
}

/// OCR a full display. `display` is 1-based (matches `screencapture -D`);
/// `None` means the main display.
pub async fn ocr_full_screen(
    display: Option<usize>,
    options: Option<OcrOptions>,
) -> Result<OcrResult, String> {
    let img = crate::vision::capture_full_screen(display).await?;
    ocr_png_base64_inner(&img.base64, options.unwrap_or_default()).await
}

/// OCR a caller-supplied PNG that's already base64-encoded. Accepts either a
/// raw base64 string or one with a `data:image/png;base64,` prefix.
pub async fn ocr_image_base64(
    png_base64: String,
    options: Option<OcrOptions>,
) -> Result<OcrResult, String> {
    ocr_png_base64_inner(&png_base64, options.unwrap_or_default()).await
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async fn ocr_png_base64_inner(png_base64: &str, opts: OcrOptions) -> Result<OcrResult, String> {
    // Tolerate a `data:image/png;base64,` prefix so frontend callers can pass
    // a full data-URL without stripping it.
    let cleaned = strip_data_url_prefix(png_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("png_base64 is not valid base64: {}", e))?;
    if bytes.is_empty() {
        return Err("png_base64 decoded to zero bytes".into());
    }
    let (width, height) = crate::vision::parse_png_dimensions(&bytes)
        .ok_or_else(|| "png_base64 is not a valid PNG (IHDR parse failed)".to_string())?;

    run_tesseract_on_bytes(&bytes, width, height, &opts).await
}

/// Clamp the PSM value to tesseract's documented range. Anything out of
/// range (including 0/1/2 which are OSD-only and rejected by some
/// tesseract builds) falls back to 6 — the legacy default.
fn sanitize_psm(requested: Option<u32>) -> u32 {
    match requested {
        Some(v) if (3..=13).contains(&v) => v,
        _ => 6,
    }
}

/// Validate / clean a language spec. Empty or whitespace-only falls back
/// to `eng`. We accept the tesseract syntax `eng+fra` and strip everything
/// that isn't ASCII alphanumeric / `+` to defang shell injection (we pass
/// it as an argv element, but still worth being strict).
fn sanitize_lang(requested: &Option<String>) -> String {
    let raw = requested.as_deref().unwrap_or("eng").trim();
    if raw.is_empty() {
        return "eng".to_string();
    }
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '_')
        .collect();
    if cleaned.is_empty() {
        "eng".to_string()
    } else {
        cleaned
    }
}

/// Strip an optional `data:...;base64,` prefix so we can feed the raw body
/// straight into the base64 decoder.
fn strip_data_url_prefix(s: &str) -> &str {
    if let Some(rest) = s.strip_prefix("data:") {
        if let Some(idx) = rest.find(',') {
            return &rest[idx + 1..];
        }
    }
    s
}

async fn run_tesseract_on_bytes(
    bytes: &[u8],
    width: u32,
    height: u32,
    opts: &OcrOptions,
) -> Result<OcrResult, String> {
    let tess_bin = crate::paths::which(ENGINE_TESSERACT).ok_or_else(|| {
        "tesseract not found on PATH. Install it with `brew install tesseract` and relaunch SUNNY."
            .to_string()
    })?;

    let psm = sanitize_psm(opts.psm);
    let lang = sanitize_lang(&opts.lang);
    let min_conf = opts.min_conf.unwrap_or(0.0).clamp(0.0, 100.0);

    let tmp = tmp_path();
    // Write the PNG to disk so tesseract can open it. We write+run+cleanup
    // inside a helper so the cleanup runs no matter which step fails.
    let result = write_and_run(&tess_bin, &tmp, bytes, psm, &lang).await;
    // Best-effort cleanup — ignore the error, the OS will reap /tmp eventually.
    let _ = tokio::fs::remove_file(&tmp).await;

    let tsv = result?;
    let rows = parse_rows(&tsv);
    // Apply the caller-supplied confidence floor. `-1` conf rows (tesseract's
    // "couldn't score" marker) are already filtered by the blank-text check
    // in `parse_rows`, so clipping at min_conf is a pure user filter.
    let kept_rows: Vec<TsvWord> = rows
        .into_iter()
        .filter(|r| r.conf >= min_conf)
        .collect();

    let boxes: Vec<OcrBox> = kept_rows
        .iter()
        .map(|w| OcrBox {
            text: w.text.clone(),
            x: w.left,
            y: w.top,
            w: w.width,
            h: w.height,
            confidence: w.conf,
        })
        .collect();

    let avg_confidence = if boxes.is_empty() {
        0.0
    } else {
        boxes.iter().map(|b| b.confidence).sum::<f64>() / boxes.len() as f64
    };

    let text = format_layout_text(&kept_rows);

    Ok(OcrResult {
        text,
        boxes,
        engine: ENGINE_TESSERACT.into(),
        width,
        height,
        psm,
        avg_confidence,
    })
}

async fn write_and_run(
    tess_bin: &Path,
    tmp: &Path,
    bytes: &[u8],
    psm: u32,
    lang: &str,
) -> Result<String, String> {
    tokio::fs::write(tmp, bytes)
        .await
        .map_err(|e| format!("failed to write tmp png {}: {}", tmp.display(), e))?;

    let psm_str = psm.to_string();
    let mut cmd = Command::new(tess_bin);
    // `-` sends stdout; caller-selectable PSM (default 6, "uniform block")
    // and language; `preserve_interword_spaces=1` so tesseract itself
    // reports accurate horizontal positions for us to reconstruct columns.
    // `tsv` emits bounding boxes.
    cmd.arg(tmp)
        .arg("-")
        .args(["-l", lang, "--psm", &psm_str])
        .args(["-c", "preserve_interword_spaces=1"])
        .arg("tsv")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn tesseract: {}", e))?;

    let out = match tokio::time::timeout(TESSERACT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("tesseract wait failed: {}", e)),
        Err(_) => {
            return Err(format!(
                "tesseract timed out after {}s",
                TESSERACT_TIMEOUT.as_secs()
            ));
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "tesseract exited with {}: {}",
            out.status,
            if stderr.is_empty() { "(no stderr)" } else { stderr.as_str() }
        ));
    }

    String::from_utf8(out.stdout).map_err(|e| format!("tesseract stdout not utf-8: {}", e))
}

fn tmp_path() -> PathBuf {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into());
    std::env::temp_dir().join(format!("sunny_ocr_{}.png", suffix))
}

// ---------------------------------------------------------------------------
// TSV parsing
// ---------------------------------------------------------------------------
//
// Tesseract's `tsv` format:
//   level  page_num  block_num  par_num  line_num  word_num
//   left   top       width      height   conf      text
//
// `level` values:
//   1 = page, 2 = block, 3 = para, 4 = line, 5 = word
//
// We keep only level=5 rows (words). Empty-text rows and blanks-only rows
// are filtered so callers get a clean list of real boxes.

#[derive(Debug, Clone)]
struct TsvWord {
    block: u32,
    par: u32,
    line: u32,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    conf: f64,
    text: String,
}

/// Parse tesseract TSV into per-word boxes. Unrecognized rows and malformed
/// lines are silently skipped so one weird row can't poison the whole result.
/// Parked — `Vision` framework is the live path; tesseract fallback is
/// kept compiled for environments without Vision (Phase 2).
#[allow(dead_code)]
pub(crate) fn parse_tesseract_tsv(tsv: &str) -> Vec<OcrBox> {
    parse_rows(tsv)
        .into_iter()
        .map(|w| OcrBox {
            text: w.text,
            x: w.left,
            y: w.top,
            w: w.width,
            h: w.height,
            confidence: w.conf,
        })
        .collect()
}

fn parse_rows(tsv: &str) -> Vec<TsvWord> {
    let mut out = Vec::new();
    for (i, line) in tsv.lines().enumerate() {
        // First row is the TSV header; skip it. Also skip rows that don't
        // start with a digit (defensive — tesseract occasionally prints a
        // warning before the data).
        if i == 0 && line.starts_with("level") {
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        // 12 columns expected. Tolerate >=11 in case the text column is
        // missing entirely on an empty line — we'll drop it below anyway.
        if cols.len() < 11 {
            continue;
        }
        let level: u32 = match cols[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if level != 5 {
            continue;
        }

        // Safely parse the numeric columns; any parse error drops the row.
        let block = cols[2].parse().ok();
        let par = cols[3].parse().ok();
        let line_n = cols[4].parse().ok();
        let left = cols[6].parse().ok();
        let top = cols[7].parse().ok();
        let width = cols[8].parse().ok();
        let height = cols[9].parse().ok();
        let conf = cols[10].parse().ok();
        let (block, par, line_n, left, top, width, height, conf) = match (block, par, line_n, left, top, width, height, conf) {
            (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f), Some(g), Some(h)) => (a, b, c, d, e, f, g, h),
            _ => continue,
        };

        // Text column may be absent (missing tab). Treat as empty.
        let text = cols.get(11).map(|s| s.to_string()).unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }

        out.push(TsvWord {
            block,
            par,
            line: line_n,
            left,
            top,
            width,
            height,
            conf,
            text,
        });
    }
    out
}

/// Build the plain-text rendering using each word's `left` / `width` so
/// horizontal gaps in the source image survive the trip through tesseract.
///
/// Strategy:
/// 1. Group words by `(block, par, line)` — tesseract's reading order.
/// 2. Inside a line, sort by `left`, then insert `round(gap / avg_char_w)`
///    spaces between adjacent words (at least one). This recovers
///    column-aligned layouts reasonably well for monospace / UI text.
/// 3. Insert a blank line between different `block`s so paragraph
///    structure is preserved in the plain text view.
fn format_layout_text(rows: &[TsvWord]) -> String {
    if rows.is_empty() {
        return String::new();
    }

    // Group by (block, par, line) preserving first-seen order.
    type LineKey = (u32, u32, u32);
    let mut line_order: Vec<LineKey> = Vec::new();
    let mut lines: std::collections::HashMap<LineKey, Vec<&TsvWord>> =
        std::collections::HashMap::new();
    for w in rows {
        let k = (w.block, w.par, w.line);
        if !lines.contains_key(&k) {
            line_order.push(k);
        }
        lines.entry(k).or_default().push(w);
    }

    let mut out = String::new();
    let mut prev_block: Option<u32> = None;
    for (bi, parti, li) in line_order {
        if let Some(pb) = prev_block {
            // Newline between lines; extra blank line when crossing blocks.
            if !out.is_empty() {
                out.push('\n');
                if pb != bi {
                    out.push('\n');
                }
            }
        }
        prev_block = Some(bi);

        let mut words = lines.remove(&(bi, parti, li)).unwrap_or_default();
        words.sort_by(|a, b| {
            a.left
                .partial_cmp(&b.left)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.push_str(&format_line(&words));
    }
    out
}

/// Render one line's words with position-proportional spacing between them.
/// Degenerate cases (empty input, single word) short-circuit to the
/// obvious answer.
fn format_line(words: &[&TsvWord]) -> String {
    if words.is_empty() {
        return String::new();
    }
    if words.len() == 1 {
        return words[0].text.clone();
    }
    // Average pixels per character across the whole line — our yardstick
    // for converting a horizontal gap into a space count. Guard against
    // zero widths (malformed rows) with a minimum of 6px.
    let total_w: f64 = words.iter().map(|w| w.width).sum();
    let total_chars: usize = words
        .iter()
        .map(|w| w.text.chars().count().max(1))
        .sum();
    let avg_char_w = if total_chars > 0 {
        (total_w / total_chars as f64).max(6.0)
    } else {
        8.0
    };

    let mut out = String::new();
    let mut prev_right: Option<f64> = None;
    for w in words {
        if let Some(pr) = prev_right {
            let gap = (w.left - pr).max(0.0);
            // At least one space between adjacent words; cap at 40 to avoid
            // absurd output when a stray box is placed hundreds of pixels
            // away (huge whitespace from a wide capture).
            let spaces = ((gap / avg_char_w).round() as usize).clamp(1, 40);
            out.push_str(&" ".repeat(spaces));
        }
        out.push_str(&w.text);
        prev_right = Some(w.left + w.width);
    }
    out
}

// ---------------------------------------------------------------------------
// Unit tests — parser only. Real OCR needs tesseract and a display, so the
// end-to-end path is validated manually.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

    #[test]
    fn parse_tesseract_tsv_parses_two_word_sample() {
        // Two words on the same line: "Hello" and "world".
        // Columns: level page block par line word left top width height conf text
        let tsv = format!(
            "{HEADER}\n\
             1\t1\t0\t0\t0\t0\t0\t0\t200\t50\t-1\t\n\
             2\t1\t1\t0\t0\t0\t10\t10\t180\t30\t-1\t\n\
             3\t1\t1\t1\t0\t0\t10\t10\t180\t30\t-1\t\n\
             4\t1\t1\t1\t1\t0\t10\t10\t180\t30\t-1\t\n\
             5\t1\t1\t1\t1\t1\t10\t10\t60\t30\t95.5\tHello\n\
             5\t1\t1\t1\t1\t2\t80\t10\t70\t30\t92.1\tworld\n"
        );

        let boxes = parse_tesseract_tsv(&tsv);
        assert_eq!(boxes.len(), 2, "expected 2 word boxes, got {:?}", boxes);

        assert_eq!(boxes[0].text, "Hello");
        assert_eq!(boxes[0].x, 10.0);
        assert_eq!(boxes[0].y, 10.0);
        assert_eq!(boxes[0].w, 60.0);
        assert_eq!(boxes[0].h, 30.0);
        assert!((boxes[0].confidence - 95.5).abs() < 1e-6);

        assert_eq!(boxes[1].text, "world");
        assert_eq!(boxes[1].x, 80.0);
        assert!((boxes[1].confidence - 92.1).abs() < 1e-6);
    }

    #[test]
    fn parse_tesseract_tsv_ignores_empty_text_rows() {
        // Three level=5 rows: one with text, one with a blank text column,
        // one with whitespace-only text. Only the real word should survive.
        let tsv = format!(
            "{HEADER}\n\
             5\t1\t1\t1\t1\t1\t10\t10\t50\t30\t90\tReal\n\
             5\t1\t1\t1\t1\t2\t70\t10\t40\t30\t88\t\n\
             5\t1\t1\t1\t1\t3\t120\t10\t40\t30\t87\t   \n"
        );
        let boxes = parse_tesseract_tsv(&tsv);
        assert_eq!(boxes.len(), 1, "only the non-empty word should remain");
        assert_eq!(boxes[0].text, "Real");
    }

    #[test]
    fn format_layout_text_groups_lines_and_breaks_blocks() {
        // Two lines in block 1:
        //   line 1: "foo bar" (left=0, left=40; width=30 so gap=10)
        //   line 2: "baz"
        // Then block 2 with a single word "qux" — expected to be preceded
        // by a blank line to mark the paragraph break.
        let tsv = format!(
            "{HEADER}\n\
             5\t1\t1\t1\t1\t1\t0\t0\t30\t20\t90\tfoo\n\
             5\t1\t1\t1\t1\t2\t40\t0\t30\t20\t90\tbar\n\
             5\t1\t1\t1\t2\t1\t0\t30\t30\t20\t90\tbaz\n\
             5\t1\t2\t1\t1\t1\t0\t60\t30\t20\t90\tqux\n"
        );
        let rows = parse_rows(&tsv);
        let text = format_layout_text(&rows);
        assert_eq!(
            text, "foo bar\nbaz\n\nqux",
            "block boundary should add a blank line; same-block lines get a single \\n"
        );

        let boxes = parse_tesseract_tsv(&tsv);
        let words: Vec<&str> = boxes.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(words, vec!["foo", "bar", "baz", "qux"]);
    }

    #[test]
    fn format_line_recovers_column_spacing_from_positions() {
        // Two words far apart: "A" at x=0 (w=10) and "B" at x=200 (w=10).
        // Avg char width across the line = (10+10)/(1+1) = 10. Gap =
        // 200 - 10 = 190 → 19 spaces.
        let tsv = format!(
            "{HEADER}\n\
             5\t1\t1\t1\t1\t1\t0\t0\t10\t20\t90\tA\n\
             5\t1\t1\t1\t1\t2\t200\t0\t10\t20\t90\tB\n"
        );
        let rows = parse_rows(&tsv);
        let text = format_layout_text(&rows);
        assert_eq!(text, format!("A{}B", " ".repeat(19)));
    }

    #[test]
    fn strip_data_url_prefix_handles_both_forms() {
        assert_eq!(strip_data_url_prefix("data:image/png;base64,AAAA"), "AAAA");
        assert_eq!(strip_data_url_prefix("AAAA"), "AAAA");
        // Missing comma → don't mangle the input.
        assert_eq!(strip_data_url_prefix("data:image/png;base64"), "data:image/png;base64");
    }

    #[test]
    fn format_layout_text_returns_empty_string_when_nothing_recognized() {
        let tsv = format!("{HEADER}\n");
        assert_eq!(format_layout_text(&parse_rows(&tsv)), "");
        assert!(parse_tesseract_tsv(&tsv).is_empty());
    }

    #[test]
    fn sanitize_psm_clamps_to_valid_range() {
        assert_eq!(sanitize_psm(None), 6);
        assert_eq!(sanitize_psm(Some(0)), 6);
        assert_eq!(sanitize_psm(Some(2)), 6);
        assert_eq!(sanitize_psm(Some(3)), 3);
        assert_eq!(sanitize_psm(Some(6)), 6);
        assert_eq!(sanitize_psm(Some(11)), 11);
        assert_eq!(sanitize_psm(Some(13)), 13);
        assert_eq!(sanitize_psm(Some(99)), 6);
    }

    #[test]
    fn sanitize_lang_defaults_and_strips_shell_meta() {
        assert_eq!(sanitize_lang(&None), "eng");
        assert_eq!(sanitize_lang(&Some("".into())), "eng");
        assert_eq!(sanitize_lang(&Some("   ".into())), "eng");
        assert_eq!(sanitize_lang(&Some("eng".into())), "eng");
        assert_eq!(sanitize_lang(&Some("eng+fra".into())), "eng+fra");
        // Shell-metacharacters are stripped rather than escaped.
        assert_eq!(sanitize_lang(&Some("eng;rm -rf /".into())), "engrmrf");
        assert_eq!(sanitize_lang(&Some("!@#".into())), "eng");
    }
}

// === REGISTER IN lib.rs ===
// mod ocr;
// #[tauri::command] async fn ocr_region(x: i32, y: i32, w: i32, h: i32, options: Option<ocr::OcrOptions>) -> Result<ocr::OcrResult, String> { ocr::ocr_region(x,y,w,h,options).await }
// #[tauri::command] async fn ocr_full_screen(display: Option<usize>, options: Option<ocr::OcrOptions>) -> Result<ocr::OcrResult, String> { ocr::ocr_full_screen(display,options).await }
// #[tauri::command] async fn ocr_image_base64(png_base64: String, options: Option<ocr::OcrOptions>) -> Result<ocr::OcrResult, String> { ocr::ocr_image_base64(png_base64,options).await }
// invoke_handler: ocr_region, ocr_full_screen, ocr_image_base64
// No new Cargo deps (base64 already present).
// === END REGISTER ===
