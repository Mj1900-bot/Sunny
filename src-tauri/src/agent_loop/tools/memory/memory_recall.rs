//! `memory_recall` — hybrid BM25+embedding search over long-term memory.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["memory.read"];

const SCHEMA: &str = r#"{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"},"blend":{"type":"number","minimum":0.0,"maximum":1.0,"description":"Blend weight between BM25 (1.0) and embedding cosine (0.0). Default 0.6."},"expand":{"type":"boolean","description":"If true, paraphrase the query into several variants and merge hits across them. Opt-in; costs ~0.5–1 s. Default false."}},"required":["query"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = string_arg(&input, "query")?;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        // Optional blend weight. 1.0 = pure BM25, 0.0 = pure embedding.
        // Accept `blend` or `alpha` so the LLM can use either idiom.
        let blend = input
            .get("blend")
            .or_else(|| input.get("alpha"))
            .and_then(|v| v.as_f64())
            .map(|f| f as f32);
        let expand = input
            .get("expand")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let opts = crate::memory::hybrid::SearchOpts {
            limit,
            alpha: blend,
            expand,
            max_variants: None,
        };
        match crate::memory::hybrid::search(query, opts).await {
            Ok(hits) => {
                if hits.is_empty() {
                    Ok("No matching memories.".to_string())
                } else {
                    // Preserve legacy one-line-per-item wire shape.
                    let lines: Vec<String> = hits
                        .iter()
                        .take(10)
                        .map(|h| {
                            serde_json::to_string(&h.item)
                                .unwrap_or_else(|_| "<unserializable>".to_string())
                        })
                        .collect();
                    Ok(lines.join("\n"))
                }
            }
            Err(e) => Err(format!("memory_search failed: {e}")),
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "memory_recall",
        description: "USE THIS when Sunny says 'what's my name', 'where do I live', 'what did I tell you about Y', 'what do I prefer', 'remember when I said…'. Returns matching facts from SUNNY's long-term memory. Call FIRST whenever Sunny refers to herself, her preferences, or prior conversations — never answer from conversation history alone. Hybrid BM25+embedding search; `blend` (1.0=keyword, 0.0=semantic, default 0.6). Set `expand=true` on preference-style queries to merge paraphrase hits (+0.5–1 s).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
