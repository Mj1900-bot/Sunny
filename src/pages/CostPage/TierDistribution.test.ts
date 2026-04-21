/**
 * TierDistribution tests — 10+ vitest assertions covering:
 *  1.  computeTierSlices: empty input → empty array
 *  2.  computeTierSlices: 4 tiers all present in output
 *  3.  computeTierSlices: percentages sum to 100
 *  4.  computeTierSlices: 0-turn tiers get 0%
 *  5.  computeTierSlices: single tier gets 100%
 *  6.  computeTierSlices: correct cost propagation per tier
 *  7.  Color assignment per tier (colorClass check)
 *  8.  Rounding: last slice absorbs remainder (sum always 100)
 *  9.  ByTierSchema: Zod parses valid payload
 *  10. ByTierSchema: Zod rejects missing tier key
 *  11. CostTodaySchema: by_tier defaults correctly when absent
 *  12. TierBucketSchema: validates turns+cost shape
 */

import { describe, it, expect } from 'vitest';
import { computeTierSlices } from './api';
import { ByTierSchema, TierBucketSchema, CostTodaySchema, EMPTY_BY_TIER } from './types';
import type { ByTier } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeByTier(overrides: Partial<ByTier> = {}): ByTier {
  return {
    ...EMPTY_BY_TIER,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1-2: computeTierSlices basic shape
// ---------------------------------------------------------------------------

describe('computeTierSlices', () => {
  it('1. returns empty array when all tiers have 0 turns', () => {
    expect(computeTierSlices(EMPTY_BY_TIER)).toEqual([]);
  });

  it('2. output contains all 4 tier names when there are turns', () => {
    const by = makeByTier({
      quickthink: { turns: 1, cost: 0 },
      cloud:      { turns: 1, cost: 0.01 },
      deeplocal:  { turns: 1, cost: 0 },
      premium:    { turns: 1, cost: 0.05 },
    });
    const slices = computeTierSlices(by);
    expect(slices).toHaveLength(4);
    const names = slices.map(s => s.name);
    expect(names).toContain('quickthink');
    expect(names).toContain('cloud');
    expect(names).toContain('deeplocal');
    expect(names).toContain('premium');
  });

  it('3. percentages sum to exactly 100', () => {
    const by = makeByTier({
      quickthink: { turns: 3, cost: 0 },
      cloud:      { turns: 5, cost: 0.02 },
      deeplocal:  { turns: 2, cost: 0 },
      premium:    { turns: 7, cost: 0.10 },
    });
    const slices = computeTierSlices(by);
    const total = slices.reduce((s, sl) => s + sl.pct, 0);
    expect(total).toBe(100);
  });

  it('4. zero-turn tiers get 0%', () => {
    const by = makeByTier({
      cloud: { turns: 10, cost: 0.05 },
    });
    const slices = computeTierSlices(by);
    const quick = slices.find(s => s.name === 'quickthink');
    expect(quick?.pct).toBe(0);
    const deep = slices.find(s => s.name === 'deeplocal');
    expect(deep?.pct).toBe(0);
    const premium = slices.find(s => s.name === 'premium');
    expect(premium?.pct).toBe(0);
  });

  it('5. single active tier gets 100%', () => {
    const by = makeByTier({ premium: { turns: 5, cost: 0.25 } });
    const slices = computeTierSlices(by);
    const p = slices.find(s => s.name === 'premium');
    expect(p?.pct).toBe(100);
  });

  it('6. cost propagates correctly to costUsd', () => {
    const by = makeByTier({
      cloud:   { turns: 4, cost: 0.123 },
      premium: { turns: 1, cost: 0.456 },
    });
    const slices = computeTierSlices(by);
    const cloud   = slices.find(s => s.name === 'cloud')!;
    const premium = slices.find(s => s.name === 'premium')!;
    expect(cloud.costUsd).toBeCloseTo(0.123);
    expect(premium.costUsd).toBeCloseTo(0.456);
  });

  it('7. correct colorClass assigned per tier', () => {
    const by = makeByTier({
      quickthink: { turns: 1, cost: 0 },
      cloud:      { turns: 1, cost: 0 },
      deeplocal:  { turns: 1, cost: 0 },
      premium:    { turns: 1, cost: 0 },
    });
    const slices = computeTierSlices(by);
    const byName = Object.fromEntries(slices.map(s => [s.name, s]));
    expect(byName['quickthink'].colorClass).toBe('tier-quickthink');
    expect(byName['cloud'].colorClass).toBe('tier-cloud');
    expect(byName['deeplocal'].colorClass).toBe('tier-deeplocal');
    expect(byName['premium'].colorClass).toBe('tier-premium');
  });

  it('8. rounding: last slice absorbs remainder so sum = 100', () => {
    // 3 tiers: 1/3 each → rounds to 33, 33, 34 — still 100
    const by = makeByTier({
      quickthink: { turns: 1, cost: 0 },
      cloud:      { turns: 1, cost: 0 },
      deeplocal:  { turns: 1, cost: 0 },
    });
    const slices = computeTierSlices(by);
    const total = slices.reduce((s, sl) => s + sl.pct, 0);
    expect(total).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 9-10: ByTierSchema Zod validation
// ---------------------------------------------------------------------------

describe('ByTierSchema', () => {
  it('9. parses valid by_tier payload', () => {
    const raw = {
      quickthink: { turns: 2, cost: 0 },
      cloud:      { turns: 5, cost: 0.04 },
      deeplocal:  { turns: 1, cost: 0 },
      premium:    { turns: 0, cost: 0 },
    };
    const result = ByTierSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('10. rejects payload missing a tier key', () => {
    const raw = {
      quickthink: { turns: 2, cost: 0 },
      cloud:      { turns: 5, cost: 0.04 },
      // deeplocal and premium missing
    };
    const result = ByTierSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11: CostTodaySchema defaults by_tier when absent
// ---------------------------------------------------------------------------

describe('CostTodaySchema', () => {
  it('11. by_tier defaults to zero buckets when field absent', () => {
    const raw = { total_usd: 0.1, turns: 2, by_provider: { ollama: 0.0 } };
    const result = CostTodaySchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.by_tier.quickthink.turns).toBe(0);
      expect(result.data.by_tier.premium.cost).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 12: TierBucketSchema
// ---------------------------------------------------------------------------

describe('TierBucketSchema', () => {
  it('12. validates a turns+cost bucket', () => {
    const result = TierBucketSchema.safeParse({ turns: 3, cost: 0.021 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turns).toBe(3);
      expect(result.data.cost).toBeCloseTo(0.021);
    }
  });
});
