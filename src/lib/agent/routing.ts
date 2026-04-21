// ---------------------------------------------------------------------------
// System-1 skill router and Agent Society dispatcher.
//
// runSkillRouter: checks the context pack for a high-confidence skill match
//   and either returns a terminal AgentRunResult (done/aborted) or null to
//   fall through to the LLM loop (System-2).
//
// runSocietyDispatch: picks a specialist role for the LLM loop when Agent
//   Society is enabled. Returns null (generalist) if disabled or on error.
// ---------------------------------------------------------------------------

import { invokeSafe } from '../tauri';
import { runSkill, recordSkillUse, EXECUTE_THRESHOLD } from '../skillExecutor';
import { pushInsight } from '../../store/insights';
import {
  recordSkillRouterDecision,
  type RouterMatchCandidate,
  type SkipReason,
} from '../../store/skillRouterLog';
import { pickRole, societyEnabled } from '../society/dispatcher';
import type { RoleSpec } from '../society/roles';
import type { ContextPack } from '../contextPack';
import type { AgentRunOptions, AgentRunResult } from './types';
import { fireReflection } from './utils';

// ---------------------------------------------------------------------------
// System-1 router
// ---------------------------------------------------------------------------

/**
 * Attempt to satisfy the goal with a skill recipe (System-1 path).
 *
 * Returns a terminal `AgentRunResult` when the skill succeeded or was
 * aborted by the user. Returns `null` to fall through to the LLM loop on:
 *   - embeddings disabled
 *   - no high-confidence match
 *   - no recipe on the matched skill
 *   - skill execution error (logs + falls through so System-2 gets a chance)
 */
export async function runSkillRouter(
  opts: AgentRunOptions,
  contextPack: ContextPack | null,
  abortedResult: () => AgentRunResult,
): Promise<AgentRunResult | null> {
  const signal = opts.signal;
  const topSkill = contextPack?.memory?.matched_skills?.[0];

  // Snapshot up to 3 top candidates so SkillsPage can show the scoring
  // landscape without re-running embeddings. Cheap and works for both
  // skipped and fired paths.
  const topCandidates: ReadonlyArray<RouterMatchCandidate> = (
    contextPack?.memory?.matched_skills ?? []
  )
    .slice(0, 3)
    .map((m): RouterMatchCandidate => ({
      skillId: m.skill.id,
      skillName: m.skill.name,
      score: m.score,
      hasRecipe: m.skill.recipe !== undefined && m.skill.recipe !== null,
    }));

  // Observability: log the router decision so we can grep `[skill-router]`
  // in the HUD console and see WHY System-1 did or didn't fire.
  const routerSkipReason: SkipReason | null =
    !contextPack?.memory?.used_embeddings
      ? 'embeddings-disabled'
      : !topSkill
        ? 'no-skill'
        : topSkill.score < EXECUTE_THRESHOLD
          ? 'below-threshold'
          : topSkill.skill.recipe === undefined || topSkill.skill.recipe === null
            ? 'no-recipe'
            : null;

  if (routerSkipReason !== null) {
    const topScore = topSkill ? topSkill.score.toFixed(3) : 'n/a';
    const topName = topSkill?.skill.name ?? 'none';
    console.info(
      `[skill-router] skipped reason=${routerSkipReason} top_skill=${topName} top_score=${topScore} threshold=${EXECUTE_THRESHOLD}`,
    );
    recordSkillRouterDecision({
      goal: opts.goal,
      matchedSkillName: topSkill?.skill.name ?? null,
      score: topSkill?.score ?? null,
      threshold: EXECUTE_THRESHOLD,
      fired: false,
      skipReason: routerSkipReason,
      topMatches: topCandidates,
    });
    return null;
  }

  // All conditions met — fire System-1.
  if (signal?.aborted) return abortedResult();

  console.info(
    `[skill-router] fired skill=${topSkill!.skill.name} score=${topSkill!.score.toFixed(3)} reason=threshold-hit threshold=${EXECUTE_THRESHOLD}`,
  );
  recordSkillRouterDecision({
    goal: opts.goal,
    matchedSkillName: topSkill!.skill.name,
    score: topSkill!.score,
    threshold: EXECUTE_THRESHOLD,
    fired: true,
    skipReason: null,
    topMatches: topCandidates,
  });
  pushInsight(
    'skill_fired',
    `System-1 router fired: "${topSkill!.skill.name}"`,
    `similarity ${topSkill!.score.toFixed(2)} ≥ ${EXECUTE_THRESHOLD} — bypassing LLM`,
    {
      skillId: topSkill!.skill.id,
      skillName: topSkill!.skill.name,
      score: topSkill!.score,
      threshold: EXECUTE_THRESHOLD,
      source: 'skill-router',
    },
  );

  const skillResult = await runSkill({
    goal: opts.goal,
    skill: topSkill!.skill,
    signal,
    onStep: opts.onStep,
    confirmDangerous: opts.confirmDangerous,
  });

  if (skillResult && (skillResult.status === 'done' || skillResult.status === 'aborted')) {
    if (skillResult.status === 'done') {
      void recordSkillUse(topSkill!.skill.id, true);
      void invokeSafe('memory_episodic_add', {
        kind: 'agent_step',
        text: `goal: ${opts.goal}\nanswer: ${skillResult.finalAnswer.slice(0, 400)}`,
        tags: ['run', 'done', 'skill', topSkill!.skill.name],
        meta: {
          steps: skillResult.steps.length,
          skill_id: topSkill!.skill.id,
          skill_name: topSkill!.skill.name,
          score: topSkill!.score,
          system: 1,
          ts: Date.now(),
        },
      });
      fireReflection(opts.goal, skillResult.steps, skillResult.finalAnswer, 'done');
    } else {
      // Aborted by user mid-skill: still a "use" but not a success.
      void recordSkillUse(topSkill!.skill.id, false);
    }
    return skillResult;
  }

  // skillResult === null (no recipe) or status === 'error': fall through to
  // System-2. Log and record — failed invocation counts against success rate.
  if (skillResult?.status === 'error') {
    console.warn(
      `[agentLoop] skill "${topSkill!.skill.name}" failed; falling back to LLM loop. Reason: ${skillResult.finalAnswer}`,
    );
    void recordSkillUse(topSkill!.skill.id, false);
    recordSkillRouterDecision({
      goal: opts.goal,
      matchedSkillName: topSkill!.skill.name,
      score: topSkill!.score,
      threshold: EXECUTE_THRESHOLD,
      fired: false,
      skipReason: 'skill-error',
      topMatches: topCandidates,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Agent Society dispatch
// ---------------------------------------------------------------------------

/**
 * Pick a specialist role for the LLM loop (Agent Society).
 * Returns `null` when society is disabled, on sub-goals, or on any error
 * (fail-safe to generalist).
 */
export async function runSocietyDispatch(
  opts: AgentRunOptions,
  effectiveGoal: string,
  contextPack: ContextPack | null,
): Promise<RoleSpec | null> {
  if (!societyEnabled() || opts.isSubGoal) return null;
  try {
    const dispatch = await pickRole({
      goal: effectiveGoal,
      contextPack,
      signal: opts.signal,
    });
    return dispatch.role;
  } catch (err) {
    console.debug('[agentLoop] society dispatch failed, using generalist:', err);
    return null;
  }
}
