// SUNNY learning module — Agent 9/10.
//
// SUNNY gets smarter over time by mining the rolling history of terminal agent
// runs (see store/agentHistory.ts) and distilling them into a handful of
// structured `LearnedPattern`s. New patterns are committed to the same
// `memory_store` used by memoryWriter.ts so the main assistant loop picks them
// up automatically on the next context pack.
//
// The module is pure side-effect free in its extraction core: everything below
// `extractPatternsFromHistory` is a pure function of the current history +
// `now()`. Only commitLearnings / startLearningLoop mutate state (localStorage +
// invokeSafe('memory_add')). That separation keeps the extractors unit-testable
// without needing Tauri or a DOM.

import { useAgentHistory } from '../store/agentHistory';
import type { HistoryRun, HistoryStep } from '../store/agentHistory';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LearnedPatternKind =
  | 'preference'
  | 'frequent_goal'
  | 'tool_bias'
  | 'common_failure';

export type LearnedPattern = {
  readonly id: string;
  readonly kind: LearnedPatternKind;
  readonly text: string;
  readonly weight: number;
  readonly supporting_runs: ReadonlyArray<string>;
  readonly extracted_at: number;
};

// ---------------------------------------------------------------------------
// Module-local clock — swappable for tests.
// ---------------------------------------------------------------------------

let _now: () => number = () => Date.now();

/** Test-only: override the clock used by time-based comparisons. */
export function __setNowForTests(fn: () => number): void {
  _now = fn;
}

/** Test-only: restore the default clock. */
export function __resetNowForTests(): void {
  _now = () => Date.now();
}

function now(): number {
  return _now();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMITTED_KEY = 'sunny.learning.committed_patterns.v1';
const FREQUENT_GOAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FREQUENT_GOAL_MIN_RUNS = 3;
const TOOL_BIAS_MIN_SHARE = 0.5;
const FAILURE_MIN_OCCURRENCES = 2;
const DEFAULT_LOOP_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractPatternsFromHistory(): LearnedPattern[] {
  const runs = useAgentHistory.getState().runs;
  return extractFromRuns(runs, now());
}

/** Run pattern extraction and commit new ones as memories in memory_store.
 *  Dedupes against already-committed patterns. Idempotent. */
export async function commitLearnings(): Promise<{
  committed: number;
  skipped: number;
}> {
  const patterns = extractPatternsFromHistory();
  const committed = loadCommittedHashes();
  const committedSet = new Set<number>(committed);

  let committedCount = 0;
  let skippedCount = 0;
  const newHashes: number[] = [];

  for (const pattern of patterns) {
    const hash = hashPattern(pattern);
    if (committedSet.has(hash)) {
      skippedCount += 1;
      continue;
    }

    try {
      await invokeSafe('memory_add', {
        text: pattern.text,
        tags: ['sunny-learned', pattern.kind],
      });
      committedSet.add(hash);
      newHashes.push(hash);
      committedCount += 1;
    } catch (error) {
      // invokeSafe shouldn't throw — it swallows — but belt-and-suspenders.
      console.error('commitLearnings: memory_add failed', error);
    }
  }

  if (newHashes.length > 0) {
    persistCommittedHashes([...committed, ...newHashes]);
  }

  return { committed: committedCount, skipped: skippedCount };
}

/** Periodically run commitLearnings while the app is open.
 *  Returns an unsubscribe fn that stops the loop. */
export function startLearningLoop(
  intervalMs: number = DEFAULT_LOOP_INTERVAL_MS,
): () => void {
  // Fire once immediately so first-session users get learning without waiting
  // a full tick. Errors are logged but never propagate.
  void commitLearnings().catch(error => {
    console.error('learning loop: initial commit failed', error);
  });

  const handle = setInterval(() => {
    void commitLearnings().catch(error => {
      console.error('learning loop: periodic commit failed', error);
    });
  }, intervalMs);

  return (): void => {
    clearInterval(handle);
  };
}

// ---------------------------------------------------------------------------
// Pure extractors — exported via the single entry point above, but the
// helpers here are written to be trivially testable with a synthetic runs[].
// ---------------------------------------------------------------------------

function extractFromRuns(
  runs: ReadonlyArray<HistoryRun>,
  atTime: number,
): LearnedPattern[] {
  const patterns: LearnedPattern[] = [];
  patterns.push(...extractFrequentGoals(runs, atTime));
  patterns.push(...extractToolBiases(runs, atTime));
  patterns.push(...extractPreferences(runs, atTime));
  patterns.push(...extractCommonFailures(runs, atTime));
  return patterns;
}

// --- 1. frequent_goal --------------------------------------------------------

type GoalCluster = {
  readonly canonical: string;
  readonly runIds: ReadonlyArray<string>;
};

function extractFrequentGoals(
  runs: ReadonlyArray<HistoryRun>,
  atTime: number,
): LearnedPattern[] {
  const clusters = clusterRunsByGoal(runs, atTime);
  const out: LearnedPattern[] = [];
  for (const cluster of clusters) {
    if (cluster.runIds.length < FREQUENT_GOAL_MIN_RUNS) continue;
    const text = `User frequently asks: "${cluster.canonical}" (n=${cluster.runIds.length})`;
    out.push({
      id: `freq:${cluster.canonical}`,
      kind: 'frequent_goal',
      text,
      weight: confidenceFromCount(cluster.runIds.length),
      supporting_runs: cluster.runIds,
      extracted_at: atTime,
    });
  }
  return out;
}

function clusterRunsByGoal(
  runs: ReadonlyArray<HistoryRun>,
  atTime: number,
): ReadonlyArray<GoalCluster> {
  const windowStart = atTime - FREQUENT_GOAL_WINDOW_MS;
  const buckets = new Map<string, string[]>();
  for (const run of runs) {
    if (run.endedAt < windowStart) continue;
    const canonical = normalizeGoal(run.goal);
    if (canonical.length === 0) continue;
    const existing = buckets.get(canonical);
    if (existing) {
      existing.push(run.id);
    } else {
      buckets.set(canonical, [run.id]);
    }
  }
  const out: GoalCluster[] = [];
  for (const [canonical, runIds] of buckets) {
    out.push({ canonical, runIds });
  }
  return out;
}

/** Lowercase, strip punctuation, collapse whitespace. Conservative: keeps word
 *  characters, digits, and intra-word hyphens so e.g. "govgrants" and
 *  "gov-grants" cluster separately (they mean different things to the user). */
function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- 2. tool_bias ------------------------------------------------------------

function extractToolBiases(
  runs: ReadonlyArray<HistoryRun>,
  atTime: number,
): LearnedPattern[] {
  const clusters = clusterRunsByGoal(runs, atTime);
  const runById = new Map<string, HistoryRun>();
  for (const run of runs) runById.set(run.id, run);

  const out: LearnedPattern[] = [];
  for (const cluster of clusters) {
    if (cluster.runIds.length < FREQUENT_GOAL_MIN_RUNS) continue;

    const successfulRuns = cluster.runIds
      .map(id => runById.get(id))
      .filter((r): r is HistoryRun => r !== undefined && r.status === 'done');

    if (successfulRuns.length === 0) continue;

    const { tool, share, totalSteps } = dominantTool(successfulRuns);
    if (!tool) continue;
    if (share < TOOL_BIAS_MIN_SHARE) continue;

    const text = `For "${cluster.canonical}", the winning approach uses ${tool} (${successfulRuns.length}/${cluster.runIds.length} successful runs)`;
    out.push({
      id: `bias:${cluster.canonical}:${tool}`,
      kind: 'tool_bias',
      text,
      weight: clamp01(share),
      supporting_runs: successfulRuns.map(r => r.id),
      extracted_at: atTime,
    });

    // totalSteps is informational for callers inspecting raw patterns; log
    // nothing here — keep extraction silent.
    void totalSteps;
  }
  return out;
}

function dominantTool(runs: ReadonlyArray<HistoryRun>): {
  tool: string | null;
  share: number;
  totalSteps: number;
} {
  const counts = new Map<string, number>();
  let total = 0;
  for (const run of runs) {
    for (const step of run.steps) {
      const name = toolNameOf(step);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) return { tool: null, share: 0, totalSteps: 0 };

  let bestTool: string | null = null;
  let bestCount = 0;
  for (const [tool, count] of counts) {
    if (count > bestCount) {
      bestTool = tool;
      bestCount = count;
    }
  }
  return {
    tool: bestTool,
    share: bestCount / total,
    totalSteps: total,
  };
}

function toolNameOf(step: HistoryStep): string | null {
  // Only count tool_call frames; tool_result echoes the same name and would
  // double the count for every invocation.
  if (step.kind !== 'tool_call') return null;
  return step.toolName ?? null;
}

// --- 3. preference -----------------------------------------------------------

const PREFERENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /always\s+(?:use|do|skip)\s+[^.!?\n]+/gi,
  /i\s+prefer\s+[^.!?\n]+/gi,
  /don'?t\s+(?:show|run|enable)\s+[^.!?\n]+/gi,
];

function extractPreferences(
  runs: ReadonlyArray<HistoryRun>,
  atTime: number,
): LearnedPattern[] {
  const bySnippet = new Map<string, string[]>();
  for (const run of runs) {
    const answer = run.finalAnswer ?? '';
    if (answer.length === 0) continue;
    for (const re of PREFERENCE_PATTERNS) {
      re.lastIndex = 0; // /g regexes are stateful — reset each scan.
      for (const match of answer.matchAll(re)) {
        const snippet = normalizeSnippet(match[0]);
        if (snippet.length === 0) continue;
        const existing = bySnippet.get(snippet);
        if (existing) {
          if (!existing.includes(run.id)) existing.push(run.id);
        } else {
          bySnippet.set(snippet, [run.id]);
        }
      }
    }
  }

  const out: LearnedPattern[] = [];
  for (const [snippet, runIds] of bySnippet) {
    out.push({
      id: `pref:${snippet}`,
      kind: 'preference',
      text: `User preference: ${snippet}`,
      weight: confidenceFromCount(runIds.length),
      supporting_runs: runIds,
      extracted_at: atTime,
    });
  }
  return out;
}

function normalizeSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- 4. common_failure -------------------------------------------------------

function extractCommonFailures(
  runs: ReadonlyArray<HistoryRun>,
  atTime: number,
): LearnedPattern[] {
  const counts = new Map<string, { runIds: string[]; workaround: string | null }>();
  for (const run of runs) {
    for (const step of run.steps) {
      const errorText = errorTextFromStep(step);
      if (!errorText) continue;
      const key = normalizeErrorText(errorText);
      if (key.length === 0) continue;
      const bucket = counts.get(key);
      if (bucket) {
        if (!bucket.runIds.includes(run.id)) bucket.runIds.push(run.id);
      } else {
        counts.set(key, { runIds: [run.id], workaround: null });
      }
    }
  }

  const out: LearnedPattern[] = [];
  for (const [key, { runIds, workaround }] of counts) {
    if (runIds.length < FAILURE_MIN_OCCURRENCES) continue;
    const workaroundText = workaround ?? 'null';
    out.push({
      id: `fail:${key}`,
      kind: 'common_failure',
      text: `Recurring error: ${key}. Consider the workaround: ${workaroundText}`,
      weight: confidenceFromCount(runIds.length),
      supporting_runs: runIds,
      extracted_at: atTime,
    });
  }
  return out;
}

function errorTextFromStep(step: HistoryStep): string | null {
  // HistoryStep doesn't have a dedicated error field — error frames surface
  // via the `kind` discriminator and their textual payload. Treat any step
  // whose kind contains "error" (error, tool_error, etc) as a failure source.
  const isError =
    step.kind === 'error' ||
    step.kind === 'tool_error' ||
    step.kind.includes('error');
  if (!isError) return null;
  const text = step.text?.trim() ?? '';
  return text.length > 0 ? text : null;
}

function normalizeErrorText(raw: string): string {
  // Collapse whitespace and truncate so line-number / pointer noise doesn't
  // fragment clusters of the "same" error. 160 chars is enough to disambiguate
  // most real-world error surfaces.
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? collapsed.slice(0, 160) : collapsed;
}

// ---------------------------------------------------------------------------
// Dedup / persistence
// ---------------------------------------------------------------------------

function loadCommittedHashes(): number[] {
  try {
    const raw = localStorage.getItem(COMMITTED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number');
  } catch (error) {
    console.error('learning: failed to load committed hashes', error);
    return [];
  }
}

function persistCommittedHashes(hashes: ReadonlyArray<number>): void {
  try {
    // Cap the list so a pathological run-away doesn't blow localStorage.
    const capped = hashes.slice(-2000);
    localStorage.setItem(COMMITTED_KEY, JSON.stringify(capped));
  } catch (error) {
    console.error('learning: failed to persist committed hashes', error);
  }
}

function hashPattern(pattern: LearnedPattern): number {
  return djb2(`${pattern.kind}|${pattern.text}`.toLowerCase());
}

function djb2(s: string): number {
  // Classic djb2 — same as memoryWriter.ts; inlined to keep this module
  // dep-free from other lib/* files.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Map a raw support count to a 0..1 confidence. Asymptotic curve so a
 *  single extra run matters a lot at n=3 and less at n=30. */
function confidenceFromCount(count: number): number {
  if (count <= 0) return 0;
  return clamp01(1 - 1 / (1 + count / 3));
}

// ---------------------------------------------------------------------------
// Inline smoke tests — invoked manually via `runLearningSelfTest()` in the
// devtools console. Guarded so they never run as side-effects at import time.
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<HistoryRun>): HistoryRun {
  return {
    id: overrides.id ?? `r_${Math.random().toString(36).slice(2, 9)}`,
    goal: overrides.goal ?? 'test goal',
    status: overrides.status ?? 'done',
    finalAnswer: overrides.finalAnswer ?? '',
    startedAt: overrides.startedAt ?? 0,
    endedAt: overrides.endedAt ?? 0,
    steps: overrides.steps ?? [],
  };
}

/** Test-only: run the three smoke assertions. Returns a pass/fail report. */
export function runLearningSelfTest(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;

  // Test 1: frequent_goal triggers at n>=3 inside the 30d window.
  try {
    const t = 1_000_000_000_000;
    const runs: HistoryRun[] = [
      makeRun({ id: 'a', goal: 'Summarize my email!', endedAt: t - 1 }),
      makeRun({ id: 'b', goal: 'summarize my email', endedAt: t - 2 }),
      makeRun({ id: 'c', goal: 'Summarize  my   email.', endedAt: t - 3 }),
      makeRun({ id: 'd', goal: 'something else', endedAt: t - 4 }),
    ];
    const patterns = extractFromRuns(runs, t);
    const freq = patterns.filter(p => p.kind === 'frequent_goal');
    if (freq.length !== 1) throw new Error(`expected 1 frequent_goal, got ${freq.length}`);
    if (freq[0].supporting_runs.length !== 3)
      throw new Error(`expected 3 supporting runs, got ${freq[0].supporting_runs.length}`);
    passed += 1;
  } catch (error) {
    errors.push(`test1 frequent_goal: ${(error as Error).message}`);
  }

  // Test 2: tool_bias picks the >=50% tool across successful runs.
  try {
    const t = 2_000_000_000_000;
    const step = (toolName: string): HistoryStep => ({
      kind: 'tool_call',
      text: '',
      toolName,
      at: 0,
    });
    const runs: HistoryRun[] = [
      makeRun({
        id: 'a',
        goal: 'do the thing',
        endedAt: t - 1,
        status: 'done',
        steps: [step('grep'), step('grep'), step('read')],
      }),
      makeRun({
        id: 'b',
        goal: 'do the thing',
        endedAt: t - 2,
        status: 'done',
        steps: [step('grep'), step('grep')],
      }),
      makeRun({
        id: 'c',
        goal: 'do the thing',
        endedAt: t - 3,
        status: 'done',
        steps: [step('grep'), step('edit')],
      }),
    ];
    const patterns = extractFromRuns(runs, t);
    const bias = patterns.filter(p => p.kind === 'tool_bias');
    if (bias.length !== 1) throw new Error(`expected 1 tool_bias, got ${bias.length}`);
    if (!bias[0].text.includes('grep'))
      throw new Error(`expected grep winner, got: ${bias[0].text}`);
    passed += 1;
  } catch (error) {
    errors.push(`test2 tool_bias: ${(error as Error).message}`);
  }

  // Test 3: preference regex matches "I prefer ..." and "always use ...".
  try {
    const t = 3_000_000_000_000;
    const runs: HistoryRun[] = [
      makeRun({
        id: 'a',
        finalAnswer: 'Done. I prefer dark mode for dashboards.',
        endedAt: t - 1,
      }),
      makeRun({
        id: 'b',
        finalAnswer: 'Always use pnpm for this repo.',
        endedAt: t - 2,
      }),
    ];
    const patterns = extractFromRuns(runs, t);
    const prefs = patterns.filter(p => p.kind === 'preference');
    if (prefs.length < 2)
      throw new Error(`expected >=2 preference patterns, got ${prefs.length}`);
    const joined = prefs.map(p => p.text).join('\n').toLowerCase();
    if (!joined.includes('dark mode') || !joined.includes('pnpm'))
      throw new Error(`missing expected snippets in: ${joined}`);
    passed += 1;
  } catch (error) {
    errors.push(`test3 preference: ${(error as Error).message}`);
  }

  return { passed, failed: errors.length, errors };
}
