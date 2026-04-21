// ---------------------------------------------------------------------------
// Wire-shape types (mirror Rust structs in src-tauri/src/memory/*)
// ---------------------------------------------------------------------------

export type EpisodicKind =
  | 'user'
  | 'agent_step'
  | 'tool_call'
  | 'perception'
  | 'note'
  | 'reflection';

export type EpisodicItem = Readonly<{
  id: string;
  kind: EpisodicKind;
  text: string;
  tags: readonly string[];
  meta: unknown;
  created_at: number;
}>;

export type SemanticFact = Readonly<{
  id: string;
  subject: string;
  text: string;
  tags: readonly string[];
  confidence: number;
  source: string;
  created_at: number;
  updated_at: number;
}>;

export type ProceduralSkill = Readonly<{
  id: string;
  name: string;
  description: string;
  trigger_text: string;
  skill_path: string;
  uses_count: number;
  /** Subset of `uses_count` that reached `done`. Added in schema v4;
   *  legacy rows default to 0 server-side. */
  success_count: number;
  last_used_at: number | null;
  created_at: number;
  recipe?: unknown;
}>;

export type MemoryStats = Readonly<{
  episodic_count: number;
  semantic_count: number;
  procedural_count: number;
  oldest_episodic_secs: number | null;
  newest_episodic_secs: number | null;
}>;

export type ConsolidatorStatus = Readonly<{
  last_run_ts: number;
  pending_count: number;
  min_floor: number;
}>;

export type Tab =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'graph'
  | 'tools'
  | 'insights'
  | 'history';

export type ToolStats = Readonly<{
  tool_name: string;
  count: number;
  ok_count: number;
  err_count: number;
  /** 0.0–1.0, or -1.0 when count is 0 (which doesn't happen in practice). */
  success_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  last_at: number | null;
  last_ok: boolean | null;
}>;

export type ToolUsageRecord = Readonly<{
  id: number;
  tool_name: string;
  ok: boolean;
  latency_ms: number;
  error_msg: string | null;
  created_at: number;
}>;
