/**
 * Thin wrappers over the Rust security commands + live event
 * subscription helpers.  Every call gracefully degrades to a sane
 * empty value when we're running outside the Tauri runtime (e.g.
 * `pnpm dev` / vite preview).
 */

import { invokeSafe, listen, isTauri } from '../../lib/tauri';
import type {
  BundleInfo,
  CanaryStatus,
  Connection,
  DescendantProcess,
  EnforcementPolicy,
  FimBaseline,
  IncidentEntry,
  IntegrityGrid,
  LaunchBaseline,
  LaunchDiff,
  OutboundFinding,
  PanicReport,
  PermGrid,
  PolicyPatch,
  SecurityEvent,
  ShellFinding,
  Summary,
  ToolRateSnapshot,
  XprotectStatus,
} from './types';

const EMPTY_SUMMARY: Summary = {
  severity: 'ok',
  agent: 'ok',
  net: 'ok',
  perm: 'ok',
  host: 'ok',
  panic_mode: false,
  counts: {
    events_window: 0,
    tool_calls_window: 0,
    net_requests_window: 0,
    warn_window: 0,
    crit_window: 0,
    egress_bytes_window: 0,
    anomalies_window: 0,
  },
  threat_score: 0,
  minute_events: new Array(60).fill(0),
  minute_tool_calls: new Array(60).fill(0),
  minute_net_bytes: new Array(60).fill(0),
  top_hosts: [],
  updated_at: 0,
};

export async function fetchSummary(): Promise<Summary> {
  const v = await invokeSafe<Summary>('security_summary');
  return v ?? EMPTY_SUMMARY;
}

export async function fetchEvents(
  limit: number = 500,
  since?: number,
): Promise<ReadonlyArray<SecurityEvent>> {
  const v = await invokeSafe<ReadonlyArray<SecurityEvent>>('security_events', { limit, since });
  return v ?? [];
}

export async function exportAudit(dst: string): Promise<number> {
  const v = await invokeSafe<number>('security_audit_export', { dst });
  return v ?? 0;
}

export async function panic(reason?: string): Promise<PanicReport> {
  const v = await invokeSafe<PanicReport>('security_panic', { reason });
  return (
    v ?? { already_active: false, daemons_disabled: 0, note: 'not tauri' }
  );
}

export async function panicReset(by?: string): Promise<PanicReport> {
  const v = await invokeSafe<PanicReport>('security_panic_reset', { by });
  return (
    v ?? { already_active: false, daemons_disabled: 0, note: 'not tauri' }
  );
}

export async function fetchPanicMode(): Promise<boolean> {
  const v = await invokeSafe<boolean>('security_panic_mode');
  return v ?? false;
}

export async function fetchCapabilityDenials(
  limit: number = 200,
): Promise<ReadonlyArray<import('../../bindings/CapabilityDenialRow').CapabilityDenialRow>> {
  const v = await invokeSafe<
    ReadonlyArray<import('../../bindings/CapabilityDenialRow').CapabilityDenialRow>
  >('capability_tail_denials', { limit });
  return v ?? [];
}

export async function fetchCapabilityGrants(): Promise<
  import('../../bindings/GrantsFile').GrantsFile | null
> {
  return invokeSafe<import('../../bindings/GrantsFile').GrantsFile>(
    'capability_list_grants',
  );
}

export async function fetchPermGrid(): Promise<PermGrid | null> {
  return invokeSafe<PermGrid>('security_perm_grid');
}

export async function fetchLaunchBaseline(): Promise<LaunchBaseline | null> {
  return invokeSafe<LaunchBaseline>('security_launch_baseline');
}

export async function fetchLaunchDiff(): Promise<LaunchDiff | null> {
  return invokeSafe<LaunchDiff>('security_launch_diff');
}

export async function resetLaunchBaseline(): Promise<number> {
  const v = await invokeSafe<number>('security_launch_reset_baseline');
  return v ?? 0;
}

export async function fetchLoginItems(): Promise<ReadonlyArray<string>> {
  const v = await invokeSafe<ReadonlyArray<string>>('security_login_items');
  return v ?? [];
}

/**
 * Subscribe to the live `sunny://security.event` stream.  Returns the
 * unlisten function; callers must call it on unmount.  Emits a no-op
 * unlisten outside Tauri.
 */
export async function subscribeEvents(
  cb: (ev: SecurityEvent) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  return listen<SecurityEvent>('sunny://security.event', cb);
}

/**
 * Subscribe to the debounced summary stream (≤2 Hz).
 */
export async function subscribeSummary(
  cb: (s: Summary) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  return listen<Summary>('sunny://security.summary', cb);
}

export async function fetchIntegrityGrid(): Promise<IntegrityGrid | null> {
  return invokeSafe<IntegrityGrid>('security_integrity_grid');
}

export async function fetchBundleInfo(): Promise<BundleInfo | null> {
  return invokeSafe<BundleInfo>('security_bundle_info');
}

export async function fetchConnections(): Promise<ReadonlyArray<Connection>> {
  const v = await invokeSafe<ReadonlyArray<Connection>>('security_connections');
  return v ?? [];
}

export async function fetchToolRates(): Promise<ReadonlyArray<ToolRateSnapshot>> {
  const v = await invokeSafe<ReadonlyArray<ToolRateSnapshot>>('security_tool_rates');
  return v ?? [];
}

export async function fetchFimBaseline(): Promise<FimBaseline | null> {
  return invokeSafe<FimBaseline>('security_fim_baseline');
}

export async function fetchEnvFingerprint(): Promise<Record<string, string>> {
  const v = await invokeSafe<Record<string, string>>('security_env_fingerprint');
  return v ?? {};
}

export async function fetchCanaryStatus(): Promise<CanaryStatus | null> {
  return invokeSafe<CanaryStatus>('security_canary_status');
}

export async function fetchProcessTree(): Promise<ReadonlyArray<DescendantProcess>> {
  const v = await invokeSafe<ReadonlyArray<DescendantProcess>>('security_process_tree');
  return v ?? [];
}

// ------------------------------------------------------------------
// Enforcement policy (Phase 3)
// ------------------------------------------------------------------

export async function fetchPolicy(): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_get');
}

export async function patchPolicy(patch: PolicyPatch): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_patch', { patch });
}

export async function policyAllowHost(host: string): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_allow_host', { host });
}

export async function policyBlockHost(host: string): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_block_host', { host });
}

export async function policyRemoveHost(host: string, list: 'allowed' | 'blocked'): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_remove_host', { host, list });
}

export async function policyDisableTool(tool: string): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_disable_tool', { tool });
}

export async function policyEnableTool(tool: string): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_enable_tool', { tool });
}

export async function policyReset(): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_reset');
}

export async function policySetQuota(tool: string, cap: number | null): Promise<EnforcementPolicy | null> {
  return invokeSafe<EnforcementPolicy>('security_policy_set_quota', { tool, cap });
}

export async function fetchQuotaUsage(): Promise<Record<string, number>> {
  const v = await invokeSafe<Record<string, number>>('security_quota_usage');
  return v ?? {};
}

export async function scanOutbound(tool: string, input: unknown): Promise<ReadonlyArray<OutboundFinding>> {
  const v = await invokeSafe<ReadonlyArray<OutboundFinding>>('security_scan_outbound', { tool, input });
  return v ?? [];
}

export async function scanShell(cmd: string): Promise<ReadonlyArray<ShellFinding>> {
  const v = await invokeSafe<ReadonlyArray<ShellFinding>>('security_scan_shell', { cmd });
  return v ?? [];
}

export async function fetchIncidents(): Promise<ReadonlyArray<IncidentEntry>> {
  const v = await invokeSafe<ReadonlyArray<IncidentEntry>>('security_incidents_list');
  return v ?? [];
}

export async function fetchXprotect(): Promise<XprotectStatus | null> {
  return invokeSafe<XprotectStatus>('security_xprotect_status');
}
