//! Trait-registry adapter for `summarize_pdf`.
//!
//! The composite implementation lives in
//! `agent_loop::summarize_pdf`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"Absolute path or ~/ path to a PDF file."},"max_chars":{"type":"integer","description":"Max chars of extracted text to pass to the summariser (default 32768, hard cap 200000). Longer PDFs are head+tail clipped."}},"required":["path"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (path, max_chars) = crate::agent_loop::summarize_pdf::parse_input(&input)?;
        crate::agent_loop::summarize_pdf::summarize_pdf(
            ctx.app,
            &path,
            max_chars,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "summarize_pdf",
        description: "Read a PDF from disk and return a five-bullet summary. Uses the `pdftotext` CLI (poppler) to extract text, then spawns a summariser sub-agent with a strict five-bullet prompt. Use when Sunny says 'summarise this PDF', 'give me the TL;DR of that contract', or points at a .pdf file. Returns a plain-text summary suitable to speak aloud. If pdftotext is missing the tool fails with a clear message telling Sunny to `brew install poppler`. Read-only — does not modify the PDF.",
        input_schema: SCHEMA,
        required_capabilities: &["shell.sandbox"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
