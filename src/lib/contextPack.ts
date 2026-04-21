/**
 * contextPack — assembles the live runtime context the agent loop prepends
 * to its system prompt on every turn.
 *
 * Sources (all independent, run in parallel):
 *   • `memory_pack(goal)` — curated semantic facts + recent episodic window
 *     + goal-matched episodic hits + top procedural skills + memory stats
 *   • `get_metrics` / `window_focused_app` / `window_active_title` /
 *     `get_processes` / `get_battery` / `get_net` — live system state
 *   • localStorage[sunny.settings.v1] — user prefs (voice, provider, model)
 *
 * Design notes:
 *   - React-free. Safe to call from the agent loop or any worker context.
 *   - Fail-open. Every invoke is routed through `invokeSafe`; missing
 *     backends yield empty fields rather than thrown errors. This keeps
 *     the agent running even when perception / world-model layers (Phase
 *     2) haven't landed yet.
 *   - Abort-aware. Every awaited invoke yields to the event loop so a
 *     fired `signal` can shortcut the remainder cleanly.
 */
import { invokeSafe, isTauri } from './tauri';

// ---------------------------------------------------------------------------
// Public types — match the Rust-side shapes in src-tauri/src/memory/pack.rs
// ---------------------------------------------------------------------------

export type EpisodicKind =
  | 'user'
  | 'agent_step'
  | 'tool_call'
  | 'perception'
  | 'note'
  | 'reflection';

export type EpisodicItem = {
  readonly id: string;
  readonly kind: EpisodicKind;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
  readonly meta: unknown;
  readonly created_at: number;
};

export type SemanticFact = {
  readonly id: string;
  readonly subject: string;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
  readonly confidence: number;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ProceduralSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly trigger_text: string;
  readonly skill_path: string;
  readonly uses_count: number;
  /** Subset of `uses_count` that produced a successful (done) run.
   *  Defaults to 0 for legacy rows; updated by skillExecutor on each run. */
  readonly success_count?: number;
  readonly last_used_at: number | null;
  readonly created_at: number;
  /** Deterministic recipe the System-1 executor runs. Shape validated at
   *  runtime by `skillExecutor.parseRecipe`; typed as `unknown` here so
   *  this module stays free of executor imports. */
  readonly recipe?: unknown;
};

export type MemoryStats = {
  readonly episodic_count: number;
  readonly semantic_count: number;
  readonly procedural_count: number;
  readonly oldest_episodic_secs: number | null;
  readonly newest_episodic_secs: number | null;
};

export type MatchedSkill = {
  readonly skill: ProceduralSkill;
  /** Cosine similarity of goal embedding vs the skill's trigger embedding. */
  readonly score: number;
};

export type Activity =
  | 'unknown'
  | 'coding'
  | 'writing'
  | 'meeting'
  | 'browsing'
  | 'communicating'
  | 'media'
  | 'terminal'
  | 'designing'
  | 'idle';

export type FocusSnapshot = {
  readonly app_name: string;
  readonly bundle_id: string | null;
  readonly window_title: string;
  readonly focused_since_secs: number;
};

export type AppSwitch = {
  readonly from_app: string;
  readonly to_app: string;
  readonly at_secs: number;
};

export type CalendarEventLite = {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly location: string;
  readonly calendar: string;
  readonly all_day: boolean;
};

export type WorldState = {
  readonly schema_version: number;
  readonly timestamp_ms: number;
  readonly local_iso: string;
  readonly host: string;
  readonly os_version: string;
  readonly focus: FocusSnapshot | null;
  readonly focused_duration_secs: number;
  readonly activity: Activity;
  readonly recent_switches: ReadonlyArray<AppSwitch>;
  readonly next_event: CalendarEventLite | null;
  readonly events_today: number;
  readonly mail_unread: number | null;
  readonly cpu_pct: number;
  readonly temp_c: number;
  readonly mem_pct: number;
  readonly battery_pct: number | null;
  readonly battery_charging: boolean | null;
  readonly revision: number;
};

export type MemoryPack = {
  readonly goal: string | null;
  readonly semantic: ReadonlyArray<SemanticFact>;
  readonly recent_episodic: ReadonlyArray<EpisodicItem>;
  readonly matched_episodic: ReadonlyArray<EpisodicItem>;
  readonly skills: ReadonlyArray<ProceduralSkill>;
  readonly matched_skills: ReadonlyArray<MatchedSkill>;
  readonly stats: MemoryStats;
  readonly built_at: number;
  readonly used_embeddings: boolean;
  readonly world: WorldState | null;
};

export type ContextPackProcess = {
  readonly name: string;
  readonly cpu: number;
};

export type ContextPackBattery = {
  readonly percent: number;
  readonly charging: boolean;
};

export type ContextPackNetwork = {
  readonly ssid: string | null;
  readonly public_ip: string | null;
  readonly ping_ms: number | null;
};

export type ContextPackUserPrefs = {
  readonly voice_name: string;
  readonly wake_phrase: string;
  readonly provider: string;
  readonly model: string;
};

export type ContextPack = {
  readonly timestamp: string;
  readonly host: string;
  readonly osVersion: string;
  readonly focusedApp: string | null;
  readonly activeWindowTitle: string | null;
  readonly memory: MemoryPack;
  readonly topProcesses: ReadonlyArray<ContextPackProcess>;
  readonly battery: ContextPackBattery | null;
  readonly network: ContextPackNetwork;
  readonly userPrefs: ContextPackUserPrefs;
};

export type BuildContextPackOptions = {
  /** Free-text goal for the current turn. Used to rank memory hits. */
  readonly goal?: string;
  /** Top-K semantic facts to include (defaults to 8). */
  readonly semanticLimit?: number;
  /** Recent episodic window size (defaults to 20). */
  readonly recentLimit?: number;
  /** Goal-matched episodic top-K (defaults to 8). */
  readonly matchedLimit?: number;
  /** Procedural skills top-K (defaults to 5). */
  readonly skillLimit?: number;
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Internal raw shapes (mirror the Rust side)
// ---------------------------------------------------------------------------

type RawMetrics = { readonly host?: string };
type RawProcess = { readonly name?: string; readonly cpu?: number };
type RawBattery = { readonly percent?: number; readonly charging?: boolean };
type RawNet = { readonly ssid?: string; readonly public_ip?: string; readonly ping_ms?: number };

type PersistedSettings = {
  readonly voiceName?: string;
  readonly wakePhrase?: string;
  readonly provider?: string;
  readonly model?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_STORAGE_KEY = 'sunny.settings.v1';
const TOP_PROCESS_LIMIT = 3;

const DEFAULT_PREFS: ContextPackUserPrefs = {
  voice_name: 'Daniel',
  wake_phrase: 'hey sunny',
  provider: 'openclaw',
  model: 'alfred',
};

const DEFAULT_NETWORK: ContextPackNetwork = {
  ssid: null,
  public_ip: null,
  ping_ms: null,
};

const EMPTY_MEMORY_PACK: MemoryPack = {
  goal: null,
  semantic: [],
  recent_episodic: [],
  matched_episodic: [],
  skills: [],
  matched_skills: [],
  stats: {
    episodic_count: 0,
    semantic_count: 0,
    procedural_count: 0,
    oldest_episodic_secs: null,
    newest_episodic_secs: null,
  },
  built_at: Math.floor(Date.now() / 1000),
  used_embeddings: false,
  world: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abortError(): Error {
  const err = new Error('ContextPack build aborted');
  err.name = 'AbortError';
  return err;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Local-timezone ISO string. `toISOString` always renders UTC which loses
 * the user's offset — the agent reasoning quality degrades when it thinks
 * in a different timezone than the user. So we stitch the offset onto a
 * local-format ISO instead.
 */
function isoWithLocalOffset(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const tz = -now.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  const tzh = pad(Math.floor(abs / 60));
  const tzm = pad(abs % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${tzh}:${tzm}`;
}

function readHostPlatform(): string {
  if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string' && navigator.platform.length > 0) {
    return navigator.platform;
  }
  return 'Mac';
}

function readOsVersion(): string {
  if (typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string') return 'macOS';
  const ua = navigator.userAgent;
  const match = ua.match(/Mac OS X ([0-9_.]+)/);
  if (!match) return 'macOS';
  return `macOS ${match[1].replace(/_/g, '.')}`;
}

function readUserPrefs(): ContextPackUserPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as PersistedSettings | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREFS;
    return {
      voice_name: typeof parsed.voiceName === 'string' ? parsed.voiceName : DEFAULT_PREFS.voice_name,
      wake_phrase: typeof parsed.wakePhrase === 'string' ? parsed.wakePhrase : DEFAULT_PREFS.wake_phrase,
      provider: typeof parsed.provider === 'string' ? parsed.provider : DEFAULT_PREFS.provider,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_PREFS.model,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function normalizeProcesses(rows: ReadonlyArray<RawProcess> | null): ReadonlyArray<ContextPackProcess> {
  if (!rows) return [];
  const out: ContextPackProcess[] = [];
  for (const row of rows) {
    if (!row || typeof row.name !== 'string') continue;
    const cpu = typeof row.cpu === 'number' && Number.isFinite(row.cpu) ? row.cpu : 0;
    out.push({ name: row.name, cpu });
  }
  return out;
}

function normalizeNetwork(raw: RawNet | null): ContextPackNetwork {
  if (!raw) return DEFAULT_NETWORK;
  const ssid = typeof raw.ssid === 'string' && raw.ssid.length > 0 ? raw.ssid : null;
  const ip = typeof raw.public_ip === 'string' && raw.public_ip.length > 0 ? raw.public_ip : null;
  const ping = typeof raw.ping_ms === 'number' && raw.ping_ms > 0 ? raw.ping_ms : null;
  return { ssid, public_ip: ip, ping_ms: ping };
}

function normalizeBattery(raw: RawBattery | null): ContextPackBattery | null {
  if (!raw) return null;
  if (typeof raw.percent !== 'number') return null;
  return { percent: raw.percent, charging: Boolean(raw.charging) };
}

async function fetchMemoryPack(
  opts: BuildContextPackOptions,
): Promise<MemoryPack> {
  if (!isTauri) return EMPTY_MEMORY_PACK;
  const packed = await invokeSafe<MemoryPack>('memory_pack', {
    opts: {
      goal: opts.goal?.trim() ? opts.goal.trim() : undefined,
      semantic_limit: opts.semanticLimit,
      recent_limit: opts.recentLimit,
      matched_limit: opts.matchedLimit,
      skill_limit: opts.skillLimit,
    },
  });
  if (!packed || typeof packed !== 'object') return EMPTY_MEMORY_PACK;
  return {
    goal: typeof packed.goal === 'string' ? packed.goal : null,
    semantic: Array.isArray(packed.semantic) ? packed.semantic : [],
    recent_episodic: Array.isArray(packed.recent_episodic) ? packed.recent_episodic : [],
    matched_episodic: Array.isArray(packed.matched_episodic) ? packed.matched_episodic : [],
    skills: Array.isArray(packed.skills) ? packed.skills : [],
    matched_skills: Array.isArray(packed.matched_skills) ? packed.matched_skills : [],
    stats: packed.stats ?? EMPTY_MEMORY_PACK.stats,
    built_at: typeof packed.built_at === 'number' ? packed.built_at : Math.floor(Date.now() / 1000),
    used_embeddings: Boolean(packed.used_embeddings),
    world: packed.world ?? null,
  };
}

async function fetchHost(signal: AbortSignal | undefined): Promise<string> {
  checkAborted(signal);
  const platform = readHostPlatform();
  if (!isTauri) return platform;
  const metrics = await invokeSafe<RawMetrics>('get_metrics');
  const host = metrics?.host;
  if (typeof host === 'string' && host.length > 0) return `${platform} · ${host}`;
  return platform;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildContextPack(opts: BuildContextPackOptions = {}): Promise<ContextPack> {
  const signal = opts.signal;
  checkAborted(signal);

  // All independent awaits run concurrently. invokeSafe returns null on
  // missing commands; the normalizers collapse nulls into safe defaults.
  const [host, focusedApp, activeWindowTitle, memory, processes, battery, network] = await Promise.all([
    fetchHost(signal),
    isTauri ? invokeSafe<string>('window_focused_app') : Promise.resolve<string | null>(null),
    isTauri ? invokeSafe<string>('window_active_title') : Promise.resolve<string | null>(null),
    fetchMemoryPack(opts),
    isTauri
      ? invokeSafe<ReadonlyArray<RawProcess>>('get_processes', { limit: TOP_PROCESS_LIMIT })
      : Promise.resolve<ReadonlyArray<RawProcess> | null>(null),
    isTauri ? invokeSafe<RawBattery>('get_battery') : Promise.resolve<RawBattery | null>(null),
    isTauri ? invokeSafe<RawNet>('get_net') : Promise.resolve<RawNet | null>(null),
  ]);

  checkAborted(signal);

  return {
    timestamp: isoWithLocalOffset(new Date()),
    host,
    osVersion: readOsVersion(),
    focusedApp: typeof focusedApp === 'string' && focusedApp.length > 0 ? focusedApp : null,
    activeWindowTitle:
      typeof activeWindowTitle === 'string' && activeWindowTitle.length > 0 ? activeWindowTitle : null,
    memory,
    topProcesses: normalizeProcesses(processes),
    battery: normalizeBattery(battery),
    network: normalizeNetwork(network),
    userPrefs: readUserPrefs(),
  };
}

// ---------------------------------------------------------------------------
// Rendering — turns a ContextPack into the system-prompt chunk the agent
// sees at the top of every turn.
// ---------------------------------------------------------------------------

function renderProcesses(rows: ReadonlyArray<ContextPackProcess>): string {
  if (rows.length === 0) return '(none available)';
  return rows.map(r => `${r.name} ${r.cpu.toFixed(1)}%`).join(', ');
}

function renderBattery(b: ContextPackBattery | null): string {
  if (!b) return '(unknown)';
  return `${Math.round(b.percent)}% ${b.charging ? '(charging)' : '(on battery)'}`;
}

function renderNetwork(n: ContextPackNetwork): string {
  const ssid = n.ssid ?? 'unknown SSID';
  const ip = n.public_ip ?? 'unknown IP';
  const ping = n.ping_ms === null ? '—' : `${n.ping_ms}`;
  return `${ssid} · ${ip} · ${ping}ms`;
}

function renderFocus(app: string | null, title: string | null): string {
  const appStr = app ?? 'unknown';
  const titleStr = title ?? '—';
  return `${appStr} · ${titleStr}`;
}

function renderSemantic(rows: ReadonlyArray<SemanticFact>): string {
  if (rows.length === 0) return '  (none)';
  return rows
    .slice(0, 10)
    .map(f => {
      const subj = f.subject ? `[${f.subject}] ` : '';
      const conf = f.confidence < 1.0 ? ` (c=${f.confidence.toFixed(2)})` : '';
      return `  • ${subj}${f.text}${conf}`;
    })
    .join('\n');
}

function renderEpisodic(label: string, rows: ReadonlyArray<EpisodicItem>, max: number): string {
  if (rows.length === 0) return `  (${label} · none)`;
  const lines = rows.slice(0, max).map(e => {
    const when = new Date(e.created_at * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
    const kind = e.kind.toUpperCase().replace('_', ' ');
    // Keep each line compact; truncate very long texts.
    const text = e.text.length > 220 ? `${e.text.slice(0, 217)}…` : e.text;
    return `  ${stamp} · ${kind} · ${text}`;
  });
  return lines.join('\n');
}

function renderSkills(rows: ReadonlyArray<ProceduralSkill>): string {
  if (rows.length === 0) return '  (no learned skills yet)';
  return rows
    .slice(0, 6)
    .map(s => {
      const uses = s.uses_count > 0 ? ` (used ${s.uses_count}×)` : '';
      const trigger = s.trigger_text ? ` — when: ${s.trigger_text}` : '';
      return `  • ${s.name}${uses}: ${s.description}${trigger}`;
    })
    .join('\n');
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.floor(secs))}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h${mm}m`;
}

function minutesUntil(isoLocal: string, nowSecs: number): number | null {
  // isoLocal is "YYYY-MM-DDTHH:MM:SS" in local time (no offset). Parse as
  // local by reconstructing the date in the user's zone.
  const m = isoLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const t =
    new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ).getTime() / 1000;
  return Math.round((t - nowSecs) / 60);
}

function renderNextEvent(evt: CalendarEventLite | null, nowSecs: number): string {
  if (!evt) return '  (no upcoming events in next 24h)';
  const mins = minutesUntil(evt.start, nowSecs);
  const when =
    mins === null
      ? evt.start
      : mins < 60
        ? `in ${mins}m`
        : `in ${Math.round(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ''}`;
  const loc = evt.location ? ` @ ${evt.location}` : '';
  return `  • ${evt.title}${loc} — ${when}`;
}

function renderWorld(w: WorldState | null): string | null {
  if (!w) return null;
  const lines: string[] = [];
  const nowSecs = Math.floor(Date.now() / 1000);

  const focusLine = w.focus
    ? `${w.focus.app_name}${w.focus.window_title ? ` — ${w.focus.window_title}` : ''} (${formatDuration(w.focused_duration_secs)})`
    : 'unknown';
  lines.push(`- Activity: ${w.activity.toUpperCase()} · focused on: ${focusLine}`);

  if (w.recent_switches.length > 0) {
    const recent = w.recent_switches
      .slice(0, 4)
      .map(s => `${s.from_app}→${s.to_app}`)
      .join(', ');
    lines.push(`- Recent switches: ${recent}`);
  }

  if (w.next_event) {
    lines.push('- Next event:');
    lines.push(renderNextEvent(w.next_event, nowSecs));
    if (w.events_today > 1) lines.push(`  (${w.events_today} events today)`);
  }

  if (w.mail_unread !== null && w.mail_unread !== undefined) {
    lines.push(`- Mail unread: ${w.mail_unread}`);
  }

  const batt =
    w.battery_pct === null || w.battery_pct === undefined
      ? null
      : `${Math.round(w.battery_pct)}% ${w.battery_charging ? '(charging)' : '(on battery)'}`;
  const machineBits = [
    `cpu ${w.cpu_pct.toFixed(0)}%`,
    `mem ${w.mem_pct.toFixed(0)}%`,
    batt ? `battery ${batt}` : null,
    w.temp_c > 0 ? `temp ${w.temp_c.toFixed(0)}°C` : null,
  ].filter(Boolean);
  if (machineBits.length > 0) lines.push(`- Machine: ${machineBits.join(' · ')}`);

  return lines.join('\n');
}

/**
 * Render the goal-matched-skills block. Only included when at least one
 * skill scored above a visual threshold (> 0.40 cosine) — below that the
 * match is weak enough that surfacing it in the prompt creates noise. The
 * highest-scoring skill is flagged as "STRONG MATCH" so the agent's prior
 * nudges it to prefer the skill over improvising.
 */
function renderMatchedSkills(rows: ReadonlyArray<MatchedSkill>): string | null {
  const useful = rows.filter(m => m.score > 0.4);
  if (useful.length === 0) return null;
  return useful
    .slice(0, 3)
    .map(m => {
      const tier = m.score > 0.75 ? '★★★ STRONG MATCH' : m.score > 0.55 ? '★★ likely match' : '★ possible match';
      const trigger = m.skill.trigger_text ? ` — when: ${m.skill.trigger_text}` : '';
      return `  [${tier} · score=${m.score.toFixed(2)}] ${m.skill.name}: ${m.skill.description}${trigger}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Budget-aware rendering
//
// Big memory stores (>10k episodic rows, many lessons, many skills) can
// easily blow past an 8K / 32K model context window when all of recent +
// matched + semantic + skills render full-fat. Naïve response would be
// to cap the retrieval counts everywhere — but that throws away signal
// the agent might need.
//
// Instead: render optimistically, measure, and if the result exceeds the
// soft budget, trim the longest-tail sections first (matched_episodic →
// recent_episodic → episodic row bodies → matched_episodic rows entirely)
// until we fit. The trimmed pack flags `budget_trimmed: true` so the
// caller can surface it in an insight.
//
// Token count is a rough 4 chars ≈ 1 token heuristic. Good enough for
// triage; we don't need exact tokenization here, just a budget gate.
// ---------------------------------------------------------------------------

/** Default soft budget in tokens. Picked to comfortably fit the smallest
 *  model we target (Ollama 8K default). Users can override via
 *  `renderSystemPromptWithBudget(..., { maxTokens: N })`. */
export const DEFAULT_PROMPT_BUDGET_TOKENS = 6_000;

/** Floor — we never trim below this number of memory rows no matter how
 *  tight the budget. A prompt with zero memory is worse than a slightly
 *  over-budget one. */
const MIN_SEMANTIC_ROWS = 3;
const MIN_RECENT_ROWS = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Render the system prompt. If the rendered length exceeds `maxTokens`,
 * progressively trim the longest-tailed memory sections until it fits.
 * Returns the rendered prompt string (unchanged public contract) for the
 * existing `renderSystemPrompt` call site. Use `renderSystemPromptWithReport`
 * if you want to observe what was trimmed.
 */
export function renderSystemPrompt(
  pack: ContextPack,
  goal: string,
  opts: { maxTokens?: number } = {},
): string {
  return renderSystemPromptWithReport(pack, goal, opts).prompt;
}

export type RenderReport = {
  readonly prompt: string;
  readonly tokens: number;
  readonly budgetTrimmed: boolean;
  /** One-line reason log, e.g. "dropped matched_episodic[6..], shortened semantic[2]". */
  readonly trimNotes: ReadonlyArray<string>;
};

export function renderSystemPromptWithReport(
  pack: ContextPack,
  goal: string,
  opts: { maxTokens?: number } = {},
): RenderReport {
  const budget = opts.maxTokens ?? DEFAULT_PROMPT_BUDGET_TOKENS;

  // Start with the full pack. If we exceed budget, re-render progressively
  // trimmed copies. Up to 4 trim passes before we call it good.
  const trimNotes: string[] = [];
  let memory = pack.memory;
  let prompt = renderPrompt(pack, memory, goal);
  let tokens = estimateTokens(prompt);

  if (tokens <= budget) {
    return { prompt, tokens, budgetTrimmed: false, trimNotes: [] };
  }

  // Pass 1: drop matched_episodic down to 3 rows (was 8 default).
  if (tokens > budget && memory.matched_episodic.length > 3) {
    const before = memory.matched_episodic.length;
    memory = { ...memory, matched_episodic: memory.matched_episodic.slice(0, 3) };
    prompt = renderPrompt(pack, memory, goal);
    tokens = estimateTokens(prompt);
    trimNotes.push(`matched_episodic ${before}→${memory.matched_episodic.length}`);
  }

  // Pass 2: drop recent_episodic tail toward MIN_RECENT_ROWS.
  if (tokens > budget && memory.recent_episodic.length > MIN_RECENT_ROWS) {
    const before = memory.recent_episodic.length;
    const target = Math.max(MIN_RECENT_ROWS, Math.floor(before / 2));
    memory = { ...memory, recent_episodic: memory.recent_episodic.slice(0, target) };
    prompt = renderPrompt(pack, memory, goal);
    tokens = estimateTokens(prompt);
    trimNotes.push(`recent_episodic ${before}→${memory.recent_episodic.length}`);
  }

  // Pass 3: shorten each semantic fact body to 140 chars.
  if (tokens > budget && memory.semantic.length > 0) {
    const shortened = memory.semantic.map(f =>
      f.text.length > 140 ? { ...f, text: `${f.text.slice(0, 137)}…` } : f,
    );
    const didShorten = shortened.some((f, i) => f.text !== memory.semantic[i].text);
    if (didShorten) {
      memory = { ...memory, semantic: shortened };
      prompt = renderPrompt(pack, memory, goal);
      tokens = estimateTokens(prompt);
      trimNotes.push('semantic-text shortened to 140 chars');
    }
  }

  // Pass 4: last resort — drop matched_episodic entirely and halve semantic.
  if (tokens > budget) {
    const semTarget = Math.max(MIN_SEMANTIC_ROWS, Math.floor(memory.semantic.length / 2));
    memory = {
      ...memory,
      matched_episodic: [],
      semantic: memory.semantic.slice(0, semTarget),
    };
    prompt = renderPrompt(pack, memory, goal);
    tokens = estimateTokens(prompt);
    trimNotes.push(`hard-trim: dropped matched_episodic, semantic→${memory.semantic.length}`);
  }

  return { prompt, tokens, budgetTrimmed: true, trimNotes };
}

/**
 * Pure rendering — takes a (possibly trimmed) memory block and produces
 * the system-prompt string. Extracted from the original renderSystemPrompt
 * so the budget loop can swap the memory block without re-implementing
 * the surrounding chrome.
 */
function renderPrompt(pack: ContextPack, memory: MemoryPack, goal: string): string {
  const matched = renderMatchedSkills(memory.matched_skills);
  const worldBlock = renderWorld(memory.world);
  const retrievalNote = memory.used_embeddings
    ? 'semantic+FTS hybrid retrieval'
    : 'FTS-only retrieval (Ollama embed unavailable)';

  const lines = [
    "You are SUNNY — Sunny's personal assistant HUD running on his Mac.",
    '',
    'CURRENT CONTEXT',
    `- Time: ${pack.timestamp}`,
    `- Host: ${pack.host} · ${pack.osVersion}`,
    // Prefer the world-model's focused app when present — it's refreshed on
    // a 15s tick and reflects classified activity, not just the raw name.
    ...(worldBlock
      ? [worldBlock]
      : [
          `- Focused app: ${renderFocus(pack.focusedApp, pack.activeWindowTitle)}`,
          `- Battery: ${renderBattery(pack.battery)}`,
          `- Top processes: ${renderProcesses(pack.topProcesses)}`,
        ]),
    `- Network: ${renderNetwork(pack.network)}`,
    `- User prefers: voice=${pack.userPrefs.voice_name}, provider=${pack.userPrefs.provider}, model=${pack.userPrefs.model}, wake phrase "${pack.userPrefs.wake_phrase}"`,
    '',
    `MEMORY STATE (episodic=${memory.stats.episodic_count}, semantic=${memory.stats.semantic_count}, procedural=${memory.stats.procedural_count}) · ${retrievalNote}`,
    '',
    ...(matched
      ? [
          'GOAL-MATCHED SKILLS — prefer these over improvising:',
          matched,
          '',
        ]
      : []),
    'KNOWN FACTS (semantic memory; may be partial, trust the user over these):',
    renderSemantic(memory.semantic),
    '',
    'LEARNED SKILLS (procedural memory — prefer these for recurring tasks):',
    renderSkills(memory.skills),
    '',
    ...(memory.matched_episodic.length
      ? [
          'RELATED PAST EVENTS (goal-matched episodic memory):',
          renderEpisodic('matched', memory.matched_episodic, 8),
          '',
        ]
      : []),
    'RECENT EVENTS (chronological episodic window):',
    renderEpisodic('recent', memory.recent_episodic, 12),
    '',
    'CURRENT GOAL',
    goal,
    '',
    'OPERATING RULES',
    '- Prefer reading before writing. Use list/search/fetch tools before taking destructive actions.',
    '- Confirm destructive actions through the UI gate — do not bypass.',
    '- Be concise. Return final answers in plain prose unless structured data was requested.',
    '- If a GOAL-MATCHED SKILL scored STRONG, prefer running it over planning from scratch.',
    '- If uncertain, ask a clarifying question instead of guessing.',
    '- When you learn something durable about the user, save it via the memory_add tool with tag "fact".',
  ];
  return lines.join('\n');
}
