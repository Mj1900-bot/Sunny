//! `tool_usage_*` Tauri commands — per-tool reliability and latency telemetry.

use crate::memory;

#[tauri::command]
pub fn tool_usage_record(
    tool_name: String,
    ok: bool,
    latency_ms: i64,
    error_msg: Option<String>,
) -> Result<(), String> {
    memory::tool_usage::record(&tool_name, ok, latency_ms, error_msg.as_deref(), None)
}

#[tauri::command]
pub fn tool_usage_stats(
    opts: Option<memory::tool_usage::StatsOptions>,
) -> Result<Vec<memory::tool_usage::ToolStats>, String> {
    memory::tool_usage::stats(opts.unwrap_or_default())
}

#[tauri::command]
pub fn tool_usage_recent(
    opts: Option<memory::tool_usage::RecentOptions>,
) -> Result<Vec<memory::tool_usage::UsageRecord>, String> {
    memory::tool_usage::recent(opts.unwrap_or_default())
}

#[tauri::command]
pub fn tool_usage_daily_buckets(
    opts: Option<memory::tool_usage::DailyBucketsOptions>,
) -> Result<Vec<memory::tool_usage::DailyBucket>, String> {
    memory::tool_usage::daily_buckets(opts.unwrap_or_default())
}
