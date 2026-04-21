import { invokeSafe } from '../../lib/tauri';
import type { UsageRecord } from '../../bindings/UsageRecord';

// Re-export the ts-rs-generated type so existing call sites (AuditPage,
// snapshots.ts, tests) keep importing `UsageRecord` from this module.
// The single source of truth is the Rust `memory::tool_usage::UsageRecord`
// struct; regenerate via `cargo test --lib export_bindings_`.
export type { UsageRecord };

export type ToolStats = {
  tool_name: string;
  count: number;
  ok_count: number;
  err_count: number;
  success_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  last_at: number | null;
  last_ok: boolean | null;
};

export async function recent(
  limit = 200,
  onlyErrors = false,
  toolName?: string,
): Promise<ReadonlyArray<UsageRecord>> {
  return (
    (await invokeSafe<UsageRecord[]>('tool_usage_recent', {
      opts: { limit, only_errors: onlyErrors, tool_name: toolName ?? null },
    })) ?? []
  );
}

export async function stats(sinceDays = 7): Promise<ReadonlyArray<ToolStats>> {
  return (
    (await invokeSafe<ToolStats[]>('tool_usage_stats', {
      opts: { since_secs_ago: sinceDays * 86_400 },
    })) ?? []
  );
}

/**
 * Dangerous-tool classification.
 *
 * SOURCE OF TRUTH: `src-tauri/src/agent_loop/catalog.rs::is_dangerous`.
 * The Rust list (first block) enumerates the exact tool names the agent
 * gate requires confirmation for. The second block preserves legacy
 * frontend-registry names so older audit rows still flag correctly.
 */
export const DANGEROUS_TOOLS: ReadonlySet<string> = new Set<string>([
  // canonical — matches agent_loop/catalog.rs::is_dangerous
  'mail_send',
  'imessage_send',
  'messaging_send_sms',
  'calendar_create_event',
  'notes_create',
  'notes_append',
  'reminders_add',
  'app_launch',
  'app_quit',
  'shortcut_run',
  'finder_reveal',
  'browser_open',
  'browser_back',
  'browser_forward',
  'browser_close_tab',
  'browser_tab_select',
  'scheduler_add',

  // legacy / frontend-registry flags (kept for historical audit rows)
  'mouse_move',
  'mouse_click',
  'mouse_click_at',
  'mouse_scroll',
  'keyboard_type',
  'keyboard_tap',
  'keyboard_combo',
  'run_shell',
  'fs_trash',
  'fs_mkdir',
  'fs_new_file',
  'fs_rename',
  'fs_copy',
  'send_imessage',
  'send_sms',
  'text_contact',
  'call_contact',
  'py_run',
  'reminders_create',
  'notes_app_create',
  'notes_app_append',
]);

/** Predicate form — use when consumers want a function signature. */
export function isDangerous(toolName: string): boolean {
  return DANGEROUS_TOOLS.has(toolName);
}
