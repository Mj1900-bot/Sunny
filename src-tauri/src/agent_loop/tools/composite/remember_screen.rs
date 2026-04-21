//! `remember_screen` — capture + OCR + memory write in one composite step.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen", "memory.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"note":{"type":"string","description":"Optional human-written description or filing label for what's on screen (e.g. 'banking statement', 'tuesday-meeting', 'Virgin lawsuit evidence'). If the user gives a tag/folder/category, pass it here."}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let note = crate::agent_loop::remember_screen::parse_input(&input)?;
        crate::agent_loop::remember_screen::remember_screen(note.as_deref()).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "remember_screen",
        description: "Capture Sunny's current screen, OCR any text, and save it to long-term memory in one composite step. USE remember_screen — NOT screen_capture_full, NOT screen_ocr, NOT memory_remember — whenever Sunny pairs any of these verbs { save, file, remember, note, tag, log, stash, keep, archive } with any of these objects { screen, capture, screenshot, what I'm looking at, what's on my screen, this view, this page }. Explicit trigger phrases: 'remember this', 'save this for later', 'note what I'm looking at', 'file it under X', 'tag this capture', 'screenshot this and save it', 'take a screenshot and file it under Y', 'keep a record of this screen', 'log what's on screen'. If the user mentions a label, folder, tag, or filing category alongside a screen-capture verb (e.g. 'file it under tuesday-meeting', 'save it as Virgin evidence'), that is an unambiguous remember_screen call — pass the label as `note`. The captured text is tagged `screen-capture` and is findable via memory_recall. Only fall back to screen_capture_full when Sunny explicitly asks for a raw PNG with no filing/saving intent (e.g. 'show me a screenshot', 'grab a picture of my screen').",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
