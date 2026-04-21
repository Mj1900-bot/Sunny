import type { InsightKind } from '../../store/insights';
import type { EpisodicKind, Tab } from './types';

export const SEARCH_DEBOUNCE_MS = 220;
export const LIST_LIMIT = 200;
export const SEARCH_LIMIT = 80;

export const TABS: ReadonlyArray<{ id: Tab; label: string; hotkey: string }> = [
  { id: 'episodic', label: 'EPISODIC', hotkey: '1' },
  { id: 'semantic', label: 'SEMANTIC', hotkey: '2' },
  { id: 'procedural', label: 'PROCEDURAL', hotkey: '3' },
  { id: 'graph', label: 'GRAPH', hotkey: '4' },
  { id: 'tools', label: 'TOOLS', hotkey: '5' },
  { id: 'insights', label: 'INSIGHTS', hotkey: '6' },
  { id: 'history', label: 'HISTORY', hotkey: '7' },
];

export const KIND_BADGE: Record<EpisodicKind, { label: string; color: string }> = {
  user: { label: 'USER', color: 'var(--cyan)' },
  agent_step: { label: 'RUN', color: 'var(--green)' },
  tool_call: { label: 'TOOL', color: 'var(--cyan)' },
  perception: { label: 'PERCEPT', color: 'var(--amber)' },
  note: { label: 'NOTE', color: 'var(--ink)' },
  reflection: { label: 'REFLECT', color: 'var(--violet)' },
};

export const INSIGHT_KIND_META: Record<InsightKind, { label: string; color: string }> = {
  skill_fired: { label: 'SKILL', color: 'var(--green)' },
  skill_synthesized: { label: 'LEARNED', color: 'var(--green)' },
  introspect_direct: { label: 'DIRECT', color: 'var(--cyan)' },
  introspect_clarify: { label: 'CLARIFY', color: 'var(--amber)' },
  introspect_caveat: { label: 'CAVEAT', color: 'var(--ink-dim)' },
  memory_lesson: { label: 'LESSON', color: 'var(--violet)' },
  constitution_block: { label: 'BLOCKED', color: 'var(--red)' },
};
