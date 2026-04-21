# Memory — Architecture (sprint-10, Agent η)

SUNNY's memory layer lives in `src-tauri/src/memory/` — **14 Rust modules, ~6,600 lines**,
all backed by a single SQLite file at `~/.sunny/memory/memory.sqlite` (WAL, 0600).
This doc is an architectural map, not a reference: it names every module,
traces the read/write paths per agent turn, and flags the five overlapping
recall strategies for a future consolidation sprint.

## Module inventory

| Module | Role |
|---|---|
| `mod.rs` | Public re-exports + `LegacyItem` shims |
| `db.rs` | SQLite open + migrations v1–v7, `with_conn` mutex, FTS sanitiser, WAL maint |
| `episodic.rs` | High-volume event log: user / agent_step / tool_call / perception / note / reflection |
| `semantic.rs` | Low-volume durable facts (subject/text/confidence/source) with idempotent upsert + `list_facts_pinned_first` |
| `procedural.rs` | Named skills (script-backed or recipe-backed) with uses/success counters |
| `conversation.rs` | Per-session turn log (user/assistant/tool) for cross-surface chat replay |
| `tool_usage.rs` | Per-call telemetry (ok, latency, error, reason) — separate table, integer PK |
| `embed.rs` | Ollama `nomic-embed-text` HTTP client + backfill loop + cosine |
| `pack.rs` | `build_pack(opts)` — assembles the `MemoryPack` the agent reads each turn |
| `hybrid.rs` | Episodic FTS5 + embedding cosine blend for the `memory_recall` tool |
| `expand.rs` | Query paraphrase via qwen2.5:7b → N variants for `search_expanded` |
| `consolidator.rs` | Watermark + pending rows API; the LLM call itself runs in TS |
| `compact.rs` | Semantic de-dupe: cluster near-duplicate facts by cosine, soft-delete losers |
| `retention.rs` | Daily sweep: age out perception/agent_step/tool_call/tool_usage/conversation |

## READ path — one agent turn

Entry point: `agent_loop::core::agent_run_inner` (Rust) and
`build_memory_digest(goal, history)` in `agent_loop::memory_integration`.

1. **Conversation replay** — if caller's `history` is empty but a `session_id`
   is provided, `conversation::tail(sid, 16)` reads the last 16 turns.
   Oldest-first, trimmed to 4 KB char budget.
2. **Memory pack build** — `pack::build_pack(BuildOptions{goal,…})`, wrapped
   in `spawn_blocking` with a 500 ms outer timeout:
   - FTS prefilter semantic + episodic at 4× the final K.
   - Filter `Reflection` rows out of episodic hits (no self-reference).
   - `embed_goal_blocking(goal)` with a 400 ms budget → query vector.
   - `rerank_all` cosine-reranks semantic / episodic / procedural candidates
     against the query vector, using `fetch_embeddings_by_id` in one IN-query.
   - Fallback when no goal / embed fails: `semantic::list_facts_pinned_first`
     (keeps `user.*` identity facts pinned) + recency only.
   - Recent-episodic list (20) + top-5 skills by uses_count + `world::current()`.
3. **Digest render** — `build_memory_digest` lays out the pack as
   "What I already know about Sunny:", "Recent events:", "Right now:" (world),
   then appends the conversation tail block (cap 1500 chars).
4. **Tool path** — if the LLM calls the `memory_recall` tool mid-turn,
   `src-tauri/src/memory/hybrid.rs` via `hybrid::search(query, limit, blend)` (or
   `search_expanded` when `expand=true`, which calls `expand::expand_query`
   to generate 5 paraphrases and runs hybrid on each).
5. **Skill routing** — `MemoryPack.matched_skills` (cosine > 0.25, top 5)
   is consumed by `src/lib/agentLoop.ts` System-1 router.

## WRITE path — what gets written where

| Trigger | Writer | Table(s) |
|---|---|---|
| User message arrives | `agent_loop::core` | `conversation` (role=user) + `episodic` (kind=user) |
| Agent produces final reply | `agent_loop::core` | `conversation` (role=assistant) + `episodic` (kind=agent_step, meta.tool_sequence) |
| `memory_remember` tool OR regex `auto_remember_from_user` | `memory_integration` | `semantic` upsert (+ episodic breadcrumb) |
| World updater — focus change / OCR | `world::*` | `episodic` (kind=perception) |
| Post-run reflection (TS) | `reflect.ts` via commands | `episodic` (kind=reflection) + optional `semantic` (source=reflection, conf 0.55/0.75) |
| Consolidator (every 15 min in TS) | `consolidator.ts` | N× `semantic_add_fact(source=consolidator)` |
| Skill synthesis (every 20 min in TS) | TS loop | `procedural` (recipe-backed) |
| Any tool invocation | `registry.ts → tool_usage_record` | `tool_usage` |
| Skill executed by System-1 | TS router | `procedural.bump_use(success)` |
| On every add to episodic/semantic/procedural | auto | `embed::spawn_embed_for` (async UPDATE of `embedding` BLOB) |
| Background | `embed::start_backfill_loop` | 8 rows/store/30 s tick, fill missing embeddings |
| Daily sweep | `retention::start_retention_loop` | DELETE old perception(14d)/agent_step(28d, no `has-lesson`)/tool_call(7d), prune tool_usage(30d), prune conversation(90d) |
| On-demand | `compact::run_compaction` | soft-delete (`deleted_at`) near-duplicate semantic rows above cosine 0.85 |

## The five overlapping "recall" strategies

κ was right — there are **five distinct retrieval entry points**, each with its
own ranker. Named by what they're best at:

1. **`pack::build_pack`** — turn-start digest (FTS-widen → embed rerank per store, pinned semantic fallback). Consumed by every agent run.
2. **`hybrid::search`** — `memory_recall` tool (episodic-only, BM25+cosine blend with alpha, reciprocal-rank normalisation).
3. **`hybrid::search_expanded`** — same as #2 but paraphrases the query 5 ways first (`expand.rs`) and merges with a multi-hit bonus.
4. **Per-store `search` / `search_facts`** — FTS5-only BM25 on episodic / semantic. Used by the Memory Inspector UI tabs and as the prefilter inside #1.
5. **`semantic::list_facts_pinned_first`** — recency-only with `user.*` pin, no goal, used when #1 has no goal.

(Arguably a 6th exists: `embed::rerank_by_cosine`, `#[allow(dead_code)]`, kept for a future rowid-based path.)

## Consolidation proposal

All five were added for a real reason, but three pairs substantially overlap:

- **Merge hybrid.rs and pack.rs rerankers.** They share `fetch_embeddings_by_id` (literally copy-pasted with a comment acknowledging the duplication), share `embed::cosine`, share the "FTS widen → cosine rerank" shape. Extract a single `memory::rank::rerank<T>(query_vec, candidates, table)` in `embed.rs` and have both callers use it. Estimated: −150 LOC, same behaviour.
- **Fold `search_expanded` into `search` as a flag.** `hybrid::search_expanded` is 95% orchestration; only the paraphrase loop is new. A `SearchOpts{ expand: bool }` struct removes one public entry point and collapses the two code paths at the call site in `dispatch.rs`.
- **Drop dead `embed::rerank_by_cosine`.** `#[allow(dead_code)]` since Phase 1b. Kill it — git preserves the design note for when the rowid-based path is actually wanted.
- **Keep `list_facts_pinned_first` separate.** It's small and serves a pure recency path with no embed dependency — different contract from the goal-driven recallers.
- **Keep `pack::build_pack` as THE per-turn entry point.** It's the right layer of abstraction (one pack, many stores, one contract with the agent). `memory_recall` (hybrid) is a legitimately distinct tool surface — the LLM needs to query on-demand mid-turn, which the pack can't serve.

Net outcome would be **4 recall strategies, ~5,900 LOC**, same behaviour. Future sprint material — no refactor this sprint per the brief.

## Reader connection pool

`memory/db.rs` now maintains a pool of read-only SQLite connections alongside
the single writer mutex. This decouples concurrent read workloads — the
memory-pack builder, FTS inspector calls from the UI, and the `memory_recall`
tool can all run in parallel without serializing through the writer lock.

### Current state (Phase 2)

The pool infrastructure landed in Phase 2:

- `READER_POOL_SIZE = 4` read-only WAL connections, seeded by `init_reader_pool`
  after schema confirmation in `init_in`.
- `with_reader(f)` borrows a connection from the pool via a `PoolGuard` RAII
  wrapper that returns it on drop, even on panic. Falls back to `with_conn`
  (the writer path) when the pool is empty or not yet initialised, preserving
  correctness under contention.
- Connections use `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_SHARED_CACHE |
  SQLITE_OPEN_NO_MUTEX`. In WAL mode readers never block writers; shared-cache
  lets the OS page cache be reused across connections within the process.

### Planned caller migration (Phase 4, in progress)

Phase 2 wired the pool infrastructure and Phase 3 confirmed it is correct (stress
test `reader_pool_concurrent_reads`, 8 threads, still green). All existing read
call sites remain on `with_conn` for now.

Phase 4 aims to migrate the high-concurrency callers — `pack::build_pack`,
`hybrid::search`, and `expand::expand_query` — to `with_reader`. If those PRs
have not yet merged, `with_reader` exists but sees no production traffic; the
fallback to `with_conn` ensures zero regression either way.

The migration is intentionally conservative: call sites are switched one module
at a time, with the stress test kept green after each switch.

## Further reading


- `docs/AGENT.md` — how the digest feeds the LLM prompt
- `docs/ARCHITECTURE.md` — where memory sits in the overall Tauri stack
- `docs/SKILLS.md` — procedural recipe format + System-1 router
