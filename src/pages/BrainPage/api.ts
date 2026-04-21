import { invokeSafe } from '../../lib/tauri';
import type { WorldState } from '../WorldPage/types';

export type ToolStats = {
  tool_name: string;
  count: number;
  ok_count: number;
  err_count: number;
  success_rate: number;  // 0..1 or -1 when no calls
  latency_p50_ms: number;
  latency_p95_ms: number;
  last_at: number | null;
  last_ok: boolean | null;
};

export type DailyBucket = { day_ts: number; count: number; ok_count: number };

export type MemoryStats = {
  episodic_count: number;
  semantic_count: number;
  procedural_count: number;
  total_bytes: number;
};

/** Aggregate tool reliability for events in the last `sinceSecs` seconds (minimum one hour). */
export async function getStatsSinceSecs(sinceSecs: number): Promise<ReadonlyArray<ToolStats>> {
  const s = Math.max(3600, Math.floor(sinceSecs));
  return (await invokeSafe<ToolStats[]>('tool_usage_stats', {
    opts: { since_secs_ago: s },
  })) ?? [];
}

/** @deprecated Prefer `getStatsSinceSecs` for hour-accurate windows; this uses whole days only. */
export async function getStats(sinceDays = 7): Promise<ReadonlyArray<ToolStats>> {
  return getStatsSinceSecs(sinceDays * 86_400);
}

export async function getBuckets(days = 14): Promise<ReadonlyArray<DailyBucket>> {
  return (await invokeSafe<DailyBucket[]>('tool_usage_daily_buckets', {
    opts: { days },
  })) ?? [];
}

export async function getMemoryStats(): Promise<MemoryStats | null> {
  return invokeSafe<MemoryStats>('memory_stats');
}

export async function getWorld(): Promise<WorldState | null> {
  return invokeSafe<WorldState>('world_get');
}

export async function listOllamaModels(): Promise<ReadonlyArray<string>> {
  return (await invokeSafe<string[]>('ollama_list_models')) ?? [];
}

// ---------------------------------------------------------------------------
// LLM telemetry (Rust `telemetry` ring buffer)
// ---------------------------------------------------------------------------

export type TelemetryEvent = {
  provider: string;
  model: string;
  input: number;
  cache_read: number;
  cache_create: number;
  output: number;
  duration_ms: number;
  at: number;
};

export type LlmStats = {
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_rate: number;
  cache_savings_pct: number;
  turns_count: number;
};

export async function getLlmStats(): Promise<LlmStats | null> {
  return invokeSafe<LlmStats>('telemetry_llm_stats');
}

export async function getLlmRecent(limit = 20): Promise<ReadonlyArray<TelemetryEvent>> {
  return (await invokeSafe<TelemetryEvent[]>('telemetry_llm_recent', { limit })) ?? [];
}
