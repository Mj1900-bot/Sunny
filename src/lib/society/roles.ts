/**
 * Agent Society — role specifications.
 *
 * Each **role** is a specialist persona with:
 *   • a distinct system-prompt fragment (how it should think)
 *   • a tool allowlist (what it can reach for)
 *   • trigger keywords the chair uses to match goals
 *
 * Roles are NOT a replacement for the main `runAgent` loop — they're an
 * optional specialization layer on top. When `Agent Society` mode is
 * enabled in settings, the chair dispatcher (`dispatcher.ts`) inspects
 * the goal and picks the best-fit role, then runs the normal agent loop
 * with a narrower tool set and a role-specialized prompt fragment.
 *
 * Off by default. Enables via `settings.societyEnabled = true` (see
 * `runAgent` integration). When enabled, every turn goes through the
 * chair; when disabled, behaviour is identical to pre-phase-11.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RoleId =
  | 'chair'
  | 'researcher'
  | 'coder'
  | 'operator'
  | 'scribe'
  | 'generalist';

export type RoleSpec = {
  readonly id: RoleId;
  /** Human-readable display name (used in insights + UI). */
  readonly name: string;
  /** One-line description shown to the chair in the dispatch prompt. */
  readonly description: string;
  /**
   * System-prompt fragment appended to the standard prompt when this
   * role is active. Should describe the role's domain + how it thinks;
   * do NOT include the tool list — that's auto-generated from `tools`.
   */
  readonly promptFragment: string;
  /**
   * Tool allowlist — set of tool names this role may invoke. When
   * `['*']`, no restriction (generalist). Empty-string name is invalid.
   * The dispatcher filters the registry to this set before handing the
   * prompt to the main loop.
   */
  readonly tools: ReadonlyArray<string>;
  /**
   * Keywords / phrases the chair uses as a cheap pre-filter before
   * (optionally) calling a cheap model for final dispatch. Case-
   * insensitive substring match on the goal.
   */
  readonly triggers: ReadonlyArray<string>;
};

// ---------------------------------------------------------------------------
// Built-in roles
//
// Deliberately small set — 5 specialists + 1 fallback. More roles means
// more ambiguity for the chair and worse overall throughput. We can
// grow this list carefully as real usage patterns emerge.
// ---------------------------------------------------------------------------

export const ROLES: Readonly<Record<RoleId, RoleSpec>> = {
  chair: {
    id: 'chair',
    name: 'Chair',
    description: 'Decides which specialist handles the goal.',
    promptFragment: '',
    tools: [],
    triggers: [],
  },

  researcher: {
    id: 'researcher',
    name: 'Researcher',
    description: 'Gathers information — web search, URL fetching, memory lookups.',
    promptFragment: [
      'You are the RESEARCHER specialist.',
      'Your job is to answer factual questions and summarize information.',
      'Prefer web_search → web_fetch_readable to discover sources, then',
      'summarize. Check memory_search for things the user may have already',
      'told SUNNY. You do NOT write files or change system state.',
    ].join('\n'),
    tools: [
      'web_search',
      'web_fetch_readable',
      'memory_add',
      'memory_list',
      'memory_search',
      'fs_list',
      'file_read_text',
      'file_exists',
      'messages_recent',
      'find_text_on_screen',
    ],
    triggers: [
      'search', 'find', 'look up', 'lookup', 'research',
      'what is', "what's", 'who is', 'how does', 'how do',
      'summarize', 'summarise', 'explain', 'read', 'tell me',
    ],
  },

  coder: {
    id: 'coder',
    name: 'Coder',
    description: 'Writes / edits files and runs code. File + PTY tools.',
    promptFragment: [
      'You are the CODER specialist.',
      'Your job is to read, edit, and run code. Prefer file_read_text for',
      'inspection; file_edit for in-place changes over full rewrites;',
      'claude_code_run for multi-step coding tasks. Use pty_agent_* for',
      'interactive CLIs (installers, REPLs). Honor ConfirmGate — do not',
      'rewrite files the user did not ask about.',
    ].join('\n'),
    tools: [
      'file_read_text',
      'file_write',
      'file_append',
      'file_edit',
      'file_delete',
      'file_rename',
      'file_mkdir',
      'file_exists',
      'fs_list',
      'run_shell',
      'claude_code_run',
      'pty_agent_open',
      'pty_agent_send_line',
      'pty_agent_wait_for',
      'pty_agent_read_buffer',
      'pty_agent_clear_buffer',
      'pty_agent_stop',
      'memory_search',
    ],
    triggers: [
      'edit', 'fix', 'refactor', 'implement', 'code', 'function',
      'class', 'bug', 'error', 'compile', 'build', 'test',
      'file', 'cargo', 'pnpm', 'npm', 'typescript', 'rust', 'python',
      'git', 'commit', 'branch', 'merge',
    ],
  },

  operator: {
    id: 'operator',
    name: 'Operator',
    description: 'Drives UI — mouse, keyboard, open apps, screen capture.',
    promptFragment: [
      'You are the OPERATOR specialist.',
      'Your job is to drive the Mac UI on the user\'s behalf — open apps,',
      'click buttons, type text, capture screens. Prefer',
      'click_text_on_screen + find_text_on_screen over raw coordinates.',
      'Always capture the screen first to see what is there before acting.',
      'Do NOT modify files or run shell commands — that is the coder role.',
    ].join('\n'),
    tools: [
      'open_app',
      'open_path',
      'screen_capture_full',
      'screen_capture_region',
      'screen_capture_active_window',
      'mouse_move',
      'mouse_click',
      'mouse_click_at',
      'mouse_scroll',
      'keyboard_type',
      'keyboard_tap',
      'keyboard_combo',
      'cursor_position',
      'screen_size',
      'find_text_on_screen',
      'click_text_on_screen',
    ],
    triggers: [
      'click', 'type', 'press', 'open app', 'launch', 'screenshot',
      'screen', 'capture', 'focus', 'switch to', 'navigate',
      'scroll', 'drag', 'select',
    ],
  },

  scribe: {
    id: 'scribe',
    name: 'Scribe',
    description: 'Persists content — notes, reminders, calendar events, memory.',
    promptFragment: [
      'You are the SCRIBE specialist.',
      'Your job is to persist things the user tells you to remember — save',
      'notes, add reminders, schedule events, commit facts to memory.',
      'Confirm content before writing. Prefer memory_add for free-form',
      'facts, semantic_add for curated subject/text pairs.',
    ].join('\n'),
    tools: [
      'memory_add',
      'memory_list',
      'memory_search',
      'memory_delete',
      'notes_app_list',
      'notes_app_create',
      'notes_app_append',
      'notes_app_search',
      'reminders_list',
      'reminders_create',
      'reminders_complete',
      'calendar_list_events',
      'calendar_create_event',
      'scheduler_list',
      'scheduler_add',
      'messages_recent',
    ],
    triggers: [
      'remember', 'save', 'note', 'notes', 'remind', 'reminder',
      'schedule', 'calendar', 'event', 'log', 'jot', 'store',
    ],
  },

  /** Fallback — unrestricted access. Used when the chair can't confidently
   *  pick a specialist. The main agent loop's normal behaviour. */
  generalist: {
    id: 'generalist',
    name: 'Generalist',
    description: 'Fallback for ambiguous goals — full tool access.',
    promptFragment: [
      'You are SUNNY\'s generalist. No specialist fit the goal clearly, so',
      'you have the full tool registry. Use your judgment.',
    ].join('\n'),
    tools: ['*'],
    triggers: [],
  },
};

/**
 * Heuristic trigger-based matching. Returns role IDs scored by the number
 * of trigger keywords that appear as substrings in the goal (case-
 * insensitive). Ties break by role-definition order in the ROLES object
 * (i.e. researcher first, then coder, etc.). Rows with zero matches are
 * filtered out.
 */
export function scoreRolesByTriggers(goal: string): Array<{ id: RoleId; hits: number }> {
  const lower = goal.toLowerCase();
  const out: Array<{ id: RoleId; hits: number }> = [];
  for (const role of Object.values(ROLES)) {
    if (role.id === 'chair' || role.id === 'generalist') continue;
    let hits = 0;
    for (const t of role.triggers) {
      if (lower.includes(t)) hits += 1;
    }
    if (hits > 0) out.push({ id: role.id, hits });
  }
  out.sort((a, b) => b.hits - a.hits);
  return out;
}

export const __internal = {
  scoreRolesByTriggers,
};
