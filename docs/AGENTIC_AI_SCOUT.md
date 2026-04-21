# AGENTIC AI SCOUT REPORT — R18-C
*Compiled 2026-04-19 by Tech Scout agent*

---

## Project Summaries

### 1. AutoGPT / BabyAGI / AgentGPT — The Original Wave

The 2023 originals proved the concept (chain LLM calls, give it tools, let it loop) but hit walls quickly: token spirals, infinite loops, weak self-correction. AutoGPT's own team discovered that external vector databases were overkill — brute-force similarity over 100k bits is sub-millisecond, so they stripped the vector index entirely. BabyAGI 2 (2024) introduced a "functionz" store: a database of runnable functions with metadata the agent can load, update, and invoke dynamically. Key lesson: **task decomposition is load-bearing; without it models hallucinate progress**.

**Key techniques**: priority-queue task lists, recursive goal expansion, external memory as a flat store rather than a vector DB.

*Source: [AutoGPT vs BabyAGI 2025](https://sider.ai/blog/ai-tools/autogpt-vs-babyagi-which-ai-agent-fits-your-workflow-in-2025), [Tom's Hardware critique](https://www.tomshardware.com/news/autonomous-agents-new-big-thing)*

---

### 2. OpenHands (OpenDevin) — Coding Agent Platform

ICLR 2025 paper. Core abstraction is an **event-stream** where every Agent Action and Environment Observation is appended chronologically. Inspired by CodeAct, agents emit executable Python/bash rather than natural language, then observe structured results. The Software Agent SDK (Nov 2025) adds Pydantic-validated action schemas, an Action–Execution–Observation triad with policy enforcement at the dispatcher layer, multi-LLM routing, and pluggable memory. Surpassed 50k GitHub stars early 2025.

**Key techniques**: typed action schemas validated before execution; event-sourced history (not prompt stuffing); policy dispatch layer that rejects bad actions before any tool fires; multi-LLM routing per task type.

*Source: [OpenHands paper](https://arxiv.org/abs/2407.16741), [SDK paper](https://arxiv.org/html/2511.03690v1)*

---

### 3. crewAI — Role-Based Multi-Agent Orchestration

Production-grade Python framework. Agents have **defined roles, backstories, goal statements, and tool allowlists** — not just "an LLM with tools." A Manager agent distributes tasks; Worker agents execute. Memory system: shared short-term (within crew run), long-term (cross-run via SQLite), entity memory. Sequential, parallel, and conditional execution modes. A dedicated Planner agent emits a step-by-step plan before the crew starts; reasoning agents then reflect on objectives before acting.

**Key techniques**: role + backstory prompt scoping; hierarchical delegation (manager enforces; workers cannot talk peer-to-peer without going through manager); entity memory that persists named entities across runs.

*Source: [crewAI GitHub](https://github.com/crewAIInc/crewAI), [AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-frameworks/crewai.html)*

---

### 4. Microsoft AutoGen → Microsoft Agent Framework

AutoGen v0.4 (Jan 2025): asynchronous, event-driven architecture; agents communicate via typed async messages; cross-language (Python + .NET). Ships Magentic-One, a generalist team of agents (orchestrator + browser + file + code agents). AutoGen is now in **maintenance mode** — Microsoft folded it into the Microsoft Agent Framework combining AutoGen with Semantic Kernel. Key insight: **decoupled async message passing scales better than synchronous conversation turns**.

**Key techniques**: async message bus; typed inter-agent messages; built-in debugging/tracing hooks; Magentic-One's specialist topology (each sub-agent owns one capability domain).

*Source: [AutoGen v0.4 blog](https://www.microsoft.com/en-us/research/articles/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/), [Migration guide](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)*

---

### 5. LangGraph — Graph-Based Stateful Workflows

Treats agent workflows as directed graphs: **nodes are processing steps, edges are control flow, and a centralized StateGraph holds all shared context**. Supports cycles (necessary for retry/reflection loops), conditional edges (route on agent output), and parallel fan-out/fan-in (scatter-gather). Durable execution: agents can persist through failures and resume from the exact last node. Human-in-the-loop is a first-class citizen: interrupt before any node, inspect/edit state, then continue.

**Key techniques**: persistent StateGraph; conditional edge routing; durable checkpointing; interrupt gates before dangerous actions; scatter-gather parallelism.

*Source: [LangGraph docs](https://www.langchain.com/langgraph), [State machine review](https://neurlcreators.substack.com/p/langgraph-agent-state-machine-review)*

---

### 6. Anthropic Computer Use + Claude Agent SDK

Computer Use (Oct 2024): screenshot → action loop driving real GUI via coordinate clicks, keyboard, and scroll. Agent SDK (March 2025): wraps Computer Use + tool execution into a production harness. Key pattern for long-running agents: **Initializer agent** sets environment on first run; **Coding agent** makes incremental progress each session; clear artifacts (todo file, git commits) bridge sessions. Agent Skills (2026): dynamically loaded folders of instructions + scripts, giving the model new capabilities without retraining.

**Key techniques**: initializer + incremental-worker split for multi-session continuity; end-to-end browser testing by the agent itself (dramatically improved bug-finding); dynamically loaded Skills packages; 1M context window enabling long uninterrupted runs.

*Source: [Building agents with Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk), [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)*

---

### 7. Manus — Context Engineering in Production

Went from 0 to $100M ARR in 8 months (acquired by Meta Dec 2025 for ~$2–3B). Technically a wrapper around Claude 3.5/3.7 + Qwen inside an isolated cloud VM. The real innovation is **context engineering**: constantly rewriting a `todo.md` pushes the global plan into the model's recent attention window, defeating "lost-in-the-middle" drift on 50+ tool-call tasks. Later refined: a Planner sub-agent emits a structured Plan object injected only when needed, saving ~30% tokens versus constant file rewriting. Dynamic tool injection during a run is discouraged — stable tool sets perform better.

**Key techniques**: plan-at-end-of-context (anti-drift); structured Planner sub-agent instead of flat todo file; per-task isolated VM sandboxes; multi-agent with isolated context windows per role (user sees only Executor, Planner runs separately).

*Source: [Manus context engineering blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [Technical investigation](https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f)*

---

### 8. Reflexion — Verbal Reinforcement Learning

NeurIPS 2023, still widely referenced in 2025 production systems. Three-model loop: **Actor** generates action, **Evaluator** scores it, **Self-Reflection** model produces a verbal critique stored in episodic memory. On the next attempt, past reflections are prepended as context. Achieves 91% pass@1 on HumanEval. Key trade-off: requires multiple LLM calls per step; works best when failures are cheap and retries bounded.

**Key techniques**: verbal critique as gradient signal; episodic reflection buffer; critique–retry loop with bounded iterations.

*Source: [Reflexion paper](https://arxiv.org/abs/2303.11366), [NeurIPS 2023 OpenReview](https://openreview.net/forum?id=vAElhFcKW6)*

---

### 9. Society of Thought / Debate Patterns

Google 2025 research: advanced reasoning models internally simulate multi-agent debates — diverse perspectives, personality traits, domain expertise — improving accuracy on complex reasoning. DeepSeek-R1 and QwQ-32B develop this without explicit instruction. Multi-agent debate frameworks (PhishDebate etc.) improve interpretability by requiring agents to justify conclusions before committing. The "maker-checker" pattern (one agent generates, another validates) is now standard in enterprise deployments.

**Key techniques**: structured debate before commitment; maker-checker validation; persona-diverse sub-agents for broader perspective coverage.

*Source: [VentureBeat on debate](https://venturebeat.com/orchestration/ai-models-that-simulate-internal-debate-dramatically-improve-accuracy-on), [MarkTechPost patterns](https://www.marktechpost.com/2025/08/09/9-agentic-ai-workflow-patterns-transforming-ai-agents-in-2025/)*

---

## Top 5 Patterns SUNNY Should Adopt Next

### P1 — Structured Planner Sub-Agent with Plan-at-End Injection

**What**: A dedicated Planner role that emits a typed Plan object (not a prose todo), re-injected at the tail of every system prompt to keep goals in the model's active attention window. Manus proved this defeats goal-drift on long (50+ tool-call) tasks; SUNNY's current HTN decomposer is close but doesn't re-anchor the plan mid-run.

**Where**: `/Users/sunny/Sunny Ai/src/lib/agentLoop.ts` (step 2 HTN decompose + step 8 ReAct loop), `/Users/sunny/Sunny Ai/src-tauri/src/tools/` (new `plan_execute` tool refinement).

**Effort**: Moderate. **Risk**: Low.

---

### P2 — Durable Checkpointing / Session Continuity

**What**: Persist each AgentStep to SQLite as it completes, so a crashed or aborted run can resume from the last committed step rather than restarting. Anthropic's harness shows this is critical for tasks exceeding one context window. LangGraph makes it a first-class node property.

**Where**: `/Users/sunny/Sunny Ai/src/lib/agentLoop.ts` (append each step to an `agent_runs` SQLite table), `/Users/sunny/Sunny Ai/src-tauri/src/memory.rs` (new `agent_checkpoint` table).

**Effort**: Moderate. **Risk**: Low.

---

### P3 — Policy Dispatch Layer (Pre-Execution Action Validation)

**What**: OpenHands validates every Action via Pydantic schema and a policy enforcer *before* the tool fires — not just a `confirmDangerous` flag after the fact. This means typed contracts, allowlist enforcement, and sandbox-scope checks happen at a single chokepoint. SUNNY's constitution gate is conceptually similar but fires later in the stack.

**Where**: `/Users/sunny/Sunny Ai/src/lib/agentLoop.ts` step 8d (ii–iii), `/Users/sunny/Sunny Ai/src-tauri/src/tools/mod.rs`.

**Effort**: Moderate. **Risk**: Low.

---

### P4 — Verbal Critique Buffer (Reflexion Loop)

**What**: After each failed or suboptimal tool result, a lightweight Critic call writes a 1–3 sentence verbal critique to SUNNY's episodic memory. On the next retry or next run against the same goal class, past critiques are prepended. SUNNY already has `agent_reflect` but it fires once at the end; Reflexion fires per step on failure.

**Where**: `/Users/sunny/Sunny Ai/src/lib/agentLoop.ts` step 8 (after tool_result, before next iteration), `/Users/sunny/Sunny Ai/docs/MEMORY.md`.

**Effort**: Low. **Risk**: Low.

---

### P5 — Specialist Sub-Agent Topology (Magentic-One style)

**What**: Replace SUNNY's 7-role Society of Mind with a tighter topology where each sub-agent owns exactly one capability domain (Browser, Files, Code, Research, Memory) with its own tool allowlist and model selection. The Orchestrator never executes tools directly — it only assigns. This reduces role-bleed and makes each specialist independently testable.

**Where**: `/Users/sunny/Sunny Ai/src/lib/agentLoop.ts` step 7 (Society dispatch), `/Users/sunny/Sunny Ai/docs/AGENT.md`.

**Effort**: Moderate–High. **Risk**: Medium (requires rethinking role configs).

---

## What SUNNY Already Does Well

- **Hybrid memory** (episodic + semantic + procedural SQLite FTS5) is ahead of most open-source frameworks, which bolt on a vector DB as an afterthought.
- **Speculative drafting for voice** has no equivalent in AutoGPT/crewAI/OpenHands — it is a genuine SUNNY differentiator.
- **Constitution gate + critic review before dangerous tools** is structurally equivalent to LangGraph's HITL interrupt — SUNNY just implemented it earlier and in Rust.
- **Composite tools** (`deep_research`, `plan_execute`, `council_decide`) are essentially Magentic-One topologies, already wired.
- **Prompt caching** (Anthropic) and **query expansion** are production features most open-source frameworks treat as optional.

---

## Head-Scratchers (Things We Could Copy But Probably Shouldn't)

- **Isolated VM per task (Manus)**: Powerful for untrusted code, but SUNNY runs on the user's own Mac and the threat model is different. A Tauri-level process sandbox is sufficient; spawning VMs adds latency and complexity with no trust benefit.
- **Cross-language agent interop (AutoGen .NET + Python)**: SUNNY is already a coherent Rust + TypeScript stack. Adding Python agent interop would fracture the runtime boundary.
- **LangGraph as a dependency**: LangGraph's StateGraph is excellent but it is a Python library. Rewriting SUNNY's Rust agent loop in Python or bridging across FFI to get LangGraph's patterns would cost more than implementing the patterns natively.

---

## Competitive Positioning

| Dimension | SUNNY | OpenHands | crewAI | Manus |
|---|---|---|---|---|
| Memory depth | SQLite FTS5 multi-tier | Pluggable (file/vector) | Short + long-term | File-based |
| Voice | Speculative TTS | None | None | None |
| GUI integration | Tauri native HUD | Web UI only | CLI/API | Cloud VM |
| Runs locally | Yes (Ollama primary) | Yes | Yes | Cloud-only |
| Session continuity | Partial | Event-stream replay | None | VM persistence |
| Context anti-drift | Manual | Event stream | Sequential tasks | Plan-at-tail |
| Tool safety | Constitution + critic | Policy dispatcher | Role allowlists | Stable tool sets |

SUNNY's clearest edge: **local-first + native HUD + voice**. No other framework in this survey ships all three. The gap to close: session continuity across context windows and per-step verbal critique — both achievable in under 400 lines of Rust/TypeScript.

---

*Research sources consolidated in section citations above.*
