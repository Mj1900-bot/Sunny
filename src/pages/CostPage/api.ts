/**
 * CostPage API — fetches from two Tauri commands and computes derived views.
 *
 * Commands:
 *  - `cost_today_json`         → CostToday  (new minimal command added in
 *                                commands/cost.rs that reads the global
 *                                telemetry ring and slices to today's turns)
 *  - `telemetry_llm_recent`    → TelemetryEvent[] (already registered)
 *  - `perf_profile_snapshot`   → PerfSnapshot (I6; gracefully returns null
 *                                until the command is registered, so the
 *                                latency table shows a degraded empty-state)
 */
import { invokeSafe } from '../../lib/tauri';

export type LlmStats = {
  total_input_tokens:  number;
  total_output_tokens: number;
  cache_hit_rate:      number;
  cache_savings_pct:   number;
  turns_count:         number;
};
import {
  CostTodaySchema, TelemetryEventSchema, PerfSnapshotSchema,
  EMPTY_BY_TIER,
  type CostToday, type TelemetryEvent, type PerfSnapshot,
  type ModelSlice, type HourlyBucket, type TierSlice, type ByTier,
} from './types';

// ---------------------------------------------------------------------------
// Raw Tauri fetches
// ---------------------------------------------------------------------------

export async function fetchCostToday(): Promise<CostToday> {
  const raw = await invokeSafe<unknown>('cost_today_json');
  const parsed = CostTodaySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Graceful degradation when command isn't registered yet
  return { total_usd: 0, turns: 0, by_provider: {}, by_tier: EMPTY_BY_TIER };
}

export async function fetchRecentTurns(limit = 100): Promise<ReadonlyArray<TelemetryEvent>> {
  const raw = await invokeSafe<unknown[]>('telemetry_llm_recent', { limit });
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const r = TelemetryEventSchema.safeParse(item);
    return r.success ? [r.data] : [];
  });
}

export async function fetchPerfSnapshot(): Promise<PerfSnapshot | null> {
  const raw = await invokeSafe<unknown>('perf_profile_snapshot');
  if (raw == null) return null;
  const parsed = PerfSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Derived computations (pure, testable)
// ---------------------------------------------------------------------------

const MODEL_COLORS: Record<string, string> = {
  'glm':       'var(--violet)',
  'qwen':      'var(--cyan)',
  'anthropic': 'var(--amber)',
  'ollama':    'var(--green)',
};

function colorForModel(model: string): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.toLowerCase().includes(key)) return color;
  }
  return 'var(--ink-2)';
}

/**
 * Compute model-distribution slices for the donut chart.
 * Groups by the raw `model` string.  Returns slices sorted descending by count.
 * Percentages are guaranteed to sum to 100 (last slice absorbs rounding dust).
 */
export function computeModelSlices(events: ReadonlyArray<TelemetryEvent>): ReadonlyArray<ModelSlice> {
  if (events.length === 0) return [];

  const counts = new Map<string, number>();
  for (const ev of events) {
    counts.set(ev.model, (counts.get(ev.model) ?? 0) + 1);
  }

  const total = events.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  let pctUsed = 0;
  return sorted.map(([model, count], idx) => {
    const isLast = idx === sorted.length - 1;
    const pct = isLast ? 100 - pctUsed : Math.round((count / total) * 100);
    pctUsed += pct;
    return { label: model, count, pct, color: colorForModel(model) };
  });
}

/**
 * Build hourly cost buckets over the last 24 hours from the event log.
 * Returns 24 buckets (oldest first); missing hours are 0.
 */
export function computeHourlyBuckets(events: ReadonlyArray<TelemetryEvent>): ReadonlyArray<HourlyBucket> {
  const now = Date.now();
  const HOUR = 3_600_000;
  const startHour = Math.floor((now - 24 * HOUR) / HOUR) * HOUR;

  // Build a fresh map (immutable approach: reduce instead of mutation)
  const raw = events.reduce<Map<number, number>>((acc, ev) => {
    const bucket = Math.floor((ev.at * 1000) / HOUR) * HOUR;
    if (bucket >= startHour && bucket <= now) {
      return new Map(acc).set(bucket, (acc.get(bucket) ?? 0) + (ev.cost_usd ?? 0));
    }
    return acc;
  }, new Map<number, number>());

  return Array.from({ length: 24 }, (_, i) => {
    const hourTs = startHour + i * HOUR;
    return { hourTs, costUsd: raw.get(hourTs) ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Tier distribution computation
// ---------------------------------------------------------------------------

const TIER_META: ReadonlyArray<{ name: import('./types').TierName; label: string; color: string; colorClass: string }> = [
  { name: 'quickthink', label: 'QuickThink', color: 'var(--green)',  colorClass: 'tier-quickthink' },
  { name: 'cloud',      label: 'Cloud',      color: 'var(--cyan)',   colorClass: 'tier-cloud'      },
  { name: 'deeplocal',  label: 'DeepLocal',  color: 'var(--violet)', colorClass: 'tier-deeplocal'  },
  { name: 'premium',    label: 'Premium',    color: 'var(--amber)',  colorClass: 'tier-premium'    },
] as const;

/**
 * Compute tier distribution slices from a `by_tier` backend payload.
 *
 * Percentages are based on turn count, not cost, so free tiers (QuickThink /
 * DeepLocal) still show up proportionally.  The last slice absorbs any
 * rounding remainder so the total always sums to exactly 100.
 */
export function computeTierSlices(byTier: ByTier): ReadonlyArray<TierSlice> {
  const totalTurns = TIER_META.reduce((acc, m) => acc + byTier[m.name].turns, 0);
  if (totalTurns === 0) return [];

  let pctUsed = 0;
  return TIER_META.map((meta, idx) => {
    const { turns, cost } = byTier[meta.name];
    const isLast = idx === TIER_META.length - 1;
    const pct = isLast
      ? 100 - pctUsed
      : Math.round((turns / totalTurns) * 100);
    pctUsed += pct;
    return {
      name:      meta.name,
      label:     meta.label,
      turns,
      costUsd:   cost,
      pct,
      color:     meta.color,
      colorClass: meta.colorClass,
    } as TierSlice;
  });
}
