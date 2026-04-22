//! Tool catalog — shared types + merge helper. The composite migration
//! is complete: every tool now registers via `inventory::submit!` in
//! `agent_loop::tools::*`, including `spawn_subagent`.
//!
//! What remains here:
//!   * `ToolSpec` + `TrustClass` — the data types used by both the
//!     trait registry and the merged catalog handed to the LLM.
//!   * `trust_class` / `is_dangerous` — canonical lookups that consult
//!     the trait registry for every tool. Defaults cover the unknown-
//!     tool case (model hallucinates a name) defensively.
//!   * `catalog_merged` — returns every trait-registered entry in a
//!     single `Vec<ToolSpec>`, which is what the providers iterate to
//!     build their provider-specific tool payloads.

/// Static tool spec. Each entry maps 1-to-1 with a `#[tauri::command]`
/// function living in a sibling `tools_*` / domain module. The
/// `input_schema` is a JSON Schema fragment matching what the tool
/// accepts; we hand the whole catalog to the LLM so it can produce
/// well-formed tool calls.
#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: &'static str,
}

/// Trust classification for tool output. Drives whether the result gets
/// wrapped in `<untrusted_source>` before being fed back into the LLM
/// history.
///
/// * `Pure` — deterministic compute (calc, unit_convert, timezone_now,
///   uuid_new, hashes). No attacker content. No wrapping.
/// * `ExternalRead` — reads arbitrary external content (web pages, mail,
///   browser, notes written by humans). Must be wrapped.
/// * `ExternalWrite` — performs a side effect. Output itself is usually
///   short internal text but we wrap defensively — e.g. `notes_create`
///   may echo back the note body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustClass {
    Pure,
    ExternalRead,
    ExternalWrite,
}

/// Classify a tool by trust level. Every tool now carries its
/// `trust_class` on its trait-registry spec; the default covers the
/// unknown-tool case (model hallucinates a name) — wrap defensively.
pub fn trust_class(name: &str) -> TrustClass {
    if let Some(spec) = super::tool_trait::find(name) {
        return spec.trust_class;
    }
    TrustClass::ExternalRead
}

/// Return `true` if the tool performs a side effect that should require
/// the user to confirm before dispatch. Every tool now carries its
/// `dangerous` flag on the trait-registry spec; unknown tool names are
/// treated as non-dangerous because dispatch will already fail them
/// with `unknown tool:` before any side effect.
pub fn is_dangerous(name: &str) -> bool {
    if let Some(spec) = super::tool_trait::find(name) {
        return spec.dangerous;
    }
    false
}

/// Tools whose output is not safe to feed through text-to-speech —
/// raw binary blobs (base64 PNGs), OCR dumps the model tends to echo
/// verbatim, or vision descriptions dependent on a multimodal model
/// that may not be installed. On voice sessions the dispatcher refuses
/// these with a structured error the LLM can speak back ("I can't run
/// screen capture over voice — try the HUD") rather than letting
/// Kokoro read gigabytes of base64 to the user.
///
/// This is the authoritative list. Keep sorted by module of origin so
/// additions are obvious on review.
const VOICE_UNSAFE_TOOLS: &[&str] = &[
    // agent_loop/tools/computer_use/ + tools/system/
    "screen_capture",
    "screen_capture_full",
    "screen_capture_active_window",
    "screen_capture_region",
    // agent_loop/tools/vision/
    "image_describe",
];

/// Return `true` if the tool should be blocked on voice sessions.
/// Checked in `dispatch_tool` alongside the voice-aware ConfirmGate
/// skip so the two protections run in the same phase.
pub fn is_voice_unsafe(name: &str) -> bool {
    VOICE_UNSAFE_TOOLS.contains(&name)
}

/// Return the LLM-visible tool catalog. Every tool is registered
/// through `agent_loop::tool_trait` via `inventory::submit!`; this
/// helper projects each spec into the provider-shared `ToolSpec`
/// shape the Anthropic / Ollama / GLM payload builders consume.
///
/// Returning `Vec<ToolSpec>` (cheap — `ToolSpec` is `Copy`) rather
/// than a borrowed iterator keeps the provider call-sites untouched:
/// they iterate + map into provider-specific JSON, and the Anthropic
/// cache_control sentinel keys off the last entry of this Vec.
pub fn catalog_merged() -> Vec<ToolSpec> {
    super::tool_trait::all()
        .map(|spec| ToolSpec {
            name: spec.name,
            description: spec.description,
            input_schema: spec.input_schema,
        })
        .collect()
}

/// Return the memoised OpenAI-chat-completions-shaped tool array that
/// GLM, Kimi, Ollama, and OpenClaw all send on every request:
///
/// ```json
/// [
///   {
///     "type": "function",
///     "function": { "name": "...", "description": "...", "parameters": {...} }
///   },
///   ...
/// ]
/// ```
///
/// The trait-registered catalog is static after `inventory::submit!`
/// link-time registration, so the parsed schema values never change.
/// Callers `.clone()` the returned Vec per request — a deep clone of
/// ~20 small Value trees is still 5-10× cheaper than re-parsing each
/// `input_schema` JSON-string literal via `serde_json::from_str` on
/// every turn.
///
/// Anthropic uses a different shape (adds `cache_control` on the last
/// entry) — see `providers::anthropic::anthropic_tools_catalog`.
pub fn openai_chat_tools_catalog() -> &'static Vec<serde_json::Value> {
    use serde_json::{json, Value};
    use std::sync::OnceLock;

    static CACHED: OnceLock<Vec<Value>> = OnceLock::new();
    CACHED.get_or_init(|| {
        let mut tools: Vec<Value> = catalog_merged()
            .iter()
            .map(|t| {
                let schema: Value = serde_json::from_str(t.input_schema)
                    .unwrap_or_else(|_| json!({"type": "object", "properties": {}}));
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": schema,
                    }
                })
            })
            .collect();
        // Append every plugin-declared tool. Plugin registration
        // happens in `startup::setup` via `plugins::bootstrap`, which
        // runs before the Tauri event loop starts — i.e. before any
        // LLM request can trigger this OnceLock. On a fresh install
        // (or during unit tests where bootstrap doesn't run) the
        // registry is empty and this loop contributes nothing.
        for plugin in super::plugins::registered_plugins() {
            for t in &plugin.manifest.tools {
                tools.push(json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                }));
            }
        }
        tools
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_voice_unsafe_flags_every_screen_capture_variant() {
        // All four screen capture tools return base64 PNG payloads —
        // Kokoro would read the raw bytes. Treat the list as a
        // contract: if any variant is removed from the filter, the
        // matching tool must also be removed from the agent's registry.
        assert!(is_voice_unsafe("screen_capture"));
        assert!(is_voice_unsafe("screen_capture_full"));
        assert!(is_voice_unsafe("screen_capture_active_window"));
        assert!(is_voice_unsafe("screen_capture_region"));
    }

    #[test]
    fn is_voice_unsafe_flags_image_describe() {
        // Depends on an optional multimodal Ollama model
        // (`minicpm-v:8b`); a missing model produces a long error
        // string the LLM tends to forward to TTS.
        assert!(is_voice_unsafe("image_describe"));
    }

    #[test]
    fn is_voice_unsafe_does_not_flag_tts_safe_tools() {
        // Spot-check common voice-path tools that MUST pass through so
        // the guard can't accidentally be too broad.
        assert!(!is_voice_unsafe("memory_remember"));
        assert!(!is_voice_unsafe("memory_recall"));
        assert!(!is_voice_unsafe("spawn_subagent"));
        assert!(!is_voice_unsafe("schedule_recurring"));
        assert!(!is_voice_unsafe("calendar_list_events"));
        assert!(!is_voice_unsafe("unknown_tool_name"));
    }

    /// The OpenAI-chat-shaped catalog returns the same `&'static Vec`
    /// on repeat calls — the whole point is to avoid re-parsing every
    /// turn across GLM, Kimi, Ollama, and OpenClaw.
    #[test]
    fn openai_chat_tools_catalog_is_memoised() {
        let a = openai_chat_tools_catalog();
        let b = openai_chat_tools_catalog();
        assert!(
            std::ptr::eq(a, b),
            "memoised catalog must return the same static reference"
        );
    }

    /// Every entry must carry the OpenAI-chat shape used by every
    /// non-Anthropic provider: `{type: "function", function: {name,
    /// description, parameters}}`. A refactor that drops one of those
    /// fields would break tool-use across four providers simultaneously.
    #[test]
    fn openai_chat_tools_carry_required_fields() {
        let tools = openai_chat_tools_catalog();
        assert!(!tools.is_empty(), "catalog must not be empty");
        for (i, t) in tools.iter().enumerate() {
            assert_eq!(
                t["type"], "function",
                "tool #{i} must have type=\"function\""
            );
            let f = &t["function"];
            assert!(
                f["name"].is_string(),
                "tool #{i} function.name must be a string"
            );
            assert!(
                f["description"].is_string(),
                "tool #{i} function.description must be a string"
            );
            assert!(
                f["parameters"].is_object(),
                "tool #{i} function.parameters must be an object"
            );
        }
    }
}
