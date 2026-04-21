import type { AgentStep } from '../../lib/agentLoop';
import type { PlanStep, PlanStepKind } from '../../store/agent';
import { RECENT_KEY, RECENT_MAX } from './constants';

export function loadRecent(): ReadonlyArray<string> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function pushRecent(prev: ReadonlyArray<string>, id: string): ReadonlyArray<string> {
  const filtered = prev.filter(x => x !== id);
  return [id, ...filtered].slice(0, RECENT_MAX);
}

export function fuzzyMatch(query: string, title: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return false;
}

export function scoreTitle(query: string, title: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500;
  const idx = t.indexOf(q);
  if (idx >= 0) return 200 - idx;
  return 1;
}

export function toPlanStep(step: AgentStep): PlanStep {
  // Kind mapping is identity between AgentStep and PlanStep.
  const kind: PlanStepKind = step.kind;
  return {
    id: step.id,
    kind,
    text: step.text,
    toolName: step.toolName,
    at: step.at,
  };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600).toString().padStart(2, '0');
  const mm = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
