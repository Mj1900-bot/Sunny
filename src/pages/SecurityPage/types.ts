/**
 * Wire-types shared with the Rust `security` module.
 * Must stay in sync with `src-tauri/src/security/mod.rs`.
 */

export type Severity = 'info' | 'warn' | 'crit';
export type BucketStatus = 'unknown' | 'ok' | 'warn' | 'crit';

export type Summary = {
  readonly severity: BucketStatus;
  readonly agent: BucketStatus;
  readonly net: BucketStatus;
  readonly perm: BucketStatus;
  readonly host: BucketStatus;
  readonly panic_mode: boolean;
  readonly headline?: string;
  readonly counts: {
    readonly events_window: number;
    readonly tool_calls_window: number;
    readonly net_requests_window: number;
    readonly warn_window: number;
    readonly crit_window: number;
    readonly egress_bytes_window: number;
    readonly anomalies_window: number;
  };
  readonly threat_score: number;
  readonly minute_events: ReadonlyArray<number>;
  readonly minute_tool_calls: ReadonlyArray<number>;
  readonly minute_net_bytes: ReadonlyArray<number>;
  readonly top_hosts: ReadonlyArray<{ host: string; count: number; bytes: number }>;
  readonly updated_at: number;
};

export type ToolCallEvent = {
  readonly kind: 'tool_call';
  readonly at: number;
  readonly id: string;
  readonly tool: string;
  readonly risk: string;
  readonly dangerous: boolean;
  readonly agent: string;
  readonly input_preview: string;
  readonly ok: boolean | null;
  readonly output_bytes: number | null;
  readonly duration_ms: number | null;
  readonly severity: Severity;
};

export type ConfirmRequestedEvent = {
  readonly kind: 'confirm_requested';
  readonly at: number;
  readonly id: string;
  readonly tool: string;
  readonly requester: string;
  readonly preview: string;
};

export type ConfirmAnsweredEvent = {
  readonly kind: 'confirm_answered';
  readonly at: number;
  readonly id: string;
  readonly approved: boolean;
  readonly reason: string | null;
};

export type SecretReadEvent = {
  readonly kind: 'secret_read';
  readonly at: number;
  readonly provider: string;
  readonly caller: string;
};

export type NetRequestEvent = {
  readonly kind: 'net_request';
  readonly at: number;
  readonly id: string;
  readonly method: string;
  readonly host: string;
  readonly path_prefix: string;
  readonly initiator: string;
  readonly status: number | null;
  readonly bytes: number | null;
  readonly duration_ms: number | null;
  readonly blocked: boolean;
  readonly severity: Severity;
};

export type PermissionChangeEvent = {
  readonly kind: 'permission_change';
  readonly at: number;
  readonly key: string;
  readonly previous: string | null;
  readonly current: string;
  readonly severity: Severity;
};

export type LaunchAgentDeltaEvent = {
  readonly kind: 'launch_agent_delta';
  readonly at: number;
  readonly path: string;
  readonly change: string;
  readonly sha1: string | null;
  readonly severity: Severity;
};

export type LoginItemDeltaEvent = {
  readonly kind: 'login_item_delta';
  readonly at: number;
  readonly name: string;
  readonly change: string;
  readonly severity: Severity;
};

export type UnsignedBinaryEvent = {
  readonly kind: 'unsigned_binary';
  readonly at: number;
  readonly path: string;
  readonly initiator: string;
  readonly reason: string;
  readonly severity: Severity;
};

export type PanicEvent = {
  readonly kind: 'panic';
  readonly at: number;
  readonly reason: string;
};

export type PanicResetEvent = {
  readonly kind: 'panic_reset';
  readonly at: number;
  readonly by: string;
};

export type NoticeEvent = {
  readonly kind: 'notice';
  readonly at: number;
  readonly source: string;
  readonly message: string;
  readonly severity: Severity;
};

export type PromptInjectionEvent = {
  readonly kind: 'prompt_injection';
  readonly at: number;
  readonly source: string;
  readonly signals: ReadonlyArray<string>;
  readonly excerpt: string;
  readonly severity: Severity;
};

export type CanaryTrippedEvent = {
  readonly kind: 'canary_tripped';
  readonly at: number;
  readonly destination: string;
  readonly context: string;
};

export type ToolRateAnomalyEvent = {
  readonly kind: 'tool_rate_anomaly';
  readonly at: number;
  readonly tool: string;
  readonly rate_per_min: number;
  readonly baseline_per_min: number;
  readonly z_score: number;
  readonly severity: Severity;
};

export type IntegrityStatusEvent = {
  readonly kind: 'integrity_status';
  readonly at: number;
  readonly key: string;
  readonly status: string;
  readonly detail: string;
  readonly severity: Severity;
};

export type FileIntegrityChangeEvent = {
  readonly kind: 'file_integrity_change';
  readonly at: number;
  readonly path: string;
  readonly prev_sha256: string | null;
  readonly curr_sha256: string;
  readonly severity: Severity;
};

export type SecurityEvent =
  | ToolCallEvent
  | ConfirmRequestedEvent
  | ConfirmAnsweredEvent
  | SecretReadEvent
  | NetRequestEvent
  | PermissionChangeEvent
  | LaunchAgentDeltaEvent
  | LoginItemDeltaEvent
  | UnsignedBinaryEvent
  | PanicEvent
  | PanicResetEvent
  | PromptInjectionEvent
  | CanaryTrippedEvent
  | ToolRateAnomalyEvent
  | IntegrityStatusEvent
  | FileIntegrityChangeEvent
  | NoticeEvent;

export type IntegrityRow = {
  readonly status: string;
  readonly summary: string;
  readonly detail: string;
  readonly checked_at: number;
};

export type IntegrityGrid = {
  readonly sip: IntegrityRow;
  readonly gatekeeper: IntegrityRow;
  readonly filevault: IntegrityRow;
  readonly firewall: IntegrityRow;
  readonly bundle: IntegrityRow;
  readonly config_profiles: IntegrityRow;
  readonly updated_at: number;
};

export type BundleInfo = {
  readonly pid: number;
  readonly bundle_path: string;
  readonly exe_path: string;
  readonly version: string;
  readonly signer: string;
};

export type Connection = {
  readonly protocol: string;
  readonly local: string;
  readonly remote: string;
  readonly state: string;
  readonly fd: string;
};

export type ToolRateSnapshot = {
  readonly tool: string;
  readonly total_calls: number;
  readonly rate_per_min: number;
  readonly baseline_per_min: number;
  readonly z_score: number;
};

export type FimEntry = {
  readonly path: string;
  readonly exists: boolean;
  readonly size: number;
  readonly sha256: string;
  readonly modified: number;
  readonly checked_at: number;
};

export type FimBaseline = {
  readonly captured_at: number;
  readonly entries: Record<string, FimEntry>;
};

export type CanaryStatus = {
  readonly armed: boolean;
  readonly token_preview: string;
  readonly location: string;
};

export type DescendantProcess = {
  readonly pid: number;
  readonly parent_pid: number;
  readonly name: string;
  readonly exe: string;
  readonly cmd: string;
};

export type EgressMode = 'observe' | 'warn' | 'block';

export type EnforcementPolicy = {
  readonly egress_mode: EgressMode;
  readonly allowed_hosts: ReadonlyArray<string>;
  readonly blocked_hosts: ReadonlyArray<string>;
  readonly disabled_tools: ReadonlyArray<string>;
  readonly force_confirm_all: boolean;
  readonly scrub_prompts: boolean;
  readonly subagent_role_scoping: boolean;
  readonly tool_quotas: Record<string, number>;
  readonly revision: number;
};

export type OutboundFinding = {
  readonly kind: string;
  readonly detail: string;
  readonly severity: 'info' | 'warn' | 'crit';
};

export type ShellFinding = {
  readonly pattern: string;
  readonly severity: 'info' | 'warn' | 'crit';
  readonly detail: string;
};

export type IncidentEntry = {
  readonly path: string;
  readonly captured_at: number;
  readonly size: number;
};

export type XprotectStatus = {
  readonly present: boolean;
  readonly version: string;
  readonly rules_path: string;
  readonly rules_count: number;
  readonly rules_size: number;
  readonly rules_sha256: string;
};

export type PolicyPatch = {
  readonly egress_mode?: EgressMode;
  readonly force_confirm_all?: boolean;
  readonly scrub_prompts?: boolean;
  readonly subagent_role_scoping?: boolean;
};

export type PermState = 'unknown' | 'granted' | 'denied' | 'error';

export type PermGrid = {
  readonly screen_recording: PermState;
  readonly accessibility: PermState;
  readonly full_disk_access: PermState;
  readonly automation: PermState;
  readonly microphone: PermState;
  readonly camera: PermState;
  readonly contacts: PermState;
  readonly calendar: PermState;
  readonly reminders: PermState;
  readonly photos: PermState;
  readonly input_monitoring: PermState;
  readonly updated_at: number;
};

export type PlistEntry = {
  readonly path: string;
  readonly size: number;
  readonly modified: number;
  readonly sha1: string;
};

export type PlistChange = {
  readonly path: string;
  readonly previous: PlistEntry;
  readonly current: PlistEntry;
};

export type LaunchDiff = {
  readonly baseline_captured_at: number;
  readonly added: ReadonlyArray<PlistEntry>;
  readonly removed: ReadonlyArray<PlistEntry>;
  readonly changed: ReadonlyArray<PlistChange>;
  readonly unchanged_count: number;
};

export type LaunchBaseline = {
  readonly captured_at: number;
  readonly entries: Record<string, PlistEntry>;
};

export type PanicReport = {
  readonly already_active: boolean;
  readonly daemons_disabled: number;
  readonly note: string;
};
