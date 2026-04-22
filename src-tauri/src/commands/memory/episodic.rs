//! `memory_episodic_*` Tauri commands — typed episodic memory surface.

use crate::memory;

#[tauri::command]
pub async fn memory_episodic_add(
    kind: Option<String>,
    text: String,
    tags: Option<Vec<String>>,
    meta: Option<serde_json::Value>,
) -> Result<memory::EpisodicItem, String> {
    let k = match kind.as_deref().unwrap_or("note") {
        "user" => memory::EpisodicKind::User,
        "agent_step" => memory::EpisodicKind::AgentStep,
        "tool_call" => memory::EpisodicKind::ToolCall,
        "perception" => memory::EpisodicKind::Perception,
        "reflection" => memory::EpisodicKind::Reflection,
        _ => memory::EpisodicKind::Note,
    };
    // Only Note / Reflection writes change the digest shape. User /
    // Perception / ToolCall rows feed breadcrumbs that the digest
    // builder deliberately filters out, so skipping their invalidation
    // preserves cache hits on the hot voice-turn path.
    let invalidate = matches!(
        k,
        memory::EpisodicKind::Note | memory::EpisodicKind::Reflection
    );
    let item = memory::episodic_add(
        k,
        text,
        tags.unwrap_or_default(),
        meta.unwrap_or(serde_json::Value::Null),
    )?;
    if invalidate {
        crate::agent_loop::session_cache::invalidate_all_digests().await;
    }
    Ok(item)
}

#[tauri::command]
pub fn memory_episodic_list(
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<memory::EpisodicItem>, String> {
    memory::episodic_list(limit, offset)
}

#[tauri::command]
pub fn memory_episodic_search(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<memory::EpisodicItem>, String> {
    memory::episodic_search(query, limit)
}
