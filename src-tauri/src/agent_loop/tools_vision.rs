//! `image_describe` — local vision tool that turns a PNG/JPEG into a short
//! natural-language description via Ollama's multimodal `/api/generate`
//! endpoint.
//!
//! Canonical use:
//!   * "SUNNY, what's on my screen?" → `remember_screen` captures + OCRs +
//!     describes in one composite call.
//!   * "Describe ~/Downloads/dog.jpg" → direct `image_describe` on a path.
//!   * Any internal composite tool that already has a base64 PNG in hand
//!     (screen capture, region grab, etc.) can pass `base64:` and skip the
//!     disk round-trip.
//!
//! Model chain:
//!   1. `minicpm-v:8b` — fast, good quality, ~5 GB. Preferred.
//!   2. `llava:13b`    — fallback, slower but more forgiving. ~8 GB.
//!   3. Neither installed → structured error telling Sunny to
//!      `ollama pull minicpm-v:8b`.
//!
//! The tool is read-only (no ConfirmGate). All network traffic is
//! localhost → Ollama's HTTP server on 11434; nothing leaves the machine.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::timeout;

/// How long to wait on a single Ollama `/api/generate` call. Vision
/// inference on minicpm-v:8b is 4-8 s cold on this Mac and ~2 s warm;
/// llava:13b is ~10-15 s cold. 30 s covers the cold-start worst case
/// without leaving the agent loop hanging if the daemon deadlocks.
const OLLAMA_GENERATE_TIMEOUT_SECS: u64 = 30;

/// Preferred vision model on this Mac — R15-G smoke-tested against
/// `ollama list`. Compact, fast, reliable captions.
const PREFERRED_VISION_MODEL: &str = "minicpm-v:8b";

/// Fallback if minicpm-v isn't pulled. Larger but still usable.
const FALLBACK_VISION_MODEL: &str = "llava:13b";

/// Default prompt. Kept deliberately tight — vision models like to
/// narrate framing ("this is a photograph of…") if you let them.
const DEFAULT_PROMPT: &str =
    "Describe this image in 2-3 sentences. Focus on what's IN it, not the framing.";

const OLLAMA_GENERATE_URL: &str = "http://127.0.0.1:11434/api/generate";
const OLLAMA_TAGS_URL: &str = "http://127.0.0.1:11434/api/tags";

/// Input payload. Exactly one of `path` / `base64` must be set. `prompt`
/// overrides `DEFAULT_PROMPT` when present.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ImageDescribeInput {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub base64: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
}

/// Public entry — validate, load bytes, ask Ollama, return text.
pub async fn image_describe(input: ImageDescribeInput) -> Result<String, String> {
    let b64 = resolve_image_base64(&input)?;
    let prompt = input
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PROMPT)
        .to_string();

    // Pick a model that's actually installed so we can give a helpful
    // error up-front rather than a generic 404 from Ollama.
    let model = pick_vision_model().await?;
    run_vision_generate(&model, &prompt, &b64).await
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/// Return the raw base64 string to hand to Ollama. Accepts either a
/// `path` (expanded, read, encoded) or a `base64` payload (with or
/// without a `data:image/...;base64,` prefix). Rejects "both" / "neither".
fn resolve_image_base64(input: &ImageDescribeInput) -> Result<String, String> {
    let path = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let b64 = input
        .base64
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match (path, b64) {
        (Some(_), Some(_)) => Err(
            "image_describe: pass exactly one of `path` or `base64`, not both".into(),
        ),
        (None, None) => Err(
            "image_describe: must pass either `path` or `base64`".into(),
        ),
        (Some(p), None) => read_path_as_base64(p),
        (None, Some(b)) => {
            // Strip any `data:...;base64,` prefix so Ollama gets clean
            // payload. Validate it decodes to non-empty bytes so we fail
            // here rather than inside the generate call.
            let cleaned = strip_data_url_prefix(b);
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(cleaned.as_bytes())
                .map_err(|e| format!("image_describe: base64 is invalid: {e}"))?;
            if decoded.is_empty() {
                return Err("image_describe: base64 decoded to zero bytes".into());
            }
            Ok(cleaned.to_string())
        }
    }
}

fn strip_data_url_prefix(s: &str) -> &str {
    if let Some(idx) = s.find("base64,") {
        // Only strip if what precedes it looks like a data URL so we
        // don't eat a legitimate image that happens to contain the
        // literal string.
        let head = &s[..idx];
        if head.starts_with("data:") {
            return &s[idx + "base64,".len()..];
        }
    }
    s
}

fn read_path_as_base64(path: &str) -> Result<String, String> {
    let expanded = crate::safety_paths::expand_home(path)?;
    crate::safety_paths::assert_read_allowed(&expanded)?;
    if !expanded.is_file() {
        return Err(format!(
            "image_describe: not a readable file: {}",
            expanded.display()
        ));
    }
    let bytes = std::fs::read(&expanded)
        .map_err(|e| format!("image_describe: read {}: {}", expanded.display(), e))?;
    if bytes.is_empty() {
        return Err(format!(
            "image_describe: file is empty: {}",
            expanded.display()
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/// Probe `/api/tags` once and return the first vision model that's
/// actually pulled. Fails with a helpful message if neither is present.
async fn pick_vision_model() -> Result<String, String> {
    let installed = list_ollama_models().await;
    if installed.iter().any(|m| model_matches(m, PREFERRED_VISION_MODEL)) {
        return Ok(PREFERRED_VISION_MODEL.to_string());
    }
    if installed.iter().any(|m| model_matches(m, FALLBACK_VISION_MODEL)) {
        return Ok(FALLBACK_VISION_MODEL.to_string());
    }
    Err(format!(
        "image_describe: no local vision model installed. \
         Run `ollama pull {PREFERRED_VISION_MODEL}` (preferred) or \
         `ollama pull {FALLBACK_VISION_MODEL}` and try again."
    ))
}

/// Ollama returns tags like `minicpm-v:8b` but sometimes `minicpm-v:latest`
/// satisfies the same role. Accept either the exact tag or the bare
/// model name before `:` matching.
fn model_matches(installed: &str, wanted: &str) -> bool {
    if installed == wanted {
        return true;
    }
    let installed_stem = installed.split(':').next().unwrap_or(installed);
    let wanted_stem = wanted.split(':').next().unwrap_or(wanted);
    installed_stem == wanted_stem
}

async fn list_ollama_models() -> Vec<String> {
    #[derive(Deserialize)]
    struct TagsResp {
        #[serde(default)]
        models: Vec<TagItem>,
    }
    #[derive(Deserialize)]
    struct TagItem {
        name: String,
    }

    let client = crate::http::client();
    let fut = client.get(OLLAMA_TAGS_URL).send();
    let resp = match timeout(Duration::from_secs(2), fut).await {
        Ok(Ok(r)) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let parsed: TagsResp = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    parsed.models.into_iter().map(|m| m.name).collect()
}

// ---------------------------------------------------------------------------
// Ollama /api/generate call
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GenerateResponse {
    #[serde(default)]
    response: String,
}

async fn run_vision_generate(model: &str, prompt: &str, image_b64: &str) -> Result<String, String> {
    let body = json!({
        "model": model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": false,
        // Keep the vision model resident for a bit so rapid follow-up
        // captures ("what's on my screen now?") don't pay the cold-load
        // tax every time.
        "keep_alive": "5m",
    });

    let client = crate::http::client();
    let fut = client.post(OLLAMA_GENERATE_URL).json(&body).send();
    let resp = timeout(Duration::from_secs(OLLAMA_GENERATE_TIMEOUT_SECS), fut)
        .await
        .map_err(|_| {
            format!(
                "image_describe: ollama /api/generate timed out after {OLLAMA_GENERATE_TIMEOUT_SECS}s"
            )
        })?
        .map_err(|e| format!("image_describe: ollama connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let snippet: String = body_text.chars().take(400).collect();
        return Err(format!("image_describe: ollama http {status}: {snippet}"));
    }

    let parsed: GenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("image_describe: ollama decode: {e}"))?;

    let text = parsed.response.trim().to_string();
    if text.is_empty() {
        return Err("image_describe: ollama returned an empty description".into());
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// Dispatcher hook — parse the raw JSON args into an ImageDescribeInput.
// ---------------------------------------------------------------------------

pub fn parse_input(input: &Value) -> Result<ImageDescribeInput, String> {
    let path = input
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let base64 = input
        .get("base64")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let prompt = input
        .get("prompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(ImageDescribeInput {
        path,
        base64,
        prompt,
    })
}

// ---------------------------------------------------------------------------
// Tests — validation only. Network / model calls are covered by R15-G's
// smoke script and would require Ollama running in-process.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Neither `path` nor `base64` → structured error.
    #[test]
    fn rejects_when_neither_path_nor_base64_set() {
        let err = resolve_image_base64(&ImageDescribeInput::default()).unwrap_err();
        assert!(err.contains("must pass either"), "got: {err}");
    }

    /// Both set → structured error (we can only handle one).
    #[test]
    fn rejects_when_both_path_and_base64_set() {
        let input = ImageDescribeInput {
            path: Some("/tmp/x.png".into()),
            // "AA==" is a tiny valid base64 payload but doesn't matter
            // here — we fail before decoding.
            base64: Some("AA==".into()),
            prompt: None,
        };
        let err = resolve_image_base64(&input).unwrap_err();
        assert!(
            err.contains("not both"),
            "expected 'not both' in error, got: {err}"
        );
    }

    /// A valid base64 payload (with or without prefix) survives validation
    /// and the data-URL prefix is stripped.
    #[test]
    fn accepts_base64_with_and_without_data_url_prefix() {
        // Minimal non-empty PNG header bytes, base64-encoded. Enough to
        // pass the "not empty" check.
        let raw = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
        let plain = ImageDescribeInput {
            path: None,
            base64: Some(raw.clone()),
            prompt: None,
        };
        let out_plain = resolve_image_base64(&plain).unwrap();
        assert_eq!(out_plain, raw);

        let prefixed = ImageDescribeInput {
            path: None,
            base64: Some(format!("data:image/png;base64,{raw}")),
            prompt: None,
        };
        let out_prefixed = resolve_image_base64(&prefixed).unwrap();
        assert_eq!(out_prefixed, raw, "data: prefix should be stripped");
    }

    /// Whitespace-only inputs count as "not set" so the model doesn't
    /// get confused by an empty string that the LLM emitted for a key
    /// it couldn't fill.
    #[test]
    fn whitespace_only_fields_treated_as_unset() {
        let input = ImageDescribeInput {
            path: Some("   ".into()),
            base64: Some("\t\n".into()),
            prompt: None,
        };
        let err = resolve_image_base64(&input).unwrap_err();
        assert!(
            err.contains("must pass either"),
            "whitespace should be treated as unset; got: {err}"
        );
    }

    /// `model_matches` accepts both exact tag and bare stem matches so
    /// `minicpm-v:latest` and `minicpm-v:8b` both satisfy the preferred
    /// slot.
    #[test]
    fn model_matches_accepts_tag_variants() {
        assert!(model_matches("minicpm-v:8b", "minicpm-v:8b"));
        assert!(model_matches("minicpm-v:latest", "minicpm-v:8b"));
        assert!(model_matches("llava:13b", "llava:13b"));
        assert!(!model_matches("qwen3:30b", "minicpm-v:8b"));
    }

    /// `parse_input` threads JSON through to `ImageDescribeInput`.
    #[test]
    fn parse_input_threads_fields() {
        let v = serde_json::json!({
            "path": "~/pic.png",
            "prompt": "what is this"
        });
        let parsed = parse_input(&v).unwrap();
        assert_eq!(parsed.path.as_deref(), Some("~/pic.png"));
        assert_eq!(parsed.prompt.as_deref(), Some("what is this"));
        assert!(parsed.base64.is_none());
    }
}
