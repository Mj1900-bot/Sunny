/**
 * CostPage — shared types and Zod schemas.
 *
 * Zod validates every Tauri IPC payload at runtime so a stale backend
 * never silently corrupts the UI.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// telemetry_llm_recent payload
// ---------------------------------------------------------------------------

export const TelemetryEventSchema = z.object({
  provider:    z.string(),
  model:       z.string(),
  input:       z.number(),
  cache_read:  z.number(),
  cache_create: z.number(),
  output:      z.number(),
  duration_ms: z.number(),
  at:          z.number(),
  cost_usd:    z.number().optional().default(0),
  tier:        z.string().nullable().optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// ---------------------------------------------------------------------------
// cost_today_json payload
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tier distribution (added alongside by_provider)
// ---------------------------------------------------------------------------

export const TierBucketSchema = z.object({
  turns: z.number(),
  cost:  z.number(),
});
export type TierBucket = z.infer<typeof TierBucketSchema>;

export const ByTierSchema = z.object({
  quickthink: TierBucketSchema,
  cloud:      TierBucketSchema,
  deeplocal:  TierBucketSchema,
  premium:    TierBucketSchema,
});
export type ByTier = z.infer<typeof ByTierSchema>;

const emptyBucket = (): TierBucket => ({ turns: 0, cost: 0 });

export const EMPTY_BY_TIER: ByTier = {
  quickthink: emptyBucket(),
  cloud:      emptyBucket(),
  deeplocal:  emptyBucket(),
  premium:    emptyBucket(),
};

export const CostTodaySchema = z.object({
  /** Total USD cost since midnight local time */
  total_usd:     z.number(),
  /** Turn count since midnight */
  turns:         z.number(),
  /** Cost per provider: { "ollama": 0, "glm": 0.04, "anthropic": 0.21, ... } */
  by_provider:   z.record(z.string(), z.number()),
  /** Cost + turn count per routing tier (always all four keys). */
  by_tier: ByTierSchema.default({
    quickthink: { turns: 0, cost: 0 },
    cloud:      { turns: 0, cost: 0 },
    deeplocal:  { turns: 0, cost: 0 },
    premium:    { turns: 0, cost: 0 },
  }),
});
export type CostToday = z.infer<typeof CostTodaySchema>;

// ---------------------------------------------------------------------------
// perf_profile_snapshot payload (I6 in-flight — gracefully degraded stubs)
// ---------------------------------------------------------------------------

export const PerfModelRowSchema = z.object({
  model:      z.string(),
  p50_ms:     z.number(),
  p95_ms:     z.number(),
  sample_n:   z.number(),
});
export type PerfModelRow = z.infer<typeof PerfModelRowSchema>;

export const PerfSnapshotSchema = z.object({
  rows: z.array(PerfModelRowSchema),
});
export type PerfSnapshot = z.infer<typeof PerfSnapshotSchema>;

// ---------------------------------------------------------------------------
// Derived view types (computed in api.ts / page from raw events)
// ---------------------------------------------------------------------------

/** Counts + fraction for the donut chart */
export type ModelSlice = {
  readonly label: string;
  readonly count: number;
  readonly pct:   number;
  readonly color: string;
};

/** One hourly bucket for the $/hr rolling chart */
export type HourlyBucket = {
  readonly hourTs: number;  // Unix epoch of the start of the hour
  readonly costUsd: number;
};

/** Tier names recognised by the router (K5). */
export type TierName = 'quickthink' | 'cloud' | 'deeplocal' | 'premium';

/** One row in the TierDistribution bar chart. */
export type TierSlice = {
  readonly name:    TierName;
  readonly label:   string;          // human-friendly e.g. "QuickThink"
  readonly turns:   number;
  readonly costUsd: number;
  readonly pct:     number;          // 0-100, share of total turns
  readonly color:   string;          // CSS custom property ref
  readonly colorClass: string;       // e.g. "tier-quickthink" for testing
};
