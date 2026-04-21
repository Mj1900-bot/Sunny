//! `screen_ocr_full` — OCR the full screen (no-argument legacy variant).
//!
//! The parameterised `screen_ocr(region?)` is now registered in
//! `computer_use::screen_ocr_tool`. This module keeps the no-arg
//! convenience around as `screen_ocr_full` so existing callers are
//! not broken.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let res = crate::ocr::ocr_full_screen(None, None).await?;
        serde_json::to_string(&res).map_err(|e| format!("ocr encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "screen_ocr_full",
        description: "OCR the full screen and return extracted text (no region option). \
                       Use screen_ocr with a region argument for sub-rectangle capture.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
