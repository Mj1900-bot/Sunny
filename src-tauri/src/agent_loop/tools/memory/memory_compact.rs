//! `memory_compact` — cluster near-duplicate facts + soft-delete the rest.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["memory.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"threshold":{"type":"number","minimum":0.7,"maximum":0.9999,"description":"Cosine similarity cutoff 0.70–0.9999 (default 0.85). Higher = stricter clustering, fewer merges."}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let threshold = input
            .get("threshold")
            .and_then(|v| v.as_f64())
            .map(|f| f as f32);
        // Run on the blocking pool — clustering is quadratic in
        // cluster heads and can stall the tokio reactor on a large
        // fact store.
        let report = tokio::task::spawn_blocking(move || {
            crate::memory::compact::run_compaction(threshold)
        })
        .await
        .map_err(|e| format!("memory_compact join: {e}"))??;
        Ok(format!(
            "Compaction complete: considered={}, clusters={}, merged={}, deleted={}, threshold={:.2}",
            report.considered,
            report.clusters,
            report.merged,
            report.deleted,
            report.threshold_used,
        ))
    })
}

inventory::submit! {
    ToolSpec {
        name: "memory_compact",
        description: "(role=low-priority) Compact SUNNY's semantic memory — cluster near-duplicate facts by embedding cosine similarity, keep the highest-confidence representative per cluster, and soft-delete the rest. Only use when the user explicitly asks to tidy / dedupe / compact memory, or when scheduled automation invokes it. The default cosine threshold (0.85) is tuned for paraphrase-level duplicates; only override when the user specifies a different similarity band. Returns a report with {considered, clusters, merged, deleted}. Soft-deleted facts remain physically present so a mistuned run can be rolled back.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
