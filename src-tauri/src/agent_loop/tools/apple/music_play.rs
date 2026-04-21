//! `music_play` — play Music.app, optionally searching first.
//! L2 (controls physical audio output).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::optional_string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.media.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "query": {"type": "string", "description": "Optional search term (song, artist, album). If omitted, resumes current track."}
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = optional_string_arg(&input, "query");
        super::core::music_play(query.as_deref()).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "music_play",
        description: "Play Music.app. With `query`, searches the library and plays the first match; without it, resumes playback.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
