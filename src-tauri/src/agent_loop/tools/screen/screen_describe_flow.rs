//! `screen_describe_flow` — multi-step action guidance for UI automation.
//!
//! Privacy level: L2 (screen read + local model inference).
//!
//! ## Pipeline
//!
//! 1. Full-screen capture → base64 PNG.
//! 2. OCR → text.
//! 3. Send PNG + OCR to the local vision model (OpenClaw gateway or Ollama)
//!    with a structured guidance prompt.
//! 4. Parse the model's JSON response into `FlowAction`.
//! 5. Return the structured action to the agent.
//!
//! ## Response shape
//!
//! ```json
//! {
//!   "next_action": "Click",
//!   "target": {"text": "OK", "x": 840, "y": 610, "w": 65, "h": 22, "confidence": 94.5},
//!   "reason": "The dialog is asking for confirmation; clicking OK will dismiss it.",
//!   "done": false
//! }
//! ```
//!
//! `next_action` is one of `"Click"`, `"Type"`, `"Wait"`, `"Done"`, `"Unknown"`.
//!
//! ## Fallback
//!
//! If no vision model is available the tool returns `next_action: "Unknown"` with
//! the raw OCR text as `reason` so the agent loop can still make progress.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen", "vision.describe"];

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["step_desc"],
  "properties": {
    "step_desc": {
      "type": "string",
      "description": "What the user is trying to accomplish right now, e.g. 'close this dialog' or 'submit the form'."
    }
  }
}"#;

/// The structured action the model returns (or we synthesise on fallback).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum ActionKind {
    Click,
    Type,
    Wait,
    Done,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowAction {
    pub next_action: ActionKind,
    pub target: Option<super::ScreenBBox>,
    pub reason: String,
    pub done: bool,
}

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let step_desc = input
            .get("step_desc")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("screen_describe_flow: `step_desc` must be a non-empty string")?
            .to_string();

        // Step 1: capture
        let img = crate::vision::capture_full_screen(None)
            .await
            .map_err(|e| format!("screen_describe_flow: capture: {e}"))?;

        // Step 2: OCR
        let ocr_text = match crate::ocr::ocr_image_base64(img.base64.clone(), None).await {
            Ok(r) => r.text,
            Err(_) => String::new(),
        };

        // Step 3: ask vision model
        let action = ask_vision_model(&img.base64, &ocr_text, &step_desc)
            .await
            .unwrap_or_else(|_| FlowAction {
                next_action: ActionKind::Unknown,
                target: None,
                reason: format!(
                    "[no vision model — raw OCR]\n{}",
                    if ocr_text.is_empty() { "(no text recognized)" } else { &ocr_text }
                ),
                done: false,
            });

        serde_json::to_string(&action)
            .map_err(|e| format!("screen_describe_flow: encode: {e}"))
    })
}

/// Build the guidance prompt and query the local vision model.
async fn ask_vision_model(
    png_b64: &str,
    ocr_text: &str,
    step_desc: &str,
) -> Result<FlowAction, String> {
    let prompt = format!(
        "You are a UI automation assistant. The user is trying to: {step_desc}\n\
         Here is the text currently visible on screen (from OCR):\n{ocr_text}\n\n\
         Respond ONLY with valid JSON in this exact shape:\n\
         {{\"next_action\":\"Click|Type|Wait|Done|Unknown\",\
           \"target\":{{\"text\":\"<label>\",\"x\":0,\"y\":0,\"w\":0,\"h\":0,\"confidence\":0.0}} or null,\
           \"reason\":\"<one sentence>\",\
           \"done\":false}}\n\
         Pick the single most important next action."
    );

    let describe_input = crate::agent_loop::tools_vision::ImageDescribeInput {
        path: None,
        base64: Some(png_b64.to_string()),
        prompt: Some(prompt),
    };

    let raw = crate::agent_loop::tools_vision::image_describe(describe_input)
        .await
        .map_err(|e| format!("vision: {e}"))?;

    // Parse the model's JSON. Models sometimes wrap in markdown code fences.
    let json_str = extract_json_block(&raw);
    let v: Value = serde_json::from_str(json_str)
        .map_err(|e| format!("parse model json: {e}"))?;

    parse_flow_action(&v)
}

/// Pull the first `{...}` block out of a string in case the model wrapped its
/// response in ` ```json ... ``` `.
fn extract_json_block(s: &str) -> &str {
    if let Some(start) = s.find('{') {
        if let Some(end) = s.rfind('}') {
            if end > start {
                return &s[start..=end];
            }
        }
    }
    s
}

fn parse_flow_action(v: &Value) -> Result<FlowAction, String> {
    let kind_str = v
        .get("next_action")
        .and_then(|s| s.as_str())
        .unwrap_or("Unknown");
    let kind = match kind_str {
        "Click" => ActionKind::Click,
        "Type" => ActionKind::Type,
        "Wait" => ActionKind::Wait,
        "Done" => ActionKind::Done,
        _ => ActionKind::Unknown,
    };

    let target = v.get("target").and_then(|t| {
        if t.is_null() {
            return None;
        }
        Some(super::ScreenBBox {
            text: t.get("text").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            x: t.get("x").and_then(|n| n.as_f64()).unwrap_or(0.0),
            y: t.get("y").and_then(|n| n.as_f64()).unwrap_or(0.0),
            w: t.get("w").and_then(|n| n.as_f64()).unwrap_or(0.0),
            h: t.get("h").and_then(|n| n.as_f64()).unwrap_or(0.0),
            confidence: t.get("confidence").and_then(|n| n.as_f64()).unwrap_or(0.0),
        })
    });

    let reason = v
        .get("reason")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let done = kind == ActionKind::Done
        || v.get("done").and_then(|b| b.as_bool()).unwrap_or(false);

    Ok(FlowAction { next_action: kind, target, reason, done })
}

inventory::submit! {
    ToolSpec {
        name: "screen_describe_flow",
        description: "Multi-step UI guidance: captures screen, OCRs it, then asks a local vision model \
                       'User is trying to: {step_desc}. What's the next action?' \
                       Returns {next_action: Click|Type|Wait|Done|Unknown, target: BBox|null, reason, done}. \
                       Use before mouse_click to get the exact target coordinates. \
                       Falls back to raw OCR if no vision model is available. \
                       Privacy level: L2 (screen read + local model inference).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_flow_action_click_with_target() {
        let v = json!({
            "next_action": "Click",
            "target": {"text": "OK", "x": 840, "y": 610, "w": 65, "h": 22, "confidence": 94.5},
            "reason": "The dialog needs to be dismissed",
            "done": false
        });
        let a = parse_flow_action(&v).unwrap();
        assert_eq!(a.next_action, ActionKind::Click);
        let t = a.target.unwrap();
        assert_eq!(t.text, "OK");
        assert_eq!(t.x, 840.0);
        assert_eq!(t.y, 610.0);
        assert!(!a.done);
    }

    #[test]
    fn parse_flow_action_done_sets_done_flag() {
        let v = json!({
            "next_action": "Done",
            "target": null,
            "reason": "Dialog is closed",
            "done": false   // next_action=Done should override
        });
        let a = parse_flow_action(&v).unwrap();
        assert_eq!(a.next_action, ActionKind::Done);
        assert!(a.done, "Done action must set done=true");
        assert!(a.target.is_none());
    }

    #[test]
    fn parse_flow_action_unknown_on_garbage_kind() {
        let v = json!({"next_action": "Teleport", "target": null, "reason": "x", "done": false});
        let a = parse_flow_action(&v).unwrap();
        assert_eq!(a.next_action, ActionKind::Unknown);
    }

    #[test]
    fn extract_json_block_strips_markdown_fences() {
        let raw = "Sure!\n```json\n{\"next_action\":\"Click\"}\n```";
        let extracted = extract_json_block(raw);
        assert_eq!(extracted, "{\"next_action\":\"Click\"}");
    }

    #[test]
    fn extract_json_block_passthrough_on_plain_json() {
        let raw = r#"{"next_action":"Wait"}"#;
        assert_eq!(extract_json_block(raw), raw);
    }

    #[test]
    fn parse_flow_action_null_target_gives_none() {
        let v = json!({"next_action": "Wait", "target": null, "reason": "loading", "done": false});
        let a = parse_flow_action(&v).unwrap();
        assert!(a.target.is_none());
    }
}
