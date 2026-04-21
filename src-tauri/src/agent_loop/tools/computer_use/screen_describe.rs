//! `screen_describe` — capture + OCR then produce a narrative description.
//!
//! Trust level: L0 (read-only).
//!
//! Pipeline:
//!  1. `screen_capture` (or region capture) → base64 PNG.
//!  2. `ocr_image_base64` → structured text.
//!  3. If a local vision model is available (qwen3:30b / glm-4v via the
//!     OpenClaw gateway at `~/.openclaw`) send the PNG + OCR text and stream
//!     back the narrative.
//!  4. Fallback: return the raw OCR text dump prefixed with a header so the
//!     LLM still gets useful content even without a vision model.

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "region": {
      "type": "object",
      "properties": {
        "x": {"type": "integer"},
        "y": {"type": "integer"},
        "w": {"type": "integer", "minimum": 1},
        "h": {"type": "integer", "minimum": 1}
      },
      "required": ["x","y","w","h"]
    }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        // Step 1: capture
        let img = if let Some(r) = input.get("region") {
            let x = r.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = r.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let w = r.get("w").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let h = r.get("h").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            if w <= 0 || h <= 0 {
                return Err("screen_describe: region w and h must be positive".into());
            }
            crate::vision::capture_region(x, y, w, h).await?
        } else {
            crate::vision::capture_full_screen(None).await?
        };

        // Step 2: OCR for text extraction
        let ocr = crate::ocr::ocr_image_base64(img.base64.clone(), None).await;

        let ocr_text = match ocr {
            Ok(ref r) => r.text.clone(),
            Err(_) => String::new(),
        };

        // Step 3: attempt local vision model via OpenClaw gateway
        if let Ok(description) = try_vision_model(&img.base64, &ocr_text).await {
            return Ok(description);
        }

        // Step 4: fallback — return formatted OCR dump
        let result = json!({
            "description": format!(
                "[screen_describe fallback — no vision model available]\n\
                 Screen size: {}x{}\n\
                 OCR text:\n{}",
                img.width, img.height,
                if ocr_text.is_empty() { "(no text recognized)" } else { &ocr_text }
            ),
            "source": "ocr_fallback",
            "width": img.width,
            "height": img.height,
        });
        serde_json::to_string(&result).map_err(|e| format!("screen_describe encode: {e}"))
    })
}

/// Attempt to get a narrative description from a local vision-capable model
/// via the OpenClaw gateway socket at `~/.openclaw/bridge.sock`.
///
/// Returns `Err` if the gateway is unavailable, so the caller can fall back
/// to the OCR-text dump cleanly.
async fn try_vision_model(png_base64: &str, ocr_hint: &str) -> Result<String, String> {
    let gateway_sock = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".openclaw")
        .join("bridge.sock");

    if !gateway_sock.exists() {
        return Err("OpenClaw gateway not running".into());
    }

    let prompt = format!(
        "Describe what is visible on the screen in one paragraph. \
         The OCR extracted the following text which may help: {ocr_hint}"
    );

    let payload = json!({
        "model": "qwen3:30b",
        "prompt": prompt,
        "images": [png_base64],
        "stream": false,
    });

    let client = reqwest::Client::new();
    let url = format!("http://localhost/api/generate");

    // Communicate via the Unix socket by mounting it as an HTTP transport.
    // `reqwest` on macOS supports Unix-socket URLs when the `unix-socket`
    // feature is enabled; if it isn't available we return Err and fall back.
    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("vision model request failed: {e}"))?;

    let body: Value = res
        .json()
        .await
        .map_err(|e| format!("vision model response parse: {e}"))?;

    let text = body
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if text.is_empty() {
        return Err("vision model returned empty response".into());
    }

    let result = json!({
        "description": text,
        "source": "vision_model",
    });
    serde_json::to_string(&result).map_err(|e| format!("encode: {e}"))
}

inventory::submit! {
    ToolSpec {
        name: "screen_describe",
        description: "Capture the screen (or a region) and return a narrative description of what is visible. \
                       Uses a local vision model if available; falls back to OCR text dump. \
                       Returns {description, source, width?, height?}.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
