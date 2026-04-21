//! `memory_compact*` and `memory_consolidator_*` Tauri commands.
//!
//! Consolidation (TS-driven clustering) and compaction (near-duplicate
//! semantic fact removal) both operate on the same semantic layer, so they
//! share this module as their halfway home.
//!
//! Compaction walks every live semantic fact, groups any whose embeddings
//! exceed a cosine-similarity threshold (0.85 default), keeps the highest-
//! confidence representative per cluster, unions the losing rows' tags into
//! the survivor, and soft-tombstones the losers via `deleted_at`. Tombstoned
//! rows are hidden from list/search but remain physically present so a bad
//! compaction can be undone by clearing the column.
//!
//! Runs on `spawn_blocking` — a full pass on a large semantic table can
//! take a second or two (n² cluster-head comparisons) and must not stall
//! the Tauri command runtime.

use crate::memory;

// -- Consolidator (TypeScript driven — see src/lib/consolidator.ts)

#[tauri::command]
pub fn memory_consolidator_pending(
    limit: Option<usize>,
) -> Result<Vec<memory::EpisodicItem>, String> {
    memory::consolidator::pending(limit)
}

#[tauri::command]
pub fn memory_consolidator_mark_done(ts: i64) -> Result<(), String> {
    memory::consolidator::mark_done(ts)
}

#[tauri::command]
pub fn memory_consolidator_status(
) -> Result<memory::consolidator::ConsolidationStatus, String> {
    memory::consolidator::status()
}

// -- Semantic compaction

#[tauri::command]
pub async fn memory_compact(
    threshold: Option<f32>,
) -> Result<memory::compact::CompactReport, String> {
    tokio::task::spawn_blocking(move || memory::compact::run_compaction(threshold))
        .await
        .map_err(|e| format!("compact join: {e}"))?
}

#[tauri::command]
pub fn memory_compact_last_run() -> Option<i64> {
    memory::compact::last_compaction_ts()
}
