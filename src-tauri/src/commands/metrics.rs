//! System metrics commands.

use crate::app_state::AppState;
use crate::metrics;

#[tauri::command]
pub fn get_metrics(state: tauri::State<'_, AppState>) -> metrics::SystemMetrics {
    state.collector.lock().unwrap().sample()
}

#[tauri::command]
pub fn get_processes(state: tauri::State<'_, AppState>, limit: Option<usize>) -> Vec<metrics::ProcessRow> {
    state.collector.lock().unwrap().processes(limit.unwrap_or(8))
}

#[tauri::command]
pub fn get_net(state: tauri::State<'_, AppState>) -> metrics::NetStats {
    state.collector.lock().unwrap().net()
}

#[tauri::command]
pub fn get_battery() -> Option<metrics::BatteryInfo> {
    metrics::battery()
}
