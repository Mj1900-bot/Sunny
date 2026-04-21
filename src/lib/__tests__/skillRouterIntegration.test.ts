/**
 * System-1 skill-router integration test (sprint-8 δ).
 *
 * Validates end-to-end that when the context pack surfaces a `MatchedSkill`
 * with cosine score ≥ EXECUTE_THRESHOLD (0.85) AND a valid recipe, `runAgent`
 * short-circuits the ReAct loop and executes the recipe directly — no LLM
 * round-trip, final answer sourced from the recipe's `answer` step.
 *
 * This is the payoff for embedding-backed procedural memory. Without this
 * test, regressions in the router branch would silently fall through to
 * the LLM loop and we'd only catch them by watching model spend go up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks must be declared BEFORE the module-under-test is imported so vitest
// can hoist them and they apply to the module graph that `agentLoop` pulls
// in at import time.
// ---------------------------------------------------------------------------

// Tauri bridge — every invokeSafe/invoke call becomes a no-op. `isTauri=false`
// also makes `invokeSafe` short-circuit to `null` internally, but we still
// stub the exports to the shapes agentLoop expects.
vi.mock('../tauri', () => ({
  isTauri: false,
  invoke: vi.fn(async () => null),
  invokeSafe: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

// Context pack: return a pack whose `matched_skills[0]` is a high-scoring
// hit with an `answer`-only recipe. The recipe avoids any tool dispatch so
// the test doesn't need to stand up the full tool registry — it only
// validates the router branch + runSkill's `answer`-step path.
const ANSWER_TEXT = 'skill-routed answer for goal: {{$goal}}';
const MOCK_SKILL = {
  id: 'sk_router_test_1',
  name: 'router-integration-skill',
  description: 'fake skill used to validate the System-1 router',
  trigger_text: 'test',
  skill_path: '/tmp/fake/path',
  uses_count: 0,
  success_count: 0,
  last_used_at: null,
  created_at: Date.now(),
  recipe: {
    steps: [{ kind: 'answer', text: ANSWER_TEXT }],
  },
};

vi.mock('../contextPack', () => ({
  buildContextPack: vi.fn(async () => ({
    memory: {
      goal: 'test',
      semantic: [],
      recent_episodic: [],
      matched_episodic: [],
      skills: [MOCK_SKILL],
      matched_skills: [{ skill: MOCK_SKILL, score: 0.9 }],
      stats: {
        episodic_count: 0,
        semantic_count: 0,
        procedural_count: 1,
        oldest_episodic_secs: null,
        newest_episodic_secs: null,
      },
      used_embeddings: true,
    },
    world: null,
  })),
  renderSystemPromptWithReport: vi.fn(() => ({
    prompt: '',
    budgetTrimmed: false,
    trimNotes: [],
  })),
}));

// Pre-run helpers: the router check happens AFTER introspection & planner,
// so we short-circuit both. `introspectGoal => null` means "proceed to
// main loop", `maybeDecompose => null` means "don't split".
vi.mock('../introspect', () => ({
  introspectGoal: vi.fn(async () => null),
}));
vi.mock('../planner', () => ({
  maybeDecompose: vi.fn(async () => null),
}));

// Constitution: allow everything; no verify rewrite. The router path also
// calls `gateToolCall` inside runSkill for `answer`-only recipes that's
// never reached, but we stub it defensively.
vi.mock('../constitution', () => ({
  loadAndRenderConstitution: vi.fn(async () => ({
    prompt: '',
    values: [],
  })),
  gateToolCall: vi.fn(async () => ({ allowed: true })),
  parseConstitutionValues: vi.fn(() => []),
  verifyAnswer: vi.fn(() => ({ ok: true })),
  CONSTITUTION_BLOCK_REPLY: 'blocked',
}));

// Critic / society dispatcher — irrelevant for the router fast-path but
// must resolve without real IPC.
vi.mock('../critic', () => ({
  reviewDangerousAction: vi.fn(async () => ({ approve: true, reason: '' })),
}));
vi.mock('../society/dispatcher', () => ({
  pickRole: vi.fn(async () => ({ role: null })),
  societyEnabled: vi.fn(() => false),
}));

// Reflection writes to memory at end-of-run; stub so nothing real happens.
vi.mock('../reflect', () => ({
  reflectOnRun: vi.fn(async () => null),
}));

// Insights store — track the pushInsight calls so we can assert the
// router-level "trust indicator" fired with the score.
const mockPushInsight = vi.fn();
vi.mock('../../store/insights', () => ({
  pushInsight: (...args: unknown[]) => mockPushInsight(...args),
}));

// ---------------------------------------------------------------------------
// Now import the module under test. Order matters: mocks above must be
// registered first so this import resolves to the stubbed graph.
// ---------------------------------------------------------------------------

import { runAgent, type ChatFn } from '../agentLoop';

// Shared spy for the chat backend. Every test asserts this was NOT called,
// because the router should short-circuit before reaching the LLM loop.
const chatSpy: ChatFn = vi.fn(async () => {
  throw new Error(
    'chat() was invoked — router did not short-circuit as expected',
  );
});

describe('runAgent — System-1 skill-router integration', () => {
  beforeEach(() => {
    mockPushInsight.mockClear();
    (chatSpy as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits the LLM loop when a matched skill scores ≥ 0.85', async () => {
    const result = await runAgent({
      goal: 'test',
      chat: chatSpy,
      maxSteps: 4,
    });

    // The chat backend must never be called — the router should have
    // bypassed the loop entirely.
    expect(chatSpy).not.toHaveBeenCalled();

    // Run completed cleanly via System-1.
    expect(result.status).toBe('done');

    // Final answer came from the recipe's `answer` step with template
    // substitution applied ({{$goal}} -> "test").
    expect(result.finalAnswer).toBe('skill-routed answer for goal: test');

    // Trust indicator: the router pushed a `skill_fired` insight with the
    // cosine score in the payload. This is the UX signal that tells the
    // user "SUNNY used a learned skill" rather than an opaque LLM turn.
    const routerInsight = mockPushInsight.mock.calls.find(
      call =>
        call[0] === 'skill_fired' &&
        typeof call[1] === 'string' &&
        call[1].includes('System-1 router fired'),
    );
    expect(routerInsight).toBeDefined();
    const payload = routerInsight?.[3] as { score: number; source: string };
    expect(payload.score).toBeCloseTo(0.9, 5);
    expect(payload.source).toBe('skill-router');
  });

  it('emits a plan step and a final message step from the recipe', async () => {
    const seen: string[] = [];
    const result = await runAgent({
      goal: 'test',
      chat: chatSpy,
      onStep: step => {
        seen.push(step.kind);
      },
    });

    // Plan step from runSkill + message step from the `answer` recipe item.
    expect(seen).toContain('plan');
    expect(seen).toContain('message');
    expect(result.status).toBe('done');
  });
});
