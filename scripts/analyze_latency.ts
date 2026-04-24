#!/usr/bin/env node --experimental-strip-types --no-warnings=ExperimentalWarning
/**
 * analyze_latency.ts — offline analyzer for Sunny's latency harness output.
 *
 * Reads the JSONL stream the harness writes to `~/.sunny/latency/runs.jsonl`
 * and the fixture index at `docs/fixtures/latency/index.json`, then prints:
 *   1. Per-category p50/p95/p99 table (green/red vs SLA budget)
 *   2. ASCII histograms per stage (prep_context, first_token, full_response)
 *   3. Top 10 slowest runs with the violating budget highlighted
 *   4. Optional regression diff vs a --baseline JSONL (flagged at >=10%)
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/analyze_latency.ts <runs.jsonl> [--baseline <other.jsonl>] [--json]
 *
 * Exit codes:
 *   0 — every category within SLA and (if baseline given) no regressions
 *   1 — one or more categories red against SLA
 *   2 — regression detected vs baseline (overrides exit 0; stacks with 1)
 *
 * Design: stdlib only, plain Math ops, no stats lib, no network, no deps.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const DEFAULT_JSONL = join(homedir(), '.sunny', 'latency', 'runs.jsonl');
const DEFAULT_INDEX = join(REPO_ROOT, 'docs', 'fixtures', 'latency', 'index.json');
const REGRESSION_THRESHOLD = 0.10; // 10%

// Stages we aggregate & compare against SLA. Order matters for table rendering.
const STAGES = ['prep_context', 'first_token', 'full_response'] as const;
type Stage = typeof STAGES[number];

// --- Types -----------------------------------------------------------------

type JsonlRecord = {
  ts_ms: number;
  run_id: string;
  fixture: string;        // fixture id, matches index.json entry
  stage: string;          // turn_start | prep_context_end | first_token | full_response_end | tool_dispatch_*
  extra?: Record<string, unknown>;
};

type FixtureIndexEntry = {
  id: string;
  category: string;
  sha256?: string;
  sla_budget_ms?: Partial<Record<Stage, number>>;
};

type FixtureIndex = {
  entries: FixtureIndexEntry[];
  byId: Map<string, FixtureIndexEntry>;
};

type Run = {
  runId: string;
  fixtureId: string;
  category: string;
  budget: Partial<Record<Stage, number>>;
  stageMs: Partial<Record<Stage, number>>;
};

type StageStats = {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  samples: number[];
};

type CategoryReport = {
  category: string;
  count: number;
  stages: Partial<Record<Stage, StageStats>>;
  budgets: Partial<Record<Stage, number>>;
  red: boolean;
};

// --- Argv parsing ----------------------------------------------------------

type Args = {
  jsonlPath: string;
  indexPath: string;
  baselinePath: string | null;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    jsonlPath: DEFAULT_JSONL,
    indexPath: DEFAULT_INDEX,
    baselinePath: null,
    json: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') {
      const v = argv[++i];
      if (!v) throw new Error('--baseline requires a path argument');
      out.baselinePath = resolve(v);
    } else if (a === '--index') {
      const v = argv[++i];
      if (!v) throw new Error('--index requires a path argument');
      out.indexPath = resolve(v);
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(helpText());
      process.exit(0);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional[0]) out.jsonlPath = resolve(positional[0]);
  return out;
}

function helpText(): string {
  return [
    'Usage: analyze_latency.ts <runs.jsonl> [--baseline <path>] [--json] [--index <path>]',
    '',
    `  runs.jsonl       default: ${DEFAULT_JSONL}`,
    `  --index <path>   default: ${DEFAULT_INDEX}`,
    '  --baseline <p>   compare vs prior run, flag >=10% regressions',
    '  --json           emit machine-readable summary (for regression-gate)',
    '',
    'Exit codes: 0 all green; 1 any red vs SLA; 2 regression vs baseline',
    '',
  ].join('\n');
}

// --- Loaders ---------------------------------------------------------------

function loadIndex(path: string): FixtureIndex {
  if (!existsSync(path)) {
    // Running before the fixture synthesizer has committed anything — degrade
    // gracefully: every fixture treated as "unknown" category with no budget.
    return { entries: [], byId: new Map() };
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const entries: FixtureIndexEntry[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.entries)
      ? parsed.entries
      : Array.isArray(parsed.fixtures)
        ? parsed.fixtures
        : [];
  const byId = new Map<string, FixtureIndexEntry>();
  for (const e of entries) byId.set(e.id, e);
  return { entries, byId };
}

function loadJsonl(path: string): JsonlRecord[] {
  if (!existsSync(path)) {
    throw new Error(`runs file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const out: JsonlRecord[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s) as JsonlRecord;
      if (typeof rec.ts_ms === 'number' && typeof rec.run_id === 'string' && typeof rec.stage === 'string') {
        out.push(rec);
      }
    } catch {
      // Silently skip malformed lines — the harness may be appending live.
    }
  }
  return out;
}

// --- Reducers --------------------------------------------------------------

/**
 * Walk JSONL records grouped by run_id, compute stage-end timings relative to
 * `turn_start`. The harness emits stage markers, not durations — we derive.
 */
function buildRuns(records: JsonlRecord[], idx: FixtureIndex): Run[] {
  const groups = new Map<string, JsonlRecord[]>();
  for (const r of records) {
    let arr = groups.get(r.run_id);
    if (!arr) { arr = []; groups.set(r.run_id, arr); }
    arr.push(r);
  }
  const runs: Run[] = [];
  for (const [runId, recs] of groups) {
    recs.sort((a, b) => a.ts_ms - b.ts_ms);
    const start = recs.find(r => r.stage === 'turn_start');
    if (!start) continue; // skip partial runs
    const fixtureId = start.fixture ?? recs[0].fixture ?? 'unknown';
    const entry = idx.byId.get(fixtureId);
    const category = entry?.category ?? 'uncategorised';
    const budget = entry?.sla_budget_ms ?? {};
    const stageMs: Partial<Record<Stage, number>> = {};
    const prepEnd = recs.find(r => r.stage === 'prep_context_end');
    const firstTok = recs.find(r => r.stage === 'first_token');
    const fullEnd = recs.find(r => r.stage === 'full_response_end' || r.stage === 'turn_end');
    if (prepEnd) stageMs.prep_context = prepEnd.ts_ms - start.ts_ms;
    if (firstTok) stageMs.first_token = firstTok.ts_ms - start.ts_ms;
    if (fullEnd) stageMs.full_response = fullEnd.ts_ms - start.ts_ms;
    runs.push({ runId, fixtureId, category, budget, stageMs });
  }
  return runs;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function computeStageStats(samples: number[]): StageStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    samples: sorted,
  };
}

function reportByCategory(runs: Run[]): CategoryReport[] {
  const byCat = new Map<string, Run[]>();
  for (const r of runs) {
    let arr = byCat.get(r.category);
    if (!arr) { arr = []; byCat.set(r.category, arr); }
    arr.push(r);
  }
  const reports: CategoryReport[] = [];
  for (const [category, list] of byCat) {
    const stages: Partial<Record<Stage, StageStats>> = {};
    const budgets: Partial<Record<Stage, number>> = {};
    let red = false;
    for (const stage of STAGES) {
      const samples = list
        .map(r => r.stageMs[stage])
        .filter((v): v is number => typeof v === 'number');
      if (samples.length === 0) continue;
      const stats = computeStageStats(samples);
      stages[stage] = stats;
      const budgetSamples = list
        .map(r => r.budget[stage])
        .filter((v): v is number => typeof v === 'number');
      if (budgetSamples.length) {
        // Tightest wins — one slow fixture can pull the whole category red.
        budgets[stage] = Math.min(...budgetSamples);
        if (stats.p95 > budgets[stage]!) red = true;
      }
    }
    reports.push({ category, count: list.length, stages, budgets, red });
  }
  reports.sort((a, b) => a.category.localeCompare(b.category));
  return reports;
}

// --- Formatting ------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

const useColor = process.stdout.isTTY === true;
function col(code: string, s: string): string {
  return useColor ? `${code}${s}${C.reset}` : s;
}

function fmtMs(v: number): string {
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 1_000) return `${(v / 1000).toFixed(2)}s`;
  return `${v.toFixed(0)}ms`;
}

function statusCell(p95: number, budget: number | undefined): string {
  if (budget == null) return col(C.dim, 'n/a');
  if (p95 <= budget) return col(C.green, 'PASS');
  return col(C.red, 'FAIL');
}

function renderSummaryTable(reports: CategoryReport[]): string {
  const header = ['category', 'n', 'stage', 'p50', 'p95', 'p99', 'budget', 'status'];
  const rows: string[][] = [];
  for (const r of reports) {
    let first = true;
    for (const stage of STAGES) {
      const st = r.stages[stage];
      if (!st) continue;
      const budget = r.budgets[stage];
      rows.push([
        first ? r.category : '',
        first ? String(r.count) : '',
        stage,
        fmtMs(st.p50),
        fmtMs(st.p95),
        fmtMs(st.p99),
        budget != null ? fmtMs(budget) : '—',
        statusCell(st.p95, budget),
      ]);
      first = false;
    }
    if (!first) rows.push(['', '', '', '', '', '', '', '']);
  }
  return renderTable(header, rows);
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => {
    return Math.max(visibleLen(h), ...rows.map(r => visibleLen(r[i] ?? '')));
  });
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleLen(s)));
  const line = (r: string[]) => r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  return [line(header), sep, ...rows.map(line)].join('\n');
}

function visibleLen(s: string): number {
  // Strip ANSI so column widths stay aligned under --color.
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function renderHistograms(runs: Run[]): string {
  const out: string[] = [];
  for (const stage of STAGES) {
    const samples = runs.map(r => r.stageMs[stage]).filter((v): v is number => typeof v === 'number');
    if (samples.length === 0) continue;
    out.push(col(C.bold, `histogram: ${stage} (n=${samples.length})`));
    out.push(histogram(samples, 20, 60));
    out.push('');
  }
  return out.join('\n');
}

function histogram(samples: number[], buckets: number, barWidth: number): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  // Clip to p99 so one extreme outlier doesn't flatten the whole chart; show
  // the overflow count after.
  const p99 = percentile(sorted, 99);
  const hi = Math.max(p99, min + 1);
  const step = (hi - min) / buckets;
  const counts = new Array<number>(buckets).fill(0);
  let overflow = 0;
  for (const v of sorted) {
    if (v > hi) { overflow++; continue; }
    const idx = Math.min(buckets - 1, Math.floor((v - min) / step));
    counts[idx]++;
  }
  const maxCount = Math.max(...counts, 1);
  const lines: string[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = min + i * step;
    const barLen = Math.round((counts[i] / maxCount) * barWidth);
    const bar = '#'.repeat(barLen);
    lines.push(`  ${fmtMs(lo).padStart(7)} | ${bar}${' '.repeat(barWidth - barLen)} ${counts[i]}`);
  }
  if (overflow > 0) {
    lines.push(col(C.yellow, `  ${fmtMs(hi).padStart(7)}+ overflow: ${overflow}`));
  }
  return lines.join('\n');
}

function renderTopSlow(runs: Run[]): string {
  // Score each run by its worst SLA-violation ratio; ties broken by full_response.
  type Row = { run: Run; worst: Stage | null; ratio: number };
  const rows: Row[] = runs.map(run => {
    let worst: Stage | null = null;
    let ratio = 0;
    for (const stage of STAGES) {
      const actual = run.stageMs[stage];
      const budget = run.budget[stage];
      if (actual == null || budget == null) continue;
      const r = actual / budget;
      if (r > ratio) { ratio = r; worst = stage; }
    }
    return { run, worst, ratio };
  });
  rows.sort((a, b) => {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio;
    return (b.run.stageMs.full_response ?? 0) - (a.run.stageMs.full_response ?? 0);
  });
  const top = rows.slice(0, 10);

  const header = ['run_id', 'category', 'fixture', 'prep', 'first', 'full', 'violates'];
  const tableRows = top.map(({ run, worst, ratio }) => [
    run.runId.slice(0, 8),
    run.category,
    run.fixtureId,
    fmtMs(run.stageMs.prep_context ?? 0),
    fmtMs(run.stageMs.first_token ?? 0),
    fmtMs(run.stageMs.full_response ?? 0),
    worst ? col(C.red, `${worst} x${ratio.toFixed(2)}`) : col(C.dim, 'within budget'),
  ]);
  return renderTable(header, tableRows);
}

// --- Regression ------------------------------------------------------------

type RegressionRow = {
  category: string;
  stage: Stage;
  baselineP95: number;
  currentP95: number;
  deltaPct: number;
  regression: boolean;
};

function computeRegressions(current: CategoryReport[], baseline: CategoryReport[]): RegressionRow[] {
  const baseByCat = new Map(baseline.map(r => [r.category, r] as const));
  const rows: RegressionRow[] = [];
  for (const cur of current) {
    const base = baseByCat.get(cur.category);
    if (!base) continue;
    for (const stage of STAGES) {
      const c = cur.stages[stage];
      const b = base.stages[stage];
      if (!c || !b || b.p95 === 0) continue;
      const delta = (c.p95 - b.p95) / b.p95;
      rows.push({
        category: cur.category,
        stage,
        baselineP95: b.p95,
        currentP95: c.p95,
        deltaPct: delta,
        regression: delta >= REGRESSION_THRESHOLD,
      });
    }
  }
  rows.sort((a, b) => b.deltaPct - a.deltaPct);
  return rows;
}

function renderRegressions(rows: RegressionRow[]): string {
  if (rows.length === 0) return col(C.dim, '(no overlapping categories with baseline)');
  const header = ['category', 'stage', 'baseline p95', 'current p95', 'delta', 'flag'];
  const tableRows = rows.map(r => {
    const pct = `${(r.deltaPct * 100).toFixed(1)}%`;
    const flag = r.regression
      ? col(C.red, 'REGRESSION')
      : r.deltaPct <= -REGRESSION_THRESHOLD
        ? col(C.green, 'IMPROVED')
        : col(C.dim, 'stable');
    return [r.category, r.stage, fmtMs(r.baselineP95), fmtMs(r.currentP95), pct, flag];
  });
  return renderTable(header, tableRows);
}

// --- JSON output (for regression-gate) -------------------------------------

type JsonSummary = {
  version: 1;
  runs: number;
  anyRed: boolean;
  anyRegression: boolean;
  categories: Array<{
    category: string;
    count: number;
    red: boolean;
    stages: Partial<Record<Stage, { p50: number; p95: number; p99: number; budget: number | null }>>;
  }>;
  regressions: Array<{
    category: string;
    stage: Stage;
    baselineP95: number;
    currentP95: number;
    deltaPct: number;
    regression: boolean;
  }>;
};

function buildJsonSummary(reports: CategoryReport[], regressions: RegressionRow[], anyRed: boolean): JsonSummary {
  return {
    version: 1,
    runs: reports.reduce((s, r) => s + r.count, 0),
    anyRed,
    anyRegression: regressions.some(r => r.regression),
    categories: reports.map(r => ({
      category: r.category,
      count: r.count,
      red: r.red,
      stages: STAGES.reduce((acc, stage) => {
        const st = r.stages[stage];
        if (st) {
          acc[stage] = {
            p50: +st.p50.toFixed(1),
            p95: +st.p95.toFixed(1),
            p99: +st.p99.toFixed(1),
            budget: r.budgets[stage] ?? null,
          };
        }
        return acc;
      }, {} as NonNullable<JsonSummary['categories'][number]['stages']>),
    })),
    regressions: regressions.map(r => ({
      category: r.category,
      stage: r.stage,
      baselineP95: +r.baselineP95.toFixed(1),
      currentP95: +r.currentP95.toFixed(1),
      deltaPct: +r.deltaPct.toFixed(4),
      regression: r.regression,
    })),
  };
}

// --- Main ------------------------------------------------------------------

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`analyze_latency: ${(err as Error).message}\n\n`);
    process.stderr.write(helpText());
    process.exit(64);
    return;
  }

  let records: JsonlRecord[];
  try {
    records = loadJsonl(args.jsonlPath);
  } catch (err) {
    process.stderr.write(`analyze_latency: ${(err as Error).message}\n`);
    process.exit(66);
    return;
  }
  const idx = loadIndex(args.indexPath);
  const runs = buildRuns(records, idx);
  const reports = reportByCategory(runs);
  const anyRed = reports.some(r => r.red);

  let regressions: RegressionRow[] = [];
  if (args.baselinePath) {
    try {
      const baseRecs = loadJsonl(args.baselinePath);
      const baseRuns = buildRuns(baseRecs, idx);
      const baseReports = reportByCategory(baseRuns);
      regressions = computeRegressions(reports, baseReports);
    } catch (err) {
      process.stderr.write(`analyze_latency: baseline load failed: ${(err as Error).message}\n`);
      process.exit(66);
      return;
    }
  }
  const anyRegression = regressions.some(r => r.regression);

  if (args.json) {
    const summary = buildJsonSummary(reports, regressions, anyRed);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    const out: string[] = [];
    out.push(col(C.bold, `analyze_latency: ${runs.length} runs across ${reports.length} categories`));
    out.push(col(C.dim, `  source: ${args.jsonlPath}`));
    out.push(col(C.dim, `  index:  ${args.indexPath}${idx.entries.length === 0 ? ' (missing — categories degraded)' : ''}`));
    if (args.baselinePath) out.push(col(C.dim, `  baseline: ${args.baselinePath}`));
    out.push('');
    out.push(col(C.bold, 'summary by category'));
    out.push(renderSummaryTable(reports));
    out.push('');
    out.push(renderHistograms(runs));
    out.push(col(C.bold, 'top 10 slowest runs'));
    out.push(renderTopSlow(runs));
    out.push('');
    if (args.baselinePath) {
      out.push(col(C.bold, `regression vs baseline (>=${(REGRESSION_THRESHOLD * 100).toFixed(0)}%)`));
      out.push(renderRegressions(regressions));
      out.push('');
    }
    const verdictParts: string[] = [];
    verdictParts.push(anyRed ? col(C.red, 'SLA: RED') : col(C.green, 'SLA: GREEN'));
    if (args.baselinePath) {
      verdictParts.push(anyRegression ? col(C.red, 'baseline: REGRESSION') : col(C.green, 'baseline: OK'));
    }
    out.push(col(C.bold, `verdict: ${verdictParts.join('   ')}`));
    process.stdout.write(out.join('\n') + '\n');
  }

  // Exit semantics: 2 outranks 1 outranks 0 only when both fire; brief says
  // "2 = regression" so we elevate regression over SLA-red. Regression gate
  // consumers can disambiguate via the --json payload.
  if (anyRegression) process.exit(2);
  if (anyRed) process.exit(1);
  process.exit(0);
}

main();
