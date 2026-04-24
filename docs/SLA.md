# Sunny HUD — Latency SLA

**Owner:** sunny-test-sla-steward (Wave 3)
**Status:** authoritative reference for the 2-second promise
**Anchors:** `src-tauri/src/agent_loop/task_classifier.rs:35` (`CLASSIFIER_TIMEOUT = Duration::from_secs(2)`), mirrored by `src-tauri/src/ambient_classifier.rs:62` (`CLASSIFIER_TIMEOUT_SECS = 2`). Anything that ships from the core loop must render by the same wall-clock the task classifier refuses to wait past.

This document is spec-only. No code changes live here; it is the target the harness (`src-tauri/src/latency_harness.rs`) and the analyzer (`scripts/analyze_latency.ts`) measure against.

---

## 1. Budget split

The promise is **full_response p95 ≤ 2000 ms** on the default warm-typed path. It decomposes as:

```
full_response p95 ≤ 2000 ms
├── prep_context p95 ≤ 200 ms
│   ├── session cache lookup  ≤   5 ms
│   ├── memory digest build   ≤ 100 ms   (hard cap today is 500 ms; we tighten)
│   └── backend + model pick  ≤  50 ms   (cached post-first-turn)
├── first_token p95 ≤ 1200 ms
│   ├── LLM request roundtrip ≤ 1100 ms  (Ollama local; Z.AI network adds +200 ms allowance)
│   └── tool-dispatch overhead ≤ 50 ms per tool_use block
├── generate (first_token → full_response) ≤ 800 ms cumulative
└── critic + turn_end tail ≤ 300 ms (post-response; not on the TTFT path)
```

**Voice overhead** (press-to-hear, shape `voice_mid_session` step 2): add 900 ms STT (cpal capture + whisper transcribe) before `turn_start` and 500 ms to first-audio-frame from Kokoro after `full_response_end`. End-to-end press-to-hear budget: **3500 ms**. TTS streaming overlaps LLM generate; do not double-count.

**Cold-path additions** (shape `cold_boot_first_turn`): +2000 ms over the warm budget to cover Ollama model load, keychain probe, tags probe, and first digest stack. Cold budget: **4000 ms**.

The 2000 ms full_response ceiling and the 2000 ms `CLASSIFIER_TIMEOUT` are the same number on purpose — if we miss the SLA, the classifier will have already given up and shipped whatever fallback it had.

---

## 2. Per-category budget overrides

Aligned with `docs/fixtures/latency/load_shapes.json`. Do not drift from those numbers without updating both files.

| Category | p95 budget | Source shape | Rationale |
|---|---|---|---|
| `cold_boot_first_turn` | ≤ 4000 ms | shape `cold_boot_first_turn` | One-time cost; model load + warm stack |
| `warm_typed_default` | ≤ 2000 ms | shape `warm_multi_turn` turns 1/2/4/5 | Default promise |
| `warm_typed_tool_use` | ≤ 2500 ms | shape `warm_multi_turn` turn 3 | Tool round-trip is irreducible |
| `interactive_quickfact` | ≤ 1500 ms | fixtures under `quickfact_typed/` | Tighter than default — terse answers |
| `memory_recall_cross_session` | ≤ 2000 ms | fixture dir same name | Baseline warm budget |
| `multi_tool_research` | ≤ 8000 ms | `multi_tool_research_typed/`, `deep_research_fanout/` | Real work, user is browsing results |
| `concurrent_subagent_fanout` | ≤ 6000 ms | shape `concurrent_subagent_dispatch` step 2 | Slowest of 3 parallel sub-agents |
| `background_interference` | ≤ 2200 ms | shape `background_interference` | 200 ms headroom for DB contention |
| `voice_press_to_hear` | ≤ 3500 ms | shape `voice_mid_session` step 2 | STT + LLM + TTS-first-frame |
| `confirm_gate_accept` | ≤ 100 ms | shape `confirm_gate_interrupt` | Gate-accept-to-dispatch only |
| `background_autopilot` | no SLA | `on_event_daemon_fire/`, `daemon_install_and_arm/` | User is not waiting |

Tool-use turns are bucketed separately in p95 aggregation (see `load_shapes.json` `warm_multi_turn.aggregation.p95_inclusion_rule`) — do not pollute non-tool p95 with tool turns.

---

## 3. Tripwires

The analyzer greps JSONL / stdout for these exact patterns. Each violation line carries the stage name, observed ms, budget ms, and the run UUID.

```
[sla/violation] prep_context <n>ms (budget <b>ms) run=<uuid>
[sla/violation] first_token <n>ms (budget <b>ms) run=<uuid>
[sla/violation] full_response <n>ms (budget <b>ms) run=<uuid>
[sla/violation] tool_dispatch <n>ms (budget <b>ms) run=<uuid> tool=<name>
[sla/violation] critic <n>ms (budget <b>ms) run=<uuid>
[sla/violation] voice_press_to_hear <n>ms (budget <b>ms) run=<uuid>
[sla/violation] confirm_gate_accept <n>ms (budget <b>ms) run=<uuid>
```

**Emission sites** (for tripwire wiring, no code change in this deliverable):

- `prep_context` + `first_token` + `full_response` — emitted from `src-tauri/src/core.rs` around the `turn_start` / `prepare_context` / `first_token` / `turn_end` boundaries, co-emitted with the existing `TelemetryEvent` record.
- `tool_dispatch` — emitted from `src-tauri/src/dispatch/mod.rs` at the safe-bucket `join_all` return (currently before `turn_id` threading lands — see §7a).
- `critic` — emitted from `src-tauri/src/core.rs` critic pass tail.
- `voice_press_to_hear` — composed by `latency_harness.rs` from the `stt_record_start` and `tts_first_audio_frame` stage markers.
- `confirm_gate_accept` — emitted by `src-tauri/src/confirm.rs` between `confirm_response_received` and `tool_dispatch_start`.
- Per-provider TTFT — emitted from `providers/ollama.rs`, `providers/anthropic.rs`, `providers/zai.rs` at the first-byte boundary of the streaming body.

Tripwire lines are **log-only**. They do not fail the run; the analyzer aggregates them into pass/fail (§4).

---

## 4. Pass / fail semantics

- **PASS** — a category passes iff p95 across **≥ 5 fixtures** stays under budget on **≥ 95%** of harness runs, measured across **≥ 3 runs** averaged to absorb Ollama variance.
- **FAIL** — any p95 overrun on a category flags it red in the analyzer output (exit code 1).
- **REGRESSION** — a **≥ 10%** p95 increase vs. the current baseline flags red even if the absolute number is still under budget (exit code 2).
- **INFRA ERROR** — precondition failure (e.g. `kokoro_daemon_pid` unset, Ollama model not resident) is tagged `infrastructure_error`, not `sla_miss`. Analyzer exits 66 for this class so operators can distinguish broken rigs from real regressions. Exit 64 is reserved for malformed fixtures / shape JSON.

Per-step overruns do **not** short-circuit the chain; all steps complete so the summary is full.

---

## 5. Baseline capture policy

- **Location:** `docs/fixtures/latency/baselines/<yyyy-mm-dd>-<short-hash>.json`, where `<short-hash>` is the first 8 chars of the git HEAD sha at capture time.
- **Contents:** per-category p95 / p99 / max, per-shape aggregate, fixture manifest sha (from `docs/fixtures/latency/index.json`), host info (CPU, RAM, macOS version, Ollama version, model digests).
- **Authority:** a new baseline only replaces the prior after explicit sla-steward sign-off. The regression gate always compares against the **most recent signed-off** baseline, never an unsigned overwrite.
- **Invocation** (spec — script may not exist yet; wire it when Wave-2.5 lands):

  ```
  scripts/capture_baseline.sh \
    --runs 3 \
    --shapes warm_multi_turn,voice_mid_session,cold_boot_first_turn,background_interference,concurrent_subagent_dispatch,confirm_gate_interrupt \
    --out docs/fixtures/latency/baselines/$(date +%Y-%m-%d)-$(git rev-parse --short=8 HEAD).json \
    --sign-off "sla-steward: <reason>"
  ```

  The script drives `latency_run_load_shape` for each shape, averages 3 runs, writes the baseline file, and refuses to overwrite an existing one without `--force` **and** a non-empty `--sign-off` argument.

---

## 6. Kind-filter note (analyzer correctness)

`src-tauri/src/memory/db.rs` schema v9 introduced `llm_turns.kind`. Current values are `"ok"` and `"timeout"`; future values will include `"error"` and `"max_tokens"`.

**The analyzer MUST filter `WHERE kind = 'ok'` when computing p95.** Including timeouts inflates the tail artificially (timeouts are capped at the provider ceiling, not the real latency) and including future error/max_tokens sentinels will contaminate the distribution in the other direction. p95 is a property of the successful-response distribution only.

Timeout rate is tracked and reported as a **separate** metric alongside the p95 — not blended into it. A run with healthy p95 but climbing timeout rate is still a failure signal.

---

## 7. Known-incomplete instrumentation (Wave-2.5 gaps)

The harness-builder flagged four gaps. The SLA measurement can still proceed on fixtures, but real-traffic numbers will be partially blind until these close:

**(a) `turn_id` not threaded through `dispatch/mod.rs`** — call sites still use the 5-arg `record()` signature, so `tool_usage.turn_id` is NULL for production traffic. Fixture runs through the harness populate it via `latency_run_fixture`'s explicit scope; ad-hoc user turns do not. Cross-join analytics between `llm_turns` and `tool_usage` must exclude NULL rows until this is fixed.

**(b) Anthropic buffered TTFT placeholder** — `providers/anthropic.rs` currently sets `ttft_ms == duration_ms` for buffered (non-streaming) responses. Treat Anthropic TTFT as a **ceiling**, not a measurement, until true streaming lands. Do not include buffered Anthropic turns in first_token p95.

**(c) `prep_ms` / `critic_ms` not threaded into provider-side `TelemetryEvent`** — these stages are written to the JSONL sink but not to the `TelemetryEvent` struct consumed by the provider adapters. SQL queries against `llm_turns` will not see them; analyzer must cross-reference JSONL for prep/critic slices.

**(d) JSONL sink unbounded** — no rotation policy today. Long harness sessions accumulate the file without a cap. Operators should truncate between baseline captures. Bounded rotation is a prerequisite for baseline runs on shared hardware.

Close any one of these and the SLA coverage tightens; close all four and real-traffic numbers match fixture numbers.

---

## Non-goals

- Not a stress-test spec. QPS, saturation, and adversarial-load budgets live elsewhere.
- Not a fault-injection spec. Network outages, disk-full, provider 5xx patterns are `sunny-test-fault-injector` territory.
- No code in this file. Implementation belongs to the harness-builder, analyzer, and provider owners.
