//! `memory_fact_*` Tauri commands — semantic fact surface.

use crate::memory;

#[tauri::command]
pub fn memory_fact_add(
    subject: Option<String>,
    text: String,
    tags: Option<Vec<String>>,
    confidence: Option<f64>,
    source: Option<String>,
) -> Result<memory::SemanticFact, String> {
    memory::semantic_add(
        subject.unwrap_or_default(),
        text,
        tags.unwrap_or_default(),
        confidence,
        source,
    )
}

#[tauri::command]
pub fn memory_fact_list(
    subject: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<memory::SemanticFact>, String> {
    memory::semantic_list(subject, limit, offset)
}

#[tauri::command]
pub fn memory_fact_search(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<memory::SemanticFact>, String> {
    memory::semantic_search(query, limit)
}

#[tauri::command]
pub fn memory_fact_delete(id: String) -> Result<(), String> {
    memory::semantic_delete(id)
}
