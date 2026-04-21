//! `memory_retention_*` Tauri commands — deterministic episodic decay sweep.

use crate::memory;

#[tauri::command]
pub fn memory_retention_run(
    opts: Option<memory::retention::RetentionOptions>,
) -> Result<memory::retention::RetentionResult, String> {
    memory::retention::run_sweep(opts.unwrap_or_default())
}

#[tauri::command]
pub fn memory_retention_last_sweep() -> Option<i64> {
    memory::retention::last_sweep_ts()
}
