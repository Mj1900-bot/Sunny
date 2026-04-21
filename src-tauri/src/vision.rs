//! SUNNY vision — give the assistant eyes.
//!
//! Thin wrapper around macOS's built-in `/usr/sbin/screencapture`. We shell
//! out so we don't pull in heavy graphics crates; `screencapture` is present
//! on every macOS install and is the same tool Preview/Cmd-Shift-4 use.
//!
//! Output is base64-encoded PNG so a Tauri command can return it directly
//! to the frontend or hand it to a vision model (GPT-4V, Claude, etc.).
//!
//! macOS 10.15+ gates screen capture behind the Screen Recording privacy
//! permission. The first invocation triggers a system prompt and the process
//! captures a blank / desktop-only image until the user grants access in
//! System Settings → Privacy & Security → Screen Recording and relaunches
//! SUNNY. Detection is best-effort: if the PNG dimensions are zero, or the
//! file is missing, callers see an error string they can surface to the UI.
//!
//! All child processes get `paths::fat_path()` so launchctl's minimal PATH
//! doesn't hide `osascript` or `screencapture`.
//!
//! Exposed (orchestrator wraps these as `#[tauri::command]`):
//!   - `capture_full_screen(display)` → full display, optional 1-based index
//!   - `capture_region(x, y, w, h)`   → rectangle in screen coords
//!   - `capture_active_window()`      → frontmost window by CGWindowID, or
//!                                      cursor-over-window fallback
//
// NOTE: no new crate deps here beyond `base64 = "0.22"`. PNG dimensions are
// read by parsing the IHDR chunk by hand so we don't pull in `image`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use ts_rs::TS;

const SCREENCAPTURE_BIN: &str = "/usr/sbin/screencapture";
const OSASCRIPT_BIN: &str = "/usr/bin/osascript";

/// Result of a screen capture, ready to ship to the frontend or a vision
/// model. `base64` is the raw base64 body with no `data:` prefix.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenImage {
    #[ts(type = "number")]
    pub width: u32,
    #[ts(type = "number")]
    pub height: u32,
    pub format: String,
    #[ts(type = "number")]
    pub bytes_len: usize,
    pub base64: String,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Capture a full display. `display` is 1-based (matches `screencapture -D`);
/// `None` means the main display.
pub async fn capture_full_screen(display: Option<usize>) -> Result<ScreenImage, String> {
    let tmp = tmp_path("full");
    let mut args: Vec<String> = Vec::new();
    if let Some(d) = display {
        if d == 0 {
            return Err("display index is 1-based; use 1 for the main display".into());
        }
        args.push(format!("-D{}", d));
    }
    args.extend(["-x".into(), "-t".into(), "png".into()]);
    args.push(tmp.to_string_lossy().into_owned());

    run_screencapture(&args).await?;
    finalize(&tmp).await
}

/// Capture an arbitrary rectangle in screen coordinates. Width/height must
/// be positive; negative x/y are allowed (multi-display setups place
/// secondary displays at negative coordinates).
pub async fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<ScreenImage, String> {
    if w <= 0 || h <= 0 {
        return Err(format!(
            "region width and height must be positive, got {}x{}",
            w, h
        ));
    }
    let tmp = tmp_path("region");
    let args = vec![
        format!("-R{},{},{},{}", x, y, w, h),
        "-x".into(),
        "-t".into(),
        "png".into(),
        tmp.to_string_lossy().into_owned(),
    ];

    run_screencapture(&args).await?;
    finalize(&tmp).await
}

/// Capture the frontmost window. Resolves the CGWindowID via AppleScript
/// (`System Events` → `id of front window`). If that's unavailable (e.g.
/// System Events not authorized, or no scriptable front window), falls
/// back to `screencapture -o` which grabs the window currently under the
/// cursor. The fallback's limitation: the mouse pointer must be over the
/// intended window.
pub async fn capture_active_window() -> Result<ScreenImage, String> {
    let tmp = tmp_path("window");

    let window_id = front_window_id().await;

    let args: Vec<String> = match window_id {
        Some(id) => vec![
            format!("-l{}", id),
            "-x".into(),
            "-t".into(),
            "png".into(),
            tmp.to_string_lossy().into_owned(),
        ],
        None => vec![
            "-o".into(),
            "-x".into(),
            "-t".into(),
            "png".into(),
            tmp.to_string_lossy().into_owned(),
        ],
    };

    run_screencapture(&args).await?;
    finalize(&tmp).await
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn tmp_path(kind: &str) -> PathBuf {
    // Nanoseconds keep simultaneous captures from colliding; falls back to a
    // stable name if the clock is unavailable so we still produce *a* file.
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into());
    std::env::temp_dir().join(format!("sunny_shot_{}_{}.png", kind, suffix))
}

async fn run_screencapture(args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(SCREENCAPTURE_BIN);
    cmd.args(args).stdout(Stdio::null()).stderr(Stdio::piped());
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("screencapture spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "screencapture exited with {}: {}",
            out.status,
            if stderr.is_empty() {
                "(no stderr — likely Screen Recording permission not granted)"
            } else {
                stderr.as_str()
            }
        ));
    }
    Ok(())
}

/// Ask AppleScript for the frontmost window's CGWindowID. Returns None if
/// anything goes wrong — callers then use `screencapture -o` instead.
async fn front_window_id() -> Option<u64> {
    let script = r#"tell application "System Events" to id of front window of (first process whose frontmost is true)"#;
    let mut cmd = Command::new(OSASCRIPT_BIN);
    cmd.arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // AppleScript occasionally returns a non-integer (e.g. "missing value")
    // when the front process has no scriptable window; parse() rejects it.
    raw.parse::<u64>().ok()
}

async fn finalize(path: &Path) -> Result<ScreenImage, String> {
    // Read the PNG, derive dimensions, encode base64, and delete the tmp
    // file no matter what. `cleanup` is best-effort — if the file never
    // landed on disk (permission denied) the remove simply fails silently.
    let read_result = tokio::fs::read(path)
        .await
        .map_err(|e| format!("read capture failed ({}): {}", path.display(), e));
    let cleanup = tokio::fs::remove_file(path).await;
    drop(cleanup);

    let bytes = read_result?;
    if bytes.is_empty() {
        return Err("capture produced an empty file — Screen Recording permission may be missing".into());
    }
    let (width, height) = parse_png_dimensions(&bytes)
        .ok_or_else(|| "capture did not produce a valid PNG (IHDR parse failed)".to_string())?;
    if width == 0 || height == 0 {
        return Err(format!(
            "capture has zero dimensions ({}x{}) — Screen Recording permission may be missing",
            width, height
        ));
    }

    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let bytes_len = bytes.len();
    Ok(ScreenImage {
        width,
        height,
        format: "png".into(),
        bytes_len,
        base64,
    })
}

/// Extract width/height from the IHDR chunk of a PNG byte stream.
///
/// PNG layout:
///   0..8    signature (89 50 4E 47 0D 0A 1A 0A)
///   8..12   IHDR length (should be 13, big-endian u32)
///   12..16  chunk type, must equal b"IHDR"
///   16..20  width  (big-endian u32)
///   20..24  height (big-endian u32)
///
/// Returns None on any structural problem so callers can report a clean
/// error rather than panic.
pub(crate) fn parse_png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() < 24 {
        return None;
    }
    if bytes[..8] != SIGNATURE {
        return None;
    }
    if &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

// ---------------------------------------------------------------------------
// Unit tests — IHDR parser only. Real capture is excluded from CI because it
// needs a graphical session and Screen Recording authorization.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal 1x1 transparent PNG, hand-built so the test has no I/O and
    /// no dependencies. IHDR declares 1x1, 8-bit, RGBA; the IDAT holds a
    /// valid zlib stream for a single transparent pixel; IEND closes it.
    /// We only need bytes 0..24 to match for the parser, but a full file
    /// is kept so the fixture is a legitimate PNG if something else ever
    /// wants to decode it.
    const ONE_BY_ONE_PNG: [u8; 67] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
        0x00, 0x00, 0x00, 0x0D, // IHDR length = 13
        0x49, 0x48, 0x44, 0x52, // "IHDR"
        0x00, 0x00, 0x00, 0x01, // width  = 1
        0x00, 0x00, 0x00, 0x01, // height = 1
        0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit, RGBA, default filters
        0x1F, 0x15, 0xC4, 0x89, // IHDR CRC
        0x00, 0x00, 0x00, 0x0A, // IDAT length = 10
        0x49, 0x44, 0x41, 0x54, // "IDAT"
        0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // zlib-compressed pixel
        0x0D, 0x0A, 0x2D, 0xB4, // IDAT CRC
        0x00, 0x00, 0x00, 0x00, // IEND length = 0
        0x49, 0x45, 0x4E, 0x44, // "IEND"
        0xAE, 0x42, 0x60, 0x82, // IEND CRC
    ];

    #[test]
    fn parses_ihdr_width_and_height_from_known_png() {
        let dims = parse_png_dimensions(&ONE_BY_ONE_PNG);
        assert_eq!(dims, Some((1, 1)));
    }

    #[test]
    fn rejects_non_png_bytes_without_panicking() {
        // Same length as the real header so the only failure is the
        // signature mismatch, ensuring we exit via the signature check
        // and not via the length guard.
        let garbage: [u8; 24] = [0; 24];
        assert_eq!(parse_png_dimensions(&garbage), None);

        // Too short — must bail on the length check.
        let tiny = [0x89, 0x50];
        assert_eq!(parse_png_dimensions(&tiny), None);

        // Right signature, wrong chunk name at offset 12..16.
        let mut wrong_chunk = ONE_BY_ONE_PNG;
        wrong_chunk[12] = b'X';
        assert_eq!(parse_png_dimensions(&wrong_chunk), None);
    }
}

// === REGISTER IN lib.rs ===
// #[tauri::command] async fn screen_capture_full(display: Option<usize>) -> Result<vision::ScreenImage, String> { vision::capture_full_screen(display).await }
// #[tauri::command] async fn screen_capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<vision::ScreenImage, String> { vision::capture_region(x, y, w, h).await }
// #[tauri::command] async fn screen_capture_active_window() -> Result<vision::ScreenImage, String> { vision::capture_active_window().await }
// Add to invoke_handler: screen_capture_full, screen_capture_region, screen_capture_active_window
// Deps for Cargo.toml: base64 = "0.22"
// === END REGISTER ===
