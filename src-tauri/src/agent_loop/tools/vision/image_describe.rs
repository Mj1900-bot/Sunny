//! `image_describe` — describe an image via a local multimodal Ollama model.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["vision.describe"];

const SCHEMA: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"Absolute or ~/ path to a PNG/JPEG file."},"base64":{"type":"string","description":"Raw base64-encoded image bytes, with or without a data:image/...;base64, prefix."},"prompt":{"type":"string","description":"Optional custom instruction for the vision model. Default asks for a 2-3 sentence description."}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let parsed = crate::agent_loop::tools_vision::parse_input(&input)?;
        crate::agent_loop::tools_vision::image_describe(parsed).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "image_describe",
        description: "Describe what's in an image using a local multimodal model (minicpm-v:8b preferred, llava:13b fallback). Pass EITHER a file `path` (e.g. ~/Desktop/foo.png, ~/Downloads/photo.jpg) OR a raw `base64` PNG/JPEG payload — never both. Optional `prompt` overrides the default 'Describe this image in 2-3 sentences' instruction. Use when Sunny says 'what's in this picture', 'describe ~/Downloads/X.jpg', 'what do you see in this screenshot'. For 'what's on my screen?' style queries, prefer the composite `remember_screen` tool which captures + OCRs + describes in one step. Read-only, runs fully offline via Ollama at 127.0.0.1:11434.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
