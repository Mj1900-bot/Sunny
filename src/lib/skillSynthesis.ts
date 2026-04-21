/**
 * Skill synthesizer — compiles recurring successful runs into procedural
 * skills automatically.
 *
 * This is the piece that closes the self-improvement loop end-to-end:
 *
 *   user asks X → agent plans with LLM → X succeeds → episodic row with
 *   tool_sequence → same X succeeds N more times → synthesizer spots the
 *   pattern → writes a skill recipe → NEXT X matches System-1 at score
 *   >= 0.85 → LLM bypassed → answer in ~400ms.
 *
 * What "same X" means, concretely:
 *   1. FTS keyword overlap in the episodic-row text (goal + answer) — fast
 *      prefilter on all rows tagged 'run' + 'done' in a rolling 30-day
 *      window.
 *   2. Identical `tool_sequence` array in meta — the names (not inputs) of
 *      the tool calls. Two runs using [calendar_list_events, mail_unread]
 *      count as "the same shape"; runs that interleaved different tools
 *      don't.
 *   3. Cluster size ≥ MIN_CLUSTER_RUNS — we don't synthesize from two
 *      runs alone because a single repeated mistake could masquerade as a
 *      pattern.
 *
 * Recipe compilation (MVP):
 *   • Use the MOST RECENT successful run's tool inputs verbatim.
 *   • Add a final `answer` step with `{{$goal}}` templating so the skill
 *     can handle variant-phrasing of the same intent.
 *   • Skip if a skill already exists whose trigger_text matches.
 *
 * Scheduling:
 *   • Runs every SYNTHESIS_TICK_MS (20 min by default). Offset from the
 *     consolidator's 15-min tick so we don't contend for the chat
 *     provider at the same instant.
 *   • First tick is delayed 2 minutes after boot so first-launch doesn't
 *     do a synthesis pass before any runs have happened.
 *   • Idempotent — calling start twice reuses the same timer.
 */

import { invokeSafe, isTauri } from './tauri';
import { pushInsight } from '../store/insights';

// ---------------------------------------------------------------------------
// Types — mirror the Rust wire shapes we read from invokeSafe
// ---------------------------------------------------------------------------

type EpisodicKind =
  | 'user'
  | 'agent_step'
  | 'tool_call'
  | 'perception'
  | 'note'
  | 'reflection';

type EpisodicItem = {
  readonly id: string;
  readonly kind: EpisodicKind;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
  readonly meta: unknown;
  readonly created_at: number;
};

type ProceduralSkill = {
  readonly id: string;
  readonly name: string;
  readonly recipe?: unknown;
};

type RunMeta = {
  readonly steps?: number;
  readonly tool_sequence?: ReadonlyArray<string>;
  readonly tool_calls?: ReadonlyArray<ToolCallRecord>;
  readonly system?: number | string;
  readonly ts?: number;
};

/**
 * Per-step record captured by the agent loop at run time. `name` must
 * match the corresponding `tool_sequence` entry; `input` is the raw args
 * object that the tool was invoked with on that successful run.
 */
type ToolCallRecord = {
  readonly name: string;
  readonly input?: Record<string, unknown>;
};

type RecipeStep =
  | { readonly kind: 'tool'; readonly tool: string; readonly input: Record<string, unknown> }
  | { readonly kind: 'answer'; readonly text: string };

type CompiledRecipe = {
  readonly steps: ReadonlyArray<RecipeStep>;
  /** Allowlist of tool names the executor may dispatch (sprint-10 δ / κ v9 #3).
   *  Auto-inferred as the unique tool names in `steps`. Serialized with the
   *  recipe so the executor can enforce the scope at run time without any
   *  schema change on the Rust side. */
  readonly capabilities: ReadonlyArray<string>;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Minimum successful-run count to synthesize a skill. */
const MIN_CLUSTER_RUNS = 5;
/** Lookback window (days). Older rows are ignored — stale patterns are noise. */
const LOOKBACK_DAYS = 30;
/** Cap on how many runs we pull per tick. A synthesis pass should be quick. */
const FETCH_LIMIT = 500;
/** How often the synthesizer re-scans. 20 min offset from the 15-min consolidator. */
const SYNTHESIS_TICK_MS = 20 * 60_000;
/** First-tick delay after boot so the first user query doesn't contend. */
const FIRST_DELAY_MS = 2 * 60_000;
/** Cap on skill-name length + input length — keeps synthesized skills sane. */
const MAX_NAME_CHARS = 48;
const MAX_TOOL_SEQ = 8;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

let activeTimer: number | null = null;
let tickInFlight = false;

export function startSkillSynthesizer(): () => void {
  if (!isTauri) return () => undefined;
  if (activeTimer !== null) return stopSkillSynthesizer;

  activeTimer = window.setTimeout(function run() {
    void synthesizeOnce();
    activeTimer = window.setInterval(() => {
      void synthesizeOnce();
    }, SYNTHESIS_TICK_MS);
  }, FIRST_DELAY_MS);

  return stopSkillSynthesizer;
}

export function stopSkillSynthesizer(): void {
  if (activeTimer !== null) {
    window.clearTimeout(activeTimer);
    window.clearInterval(activeTimer);
    activeTimer = null;
  }
}

/** Manual trigger — used by a future "Synthesize now" button. */
export async function synthesizeOnce(): Promise<{ created: number }> {
  if (!isTauri) return { created: 0 };
  if (tickInFlight) return { created: 0 };
  tickInFlight = true;
  try {
    return await runTick();
  } finally {
    tickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

async function runTick(): Promise<{ created: number }> {
  const rows = await fetchRecentSuccessfulRuns();
  if (rows.length < MIN_CLUSTER_RUNS) return { created: 0 };

  const existingSkills =
    (await invokeSafe<ReadonlyArray<ProceduralSkill>>('memory_skill_list')) ?? [];
  const existingNames = new Set(existingSkills.map(s => s.name.toLowerCase()));

  const clusters = clusterBySequence(rows);
  let created = 0;

  for (const cluster of clusters) {
    if (cluster.runs.length < MIN_CLUSTER_RUNS) continue;
    const candidate = compileCandidate(cluster);
    if (!candidate) continue;
    if (existingNames.has(candidate.name.toLowerCase())) continue;

    const ok = await invokeSafe<ProceduralSkill>('memory_skill_add', {
      name: candidate.name,
      description: candidate.description,
      trigger_text: candidate.triggerText,
      recipe: candidate.recipe,
    });
    if (!ok) continue;
    existingNames.add(candidate.name.toLowerCase());
    created += 1;
    pushInsight(
      'skill_synthesized',
      `Learned skill "${candidate.name}"`,
      `Compiled from ${cluster.runs.length} successful runs: ${cluster.sequence.join(' → ')}`,
      {
        name: candidate.name,
        sequence: cluster.sequence,
        runCount: cluster.runs.length,
      },
    );
  }

  return { created };
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

async function fetchRecentSuccessfulRuns(): Promise<ReadonlyArray<EpisodicItem>> {
  // We use `memory_episodic_list` (not _search) because the selection
  // criterion is the `run` + `done` tag set, not a text query. The list is
  // bounded by FETCH_LIMIT and pre-sorted newest-first on the Rust side.
  const listed =
    (await invokeSafe<ReadonlyArray<EpisodicItem>>('memory_episodic_list', {
      limit: FETCH_LIMIT,
      offset: 0,
    })) ?? [];
  const cutoffSecs = Math.floor((Date.now() - LOOKBACK_DAYS * 86400_000) / 1000);
  return listed.filter(
    r =>
      r.kind === 'agent_step' &&
      r.created_at >= cutoffSecs &&
      Array.isArray(r.tags) &&
      r.tags.includes('done') &&
      r.tags.includes('run') &&
      // Don't re-compile skills from System-1 runs (those already used a
      // skill). Only System-2 (LLM loop) runs are candidates for synthesis.
      !r.tags.includes('skill'),
  );
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

type Cluster = {
  readonly sequence: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<EpisodicItem>;
};

/**
 * Group runs by identical tool_sequence. Runs with empty or single-tool
 * sequences are dropped — no value compiling "call web_fetch_readable" as
 * a skill when the user can say exactly that. Sequences longer than
 * MAX_TOOL_SEQ are likely exploratory runs and don't compile cleanly.
 */
export function clusterBySequence(
  rows: ReadonlyArray<EpisodicItem>,
): ReadonlyArray<Cluster> {
  const buckets = new Map<string, EpisodicItem[]>();
  for (const row of rows) {
    const seq = extractToolSequence(row);
    if (seq === null || seq.length < 2 || seq.length > MAX_TOOL_SEQ) continue;
    const key = seq.join('|');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const out: Cluster[] = [];
  for (const [key, runs] of buckets.entries()) {
    out.push({ sequence: key.split('|'), runs });
  }
  // Bigger clusters first — we synthesize the most-confident patterns per tick.
  out.sort((a, b) => b.runs.length - a.runs.length);
  return out;
}

function extractToolSequence(row: EpisodicItem): ReadonlyArray<string> | null {
  const meta = row.meta;
  if (!meta || typeof meta !== 'object') return null;
  const rec = meta as RunMeta;
  if (!Array.isArray(rec.tool_sequence)) return null;
  const seq: string[] = [];
  for (const t of rec.tool_sequence) {
    if (typeof t !== 'string' || t.length === 0) return null;
    seq.push(t);
  }
  return seq;
}

// ---------------------------------------------------------------------------
// Recipe compilation
// ---------------------------------------------------------------------------

type Candidate = {
  readonly name: string;
  readonly description: string;
  readonly triggerText: string;
  readonly recipe: CompiledRecipe;
};

/**
 * Compile a cluster into a skill candidate.
 *
 * Strategy (post κ #1):
 *   - Name & description are derived from the goal lines of the cluster.
 *   - For each tool-position in the sequence we diff the N `input` objects
 *     from the cluster's real runs via `buildInputTemplate`. Keys that
 *     agree across ≥CONSTANT_THRESHOLD of runs become constants; keys
 *     whose values look derived from the goal become `{{$goal}}`; the
 *     remaining keys become `{{$<keyname>}}` placeholders that the
 *     executor must fill from arguments or caller context.
 *   - A final `answer` step echoes `{{$goal}}` so the skill always
 *     completes with a message even when the tool sequence produces
 *     minimal text.
 *
 * This replaces the prior `input: {}` MVP which tripped every tool's
 * input_schema on first execution and instantly fell back to System-2 —
 * i.e. "Learned skill X" surfaced in the HUD but the skill never ran.
 */
function compileCandidate(cluster: Cluster): Candidate | null {
  if (cluster.runs.length === 0) return null;
  // Most-recent run in the cluster gives us the canonical goal phrasing.
  const runs = [...cluster.runs].sort((a, b) => b.created_at - a.created_at);
  const goals = runs.map(extractGoalText).filter((g): g is string => g !== null);
  if (goals.length < MIN_CLUSTER_RUNS) return null;

  const canonicalGoal = goals[0];
  const name = deriveSkillName(canonicalGoal, cluster.sequence);
  const description = `Auto-synthesized from ${cluster.runs.length} successful runs handling: ${canonicalGoal.slice(0, 80)}${canonicalGoal.length > 80 ? '…' : ''}`;
  const triggerText = dedupeTriggerLines(goals).slice(0, 4).join(' · ');

  // Pull the per-run, per-position input objects. Runs where tool_calls
  // is missing/malformed are dropped silently — they can't inform the
  // template anyway, and dropping them is safer than fabricating data.
  // `callMatrix[i]` gives the N successful `input` objects at position i,
  // `goalMatrix[i]` is the parallel array of goal strings from the same
  // runs so goal-derivative detection can match values to their goals.
  const { callMatrix, goalMatrix } = collectCallInputs(runs, cluster.sequence);

  const steps: RecipeStep[] = cluster.sequence.map((toolName, i) => ({
    kind: 'tool' as const,
    tool: toolName,
    input: buildInputTemplate(callMatrix[i], goalMatrix[i]),
  }));

  // Close the recipe with a message step so the agent always produces
  // user-facing output even when the tools themselves return opaque data.
  steps.push({
    kind: 'answer',
    text: `Here's what I found for "{{$goal}}".`,
  });

  // Auto-infer capabilities (sprint-10 δ / κ v9 #3) — the executor will
  // reject any step that tries to dispatch a tool outside this list.
  // Uses cluster.sequence (not `steps`) because that's the source of
  // truth for which tools this recipe runs; it also excludes the
  // trailing `answer` step which has no tool surface.
  const capabilities = inferCapabilities(cluster.sequence);

  return {
    name,
    description,
    triggerText,
    recipe: { steps, capabilities },
  };
}

/**
 * Compute a capability allowlist for a compiled recipe: the set of unique
 * tool names referenced by its tool-kind steps, preserving first-seen
 * order for deterministic serialization. Exported via `__internal` for
 * unit tests.
 */
function inferCapabilities(
  sequence: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of sequence) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * For each tool-position in `sequence`, return the list of per-run `input`
 * objects AND the parallel list of goals from those same runs. Runs
 * missing `tool_calls` or where the call name doesn't match the expected
 * sequence entry contribute nothing at that position — we'd rather have
 * a shorter matrix than a corrupted one. The per-position parity between
 * `callMatrix[i][k]` and `goalMatrix[i][k]` is what lets the downstream
 * goal-derivation check match a value to the goal that produced it.
 */
function collectCallInputs(
  runs: ReadonlyArray<EpisodicItem>,
  sequence: ReadonlyArray<string>,
): {
  readonly callMatrix: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
  readonly goalMatrix: ReadonlyArray<ReadonlyArray<string>>;
} {
  const callMatrix: Record<string, unknown>[][] = sequence.map(() => []);
  const goalMatrix: string[][] = sequence.map(() => []);
  for (const run of runs) {
    const calls = extractToolCalls(run);
    if (calls === null) continue;
    const goal = extractGoalText(run) ?? '';
    for (let i = 0; i < sequence.length; i += 1) {
      const call = calls[i];
      if (!call) continue;
      if (call.name !== sequence[i]) continue;
      if (!call.input || typeof call.input !== 'object') continue;
      callMatrix[i].push(call.input);
      goalMatrix[i].push(goal);
    }
  }
  return { callMatrix, goalMatrix };
}

function extractToolCalls(
  row: EpisodicItem,
): ReadonlyArray<ToolCallRecord> | null {
  const meta = row.meta;
  if (!meta || typeof meta !== 'object') return null;
  const rec = meta as RunMeta;
  if (!Array.isArray(rec.tool_calls)) return null;
  const out: ToolCallRecord[] = [];
  for (const c of rec.tool_calls) {
    if (!c || typeof c !== 'object') return null;
    const name = (c as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) return null;
    const input = (c as { input?: unknown }).input;
    if (input !== undefined && (typeof input !== 'object' || input === null)) {
      return null;
    }
    out.push({
      name,
      input: (input as Record<string, unknown>) ?? undefined,
    });
  }
  return out;
}

/** ≥80% agreement → constant. Strict-gt so 4/5 qualifies, 3/5 does not. */
const CONSTANT_THRESHOLD = 0.8;

/**
 * Diff the per-run input objects at one tool-position and synthesize a
 * template. The three buckets:
 *
 *   1. Majority agreement (≥CONSTANT_THRESHOLD of runs share a single
 *      value): lift that value into the template verbatim.
 *   2. Varies with goal: every run's value is a substring / derivative of
 *      that run's goal text → template as `{{$goal}}` so the skill maps
 *      fresh goal phrasings through the same slot.
 *   3. Varies arbitrarily: template as `{{$<keyname>}}` — the executor is
 *      expected to fill this from explicit arguments, otherwise System-1
 *      will score low and System-2 will take over cleanly.
 *
 * Type-safety guard: placeholders are strings. If the majority value is
 * non-string AND we'd otherwise have emitted a placeholder, we instead
 * keep the first cluster value so we don't hand the tool a string where
 * its input_schema wants a number / boolean / object (constraint #3 from
 * the sprint-4 brief).
 */
function buildInputTemplate(
  inputs: ReadonlyArray<Record<string, unknown>>,
  goals: ReadonlyArray<string>,
): Record<string, unknown> {
  if (inputs.length === 0) return {};
  const firstInput = inputs[0];
  const n = inputs.length;
  const minConstant = Math.ceil(n * CONSTANT_THRESHOLD);
  const keys = collectAllKeys(inputs);
  // Accumulate onto a fresh object rather than mutating any input — the
  // coding-style charter calls for immutable construction.
  const template: Record<string, unknown> = {};
  for (const key of keys) {
    const values = inputs.map(i => i[key]);
    // Phase 1: majority agreement.
    const majority = findMajorityValue(values, minConstant);
    if (majority.found) {
      template[key] = majority.value;
      continue;
    }
    // Phase 2: goal-derived. Only considered when every run for this key
    // has a string value AND the matching goal contains that string
    // (case-insensitive, trimmed). We require ALL runs to satisfy this;
    // a single counter-example falls through to arbitrary.
    if (allValuesDerivedFromGoal(values, goals)) {
      template[key] = '{{$goal}}';
      continue;
    }
    // Phase 3: arbitrary variation. Emit a keyname placeholder unless the
    // target slot is non-string typed (schema hazard), in which case we
    // fall back to the first cluster value — better a stale default than
    // a guaranteed schema-reject.
    const firstVal = firstInput[key];
    if (typeof firstVal === 'string') {
      template[key] = `{{$${key}}}`;
    } else {
      template[key] = firstVal;
    }
  }
  return template;
}

function collectAllKeys(
  inputs: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<string> {
  // Preserve first-seen order so templates are stable across ticks.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const obj of inputs) {
    for (const k of Object.keys(obj)) {
      if (seen.has(k)) continue;
      seen.add(k);
      order.push(k);
    }
  }
  return order;
}

function findMajorityValue(
  values: ReadonlyArray<unknown>,
  minCount: number,
): { found: true; value: unknown } | { found: false } {
  // Small N (≤ cluster size, typically 5-20) — a linear double-loop with
  // structural equality is simpler and cheaper than hashing JSON.
  for (let i = 0; i < values.length; i += 1) {
    let count = 0;
    for (let j = 0; j < values.length; j += 1) {
      if (valuesEqual(values[i], values[j])) count += 1;
    }
    if (count >= minCount) return { found: true, value: values[i] };
  }
  return { found: false };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  // JSON-equality is sufficient for the shapes we see in tool inputs
  // (plain POJOs / arrays / primitives). Loses key-order distinction,
  // which is the correct behavior here.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function allValuesDerivedFromGoal(
  values: ReadonlyArray<unknown>,
  goals: ReadonlyArray<string>,
): boolean {
  if (values.length === 0) return false;
  if (values.length !== goals.length) return false;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    const g = goals[i];
    if (typeof v !== 'string' || typeof g !== 'string') return false;
    if (v.length === 0) return false;
    if (!g.toLowerCase().includes(v.toLowerCase().trim())) return false;
  }
  return true;
}

function extractGoalText(row: EpisodicItem): string | null {
  // agent_step rows are stored as `goal: <g>\nanswer: <a>`. Extract the g.
  const lines = row.text.split('\n');
  const line = lines.find(l => l.startsWith('goal:'));
  if (!line) return null;
  const g = line.slice(5).trim();
  return g.length > 0 ? g : null;
}

function dedupeTriggerLines(lines: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const key = l.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Turn a free-text goal + a tool sequence into a stable skill name. We
 * favor the goal's first few distinctive words and fall back to the tool
 * names when the goal is empty / too generic. The trailing `-skN` suffix
 * keeps names unique when two goal phrasings compile into different skills.
 */
export function deriveSkillName(goal: string, sequence: ReadonlyArray<string>): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !COMMON_STOP.has(w))
    .slice(0, 4);
  let base = words.length >= 2 ? words.join('-') : sequence.slice(0, 2).join('-');
  if (!base) base = 'auto-skill';
  if (base.length > MAX_NAME_CHARS) base = base.slice(0, MAX_NAME_CHARS);
  // Deterministic short hash of the tool sequence so the same sequence
  // produces the same suffix — a second synthesis attempt for a slightly
  // different goal phrasing won't collide with the first skill.
  const suffix = shortHash(sequence.join('|'));
  return `${base}-${suffix}`;
}

const COMMON_STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'what',
  'how',
  'can',
  'you',
  'please',
  'help',
  'show',
  'tell',
  'make',
  'give',
  'get',
  'find',
  'about',
  'some',
  'any',
]);

function shortHash(s: string): string {
  // FNV-1a 32-bit. Widened to the full 8 hex chars (from the prior
  // 4-char / 16-bit slice) so birthday collisions across the skill
  // namespace stay negligible: with 2^16 = 65,536 buckets a user with
  // ~300 skills already has a ~50% chance of collision (birthday bound);
  // with 2^32 buckets that probability drops to ~10^-5 at the same
  // cardinality, which is comfortably below "users will ever see it".
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
  }
  // Pad to 8 chars so name-length is stable regardless of magnitude.
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __internal = {
  clusterBySequence,
  extractToolSequence,
  deriveSkillName,
  shortHash,
  compileCandidate,
  buildInputTemplate,
  collectCallInputs,
  extractToolCalls,
  inferCapabilities,
  MIN_CLUSTER_RUNS,
  CONSTANT_THRESHOLD,
};
