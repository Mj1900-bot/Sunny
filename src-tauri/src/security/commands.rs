//! Tauri command wrappers for the security module.
//!
//! Thin bridges between the webview and the in-process `SecurityBus`
//! + watchers.  All heavy lifting lives in sibling files — this
//! module exists so `lib.rs` can register commands without pulling
//! half the security tree into its signature.

use std::path::PathBuf;

use super::behavior::{snapshot as behavior_snapshot, ToolRateSnapshot};
use super::connections::{snapshot as conn_snapshot, Connection};
use super::enforcement::{self, EgressMode, EnforcementPolicy};
use super::fim::{current_baseline as fim_current, FimBaseline};
use super::incident::{self, IncidentEntry};
use super::integrity::{bundle_info, current_grid as integrity_grid, env_fingerprint, BundleInfo, IntegrityGrid};
use super::panic::{engage, release, PanicReport};
use super::policy::{compute_summary, Summary};
use super::shell_safety::{self, ShellFinding};
use super::outbound::{self, OutboundFinding};
use super::watchers::launch_agents::{self, LaunchBaseline, LaunchDiff};
use super::watchers::login_items;
use super::watchers::perm_poll::{self, PermGrid};
use super::watchers::process_tree::{self, DescendantProcess};
use super::xprotect::{self, XprotectStatus};
use super::SecurityEvent;

/// Current live summary. Computed on demand from the ring buffer so
/// the nav-strip / Overview tab get a fresh snapshot even right after
/// mount (before the first debounced `sunny://security.summary`
/// broadcast arrives).
#[tauri::command]
pub async fn security_summary() -> Summary {
    compute_summary()
}

/// Paginated event stream. `limit` defaults to 200, hard cap 2000
/// (matches ring capacity). `since` filters to events at or after
/// the given unix timestamp. Returned newest-last so the UI can
/// `push` without rearranging.
#[tauri::command]
pub async fn security_events(limit: Option<usize>, since: Option<i64>) -> Vec<SecurityEvent> {
    let lim = limit.unwrap_or(200).min(2000);
    super::store()
        .map(|s| s.recent(lim, since))
        .unwrap_or_default()
}

/// Copy the full JSONL audit log to the caller-supplied destination.
/// Returns the number of bytes written; `0` if the log hasn't been
/// initialised yet.
#[tauri::command]
pub async fn security_audit_export(dst: String) -> Result<u64, String> {
    let path = PathBuf::from(dst);
    super::store()
        .ok_or_else(|| "security bus not installed".to_string())?
        .export(&path)
        .map_err(|e| format!("export failed: {e}"))
}

/// Engage panic mode.  Aborts agents, disables daemons, flips the
/// shared kill-switch flag.  Returns what changed.
#[tauri::command]
pub async fn security_panic(reason: Option<String>) -> PanicReport {
    engage(reason.unwrap_or_else(|| "user-requested".to_string()))
}

/// Release panic mode.  Daemons stay disabled — the user re-enables
/// them intentionally from the AUTO page.
#[tauri::command]
pub async fn security_panic_reset(by: Option<String>) -> PanicReport {
    release(by.unwrap_or_else(|| "user".to_string()))
}

/// Live snapshot of the fork-bomb spawn budget. Diagnostic only — the
/// actual rate-limiting happens transparently inside tool dispatch via
/// `SpawnGuard::acquire`. The Security panel polls this to surface a
/// 'N of M spawn permits in use' read-out so saturation is visible.
#[tauri::command]
pub async fn security_spawn_budget() -> crate::process_budget::SpawnBudgetSnapshot {
    crate::process_budget::spawn_budget_snapshot()
}

/// Current LaunchAgents/Daemons baseline.  Used by the Intrusion tab
/// to render the "last captured" timestamp.
#[tauri::command]
pub async fn security_launch_baseline() -> LaunchBaseline {
    launch_agents::load_baseline()
}

/// Live diff against the stored baseline.  Does a fresh filesystem
/// scan every call — cheap (≈100 plists, small stat + read).
#[tauri::command]
pub async fn security_launch_diff() -> Result<LaunchDiff, String> {
    launch_agents::current_diff().await
}

/// Overwrite the baseline with the current filesystem state.
/// "Mark all reviewed" button on the Intrusion tab.
#[tauri::command]
pub async fn security_launch_reset_baseline() -> Result<usize, String> {
    launch_agents::reset_baseline().await
}

/// List current login items (name only — AppleScript surface).
#[tauri::command]
pub async fn security_login_items() -> Vec<String> {
    login_items::list().await
}

/// Full TCC permission grid.  Returns cached state plus a fresh poll
/// if the cache is empty.
#[tauri::command]
pub async fn security_perm_grid() -> PermGrid {
    perm_poll::current_grid().await
}

/// Report whether panic mode is currently engaged — cheap read-only
/// helper used by the UI to disable/re-enable controls without
/// waiting for a summary event.
#[tauri::command]
pub fn security_panic_mode() -> bool {
    super::panic_mode()
}

/// Full system-integrity grid (SIP / Gatekeeper / FileVault /
/// Firewall / Sunny bundle codesign / config profiles).  Cached
/// snapshot is returned if the 2-minute poller has one, else a
/// fresh probe is run.
#[tauri::command]
pub async fn security_integrity_grid() -> IntegrityGrid {
    integrity_grid().await
}

/// Sunny process / bundle identity metadata the SYSTEM tab renders
/// above the integrity grid.
#[tauri::command]
pub async fn security_bundle_info() -> BundleInfo {
    bundle_info().await
}

/// Fresh `lsof -iP` snapshot of Sunny's active network sockets.
#[tauri::command]
pub async fn security_connections() -> Vec<Connection> {
    conn_snapshot().await
}

/// Per-tool rate snapshot (rate/min, baseline, z-score).
#[tauri::command]
pub async fn security_tool_rates() -> Vec<ToolRateSnapshot> {
    behavior_snapshot()
}

/// Current FIM hashes for the tracked config/state files.
#[tauri::command]
pub async fn security_fim_baseline() -> FimBaseline {
    fim_current()
}

/// Short, allowlisted env-variable fingerprint (names + non-sensitive
/// values) for the SYSTEM tab.
#[tauri::command]
pub async fn security_env_fingerprint() -> std::collections::HashMap<String, String> {
    env_fingerprint()
}

/// Canary token metadata (short prefix + hash tail — never the full
/// value) so the UI can confirm the tripwire is armed without
/// accidentally echoing the secret somewhere unintended.
#[tauri::command]
pub async fn security_canary_status() -> serde_json::Value {
    let tok = super::canary::token().unwrap_or("");
    let armed = !tok.is_empty();
    let short = if tok.len() > 14 {
        format!("{}…{}", &tok[..10], &tok[tok.len() - 4..])
    } else { tok.to_string() };
    serde_json::json!({
        "armed": armed,
        "token_preview": short,
        "location": "~/.sunny/security/canary.txt · SUNNY_CANARY_TOKEN env",
    })
}

// ------------------------------------------------------------------
// Process-tree descendants — for SYSTEM tab.
// ------------------------------------------------------------------

#[tauri::command]
pub async fn security_process_tree() -> Vec<DescendantProcess> {
    process_tree::snapshot()
}

// ------------------------------------------------------------------
// Enforcement policy — Phase 3.
// ------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Default, ts_rs::TS)]
#[ts(export)]
pub struct PolicyPatch {
    #[serde(default)]
    pub egress_mode: Option<String>, // "observe" | "warn" | "block"
    #[serde(default)]
    pub force_confirm_all: Option<bool>,
    #[serde(default)]
    pub scrub_prompts: Option<bool>,
    #[serde(default)]
    pub subagent_role_scoping: Option<bool>,
}

/// Full policy snapshot.
#[tauri::command]
pub async fn security_policy_get() -> EnforcementPolicy {
    enforcement::snapshot()
}

/// Patch the policy with a partial update.  Flags are optional; any
/// field not included in the patch keeps its current value.
#[tauri::command]
pub async fn security_policy_patch(patch: PolicyPatch) -> EnforcementPolicy {
    let reason = {
        let mut bits: Vec<String> = Vec::new();
        if let Some(m) = patch.egress_mode.as_deref() {
            bits.push(format!("egress_mode={m}"));
        }
        if let Some(v) = patch.force_confirm_all { bits.push(format!("force_confirm_all={v}")); }
        if let Some(v) = patch.scrub_prompts { bits.push(format!("scrub_prompts={v}")); }
        if let Some(v) = patch.subagent_role_scoping { bits.push(format!("subagent_role_scoping={v}")); }
        if bits.is_empty() { "noop".into() } else { bits.join(", ") }
    };
    enforcement::mutate(&reason, |p| {
        if let Some(m) = patch.egress_mode.as_deref() {
            p.egress_mode = match m {
                "block" => EgressMode::Block,
                "warn" => EgressMode::Warn,
                _ => EgressMode::Observe,
            };
        }
        if let Some(v) = patch.force_confirm_all { p.force_confirm_all = v; }
        if let Some(v) = patch.scrub_prompts { p.scrub_prompts = v; }
        if let Some(v) = patch.subagent_role_scoping { p.subagent_role_scoping = v; }
    });
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_allow_host(host: String) -> EnforcementPolicy {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() { return enforcement::snapshot(); }
    enforcement::mutate(&format!("allow {host}"), |p| {
        p.blocked_hosts.remove(&host);
        p.allowed_hosts.insert(host.clone());
    });
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_block_host(host: String) -> EnforcementPolicy {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() { return enforcement::snapshot(); }
    enforcement::mutate(&format!("block {host}"), |p| {
        p.allowed_hosts.remove(&host);
        p.blocked_hosts.insert(host.clone());
    });
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_remove_host(host: String, list: String) -> EnforcementPolicy {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() { return enforcement::snapshot(); }
    enforcement::mutate(&format!("remove {host} from {list}"), |p| {
        match list.as_str() {
            "allowed" => { p.allowed_hosts.remove(&host); }
            "blocked" => { p.blocked_hosts.remove(&host); }
            _ => {}
        }
    });
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_disable_tool(tool: String) -> EnforcementPolicy {
    let tool = tool.trim().to_string();
    if tool.is_empty() { return enforcement::snapshot(); }
    enforcement::mutate(&format!("disable tool {tool}"), |p| {
        p.disabled_tools.insert(tool);
    });
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_enable_tool(tool: String) -> EnforcementPolicy {
    let tool = tool.trim().to_string();
    if tool.is_empty() { return enforcement::snapshot(); }
    enforcement::mutate(&format!("enable tool {tool}"), |p| {
        p.disabled_tools.remove(&tool);
    });
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_reset() -> EnforcementPolicy {
    enforcement::reset();
    enforcement::snapshot()
}

#[tauri::command]
pub async fn security_policy_set_quota(tool: String, cap: Option<u32>) -> EnforcementPolicy {
    enforcement::set_quota(&tool, cap);
    enforcement::snapshot()
}

/// Today's per-tool counters (keyed by tool name).  Resets at local
/// midnight.
#[tauri::command]
pub async fn security_quota_usage() -> std::collections::BTreeMap<String, u32> {
    enforcement::quota_snapshot()
}

// ------------------------------------------------------------------
// Ad-hoc scanners
// ------------------------------------------------------------------

/// Run the outbound-content scanner on an arbitrary tool input.
/// Useful for the UI to preview findings against a draft before the
/// agent dispatches.
#[tauri::command]
pub async fn security_scan_outbound(tool: String, input: serde_json::Value) -> Vec<OutboundFinding> {
    outbound::scan_outbound(&tool, &input)
}

/// Ad-hoc shell-scanner probe (no execution, no audit event).
#[tauri::command]
pub async fn security_scan_shell(cmd: String) -> Vec<ShellFinding> {
    shell_safety::scan(&cmd)
}

// ------------------------------------------------------------------
// Incidents + XProtect
// ------------------------------------------------------------------

#[tauri::command]
pub async fn security_incidents_list() -> Vec<IncidentEntry> {
    incident::list()
}

#[tauri::command]
pub async fn security_incident_capture(reason: String) -> Option<String> {
    incident::capture(&reason).await.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn security_xprotect_status() -> XprotectStatus {
    xprotect::snapshot().await
}

// ------------------------------------------------------------------
// TS-runtime tool-call bridge
// ------------------------------------------------------------------

/// Emit a `ToolCall` event from a TS-dispatched tool (voice path via
/// `lib/tools/registry.ts`).  The Rust-side `dispatch::dispatch_tool`
/// already emits these for agent-loop tools; this command fills the
/// gap so tools that run entirely in the webview still land in the
/// SecurityBus + JSONL audit log.
///
/// Input is run through `preview_input` (which truncates) and then
/// the usual `redact::scrub_event` pass happens inside `emit()`, so
/// secrets never escape to the audit log.
#[tauri::command]
pub fn security_emit_tool_call(
    tool: String,
    input: serde_json::Value,
    ok: bool,
    latency_ms: u64,
    agent: Option<String>,
) {
    let preview = super::preview_input(&input, 256);
    let duration_ms: i64 = i64::try_from(latency_ms).unwrap_or(i64::MAX);
    let severity = if ok { super::Severity::Info } else { super::Severity::Warn };
    let agent_label = agent.unwrap_or_else(|| "ts-runtime".into());

    super::emit(SecurityEvent::ToolCall {
        at: super::now(),
        id: uuid::Uuid::new_v4().to_string(),
        tool: tool.clone(),
        risk: "standard",
        dangerous: false,
        agent: agent_label,
        input_preview: preview,
        ok: Some(ok),
        output_bytes: None,
        duration_ms: Some(duration_ms),
        severity,
    });

    super::behavior::record_tool_call(&tool);
}
