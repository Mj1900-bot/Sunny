// Extended hit types for the ⌘K QuickLauncher.
//
// QuickLauncher.tsx already owns MODULES / APPS / AGENT / FILES — this
// module adds the broader "universal command palette" categories:
// TOOLS, MEMORIES, SKILLS, ASK, SETTINGS. Everything here is pure data
// and async fetchers so the component file stays focused on UI +
// keyboard handling.

import { invokeSafe } from '../../lib/tauri';
import { AGENT_TOOL_NAMES } from '../../lib/toolNames';
import {
  searchSettings,
  type SearchEntry,
  type SettingsTabId,
} from '../../pages/SettingsPage/searchIndex';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtendedGroupKind = 'TOOLS' | 'MEMORIES' | 'SKILLS' | 'ASK' | 'SETTINGS';

export type ToolHit = Readonly<{
  kind: 'TOOLS';
  id: string;
  label: string;
  /** The tool name itself — used for "/tool <name>" chat insert. */
  tool: string;
  score: number;
}>;

export type MemoryHit = Readonly<{
  kind: 'MEMORIES';
  id: string;
  label: string;
  /** Prefilled prompt we hand to askSunny on Enter. */
  prompt: string;
  score: number;
}>;

export type SkillHit = Readonly<{
  kind: 'SKILLS';
  id: string;
  label: string;
  description: string;
  score: number;
}>;

export type AskHit = Readonly<{
  kind: 'ASK';
  id: string;
  label: string;
  /** Text after the `?` / `ask ` prefix — the raw question. */
  prompt: string;
  score: number;
}>;

export type SettingsHit = Readonly<{
  kind: 'SETTINGS';
  id: string;
  label: string;
  description: string;
  tab: SettingsTabId;
  score: number;
}>;

export type ExtendedHit = ToolHit | MemoryHit | SkillHit | AskHit | SettingsHit;

// ---------------------------------------------------------------------------
// Limits & constants
// ---------------------------------------------------------------------------

export const MAX_PER_GROUP = 5;
export const ASYNC_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Scoring — shared, identical semantics to QuickLauncher's scoreMatch.
// Kept local so this module is independently testable without leaking
// a private helper out of the component file.
// ---------------------------------------------------------------------------

export function scoreMatch(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = candidate.toLowerCase();

  if (t === q) return 1000;
  if (t.startsWith(q)) return 600 - Math.min(t.length, 100);
  const idx = t.indexOf(q);
  if (idx >= 0) return 400 - idx * 4;

  let i = 0;
  let firstIdx = -1;
  let spread = 0;
  let lastIdx = -1;
  for (let p = 0; p < t.length; p += 1) {
    if (t[p] === q[i]) {
      if (firstIdx === -1) firstIdx = p;
      if (lastIdx !== -1) spread += p - lastIdx - 1;
      lastIdx = p;
      i += 1;
      if (i === q.length) return 200 - firstIdx * 2 - spread;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Ask-prefix parsing. Returns the stripped question if the query looks
// like an explicit "quick ask" (starts with `?` or `ask `), else null.
// ---------------------------------------------------------------------------

export function parseAskQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('?')) {
    const rest = trimmed.slice(1).trim();
    return rest.length > 0 ? rest : null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('ask ')) {
    const rest = trimmed.slice(4).trim();
    return rest.length > 0 ? rest : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Synchronous hit builders — pure functions over the current query.
// ---------------------------------------------------------------------------

export function buildToolHits(query: string): ReadonlyArray<ToolHit> {
  const q = query.trim();
  if (q.length === 0) return [];
  const scored = AGENT_TOOL_NAMES.map(name => ({
    kind: 'TOOLS' as const,
    id: `tool.${name}`,
    label: name,
    tool: name,
    score: scoreMatch(q, name),
  })).filter(h => h.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_PER_GROUP);
}

export function buildAskHits(query: string): ReadonlyArray<AskHit> {
  const q = parseAskQuery(query);
  if (q === null) return [];
  return [
    {
      kind: 'ASK',
      id: `ask.${q}`,
      label: `Ask SUNNY: "${q}"`,
      prompt: q,
      score: 500,
    },
  ];
}

export function buildSettingsHits(query: string): ReadonlyArray<SettingsHit> {
  const q = query.trim();
  if (q.length === 0) return [];
  const entries: ReadonlyArray<SearchEntry> = searchSettings(q, MAX_PER_GROUP);
  return entries.map((e, i) => ({
    kind: 'SETTINGS' as const,
    id: `settings.${e.tab}.${e.label}`,
    label: e.label,
    description: e.description,
    tab: e.tab,
    // searchSettings is already ranked high-to-low; preserve order via
    // a strictly-decreasing surrogate score so our own sort step
    // doesn't reshuffle the tied entries.
    score: 500 - i,
  }));
}

// ---------------------------------------------------------------------------
// Async hit builders — hit the backend for memory + skills. Both are
// defensive: they return [] on error or when running outside Tauri.
// ---------------------------------------------------------------------------

type RawEpisodic = Readonly<{ id: string; text: string; created_at?: number }>;
type RawSkill = Readonly<{ id: string; name: string; description: string }>;

export async function fetchMemoryHits(query: string): Promise<ReadonlyArray<MemoryHit>> {
  const q = query.trim();
  if (q.length === 0) return [];
  const items = await invokeSafe<RawEpisodic[]>('memory_episodic_search', {
    query: q,
    limit: MAX_PER_GROUP,
  });
  if (!items) return [];
  return items.slice(0, MAX_PER_GROUP).map((m, i) => {
    // Single-line summary — kills runaway newlines and excessive whitespace.
    const summary = m.text.replace(/\s+/g, ' ').trim();
    const label = summary.length > 90 ? `${summary.slice(0, 90)}…` : summary;
    return {
      kind: 'MEMORIES' as const,
      id: `mem.${m.id}`,
      label: label.length > 0 ? label : '(empty memory)',
      prompt: `Tell me more about this memory: ${summary}`,
      score: 400 - i,
    };
  });
}

export async function fetchSkillHits(query: string): Promise<ReadonlyArray<SkillHit>> {
  const q = query.trim();
  if (q.length === 0) return [];
  const skills = await invokeSafe<RawSkill[]>('memory_skill_list');
  if (!skills) return [];
  const scored = skills
    .map(s => ({
      kind: 'SKILLS' as const,
      id: `skill.${s.id}`,
      label: s.name,
      description: s.description ?? '',
      score: Math.max(
        scoreMatch(q, s.name),
        // Half-credit a description hit so a skill named "inbox-triage"
        // with description "sort new mail" still surfaces on "mail".
        Math.floor(scoreMatch(q, s.description ?? '') / 2),
      ),
    }))
    .filter(h => h.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_PER_GROUP);
}

// ---------------------------------------------------------------------------
// Settings jump event — QuickLauncher dispatches, SettingsPage listens
// to switch tabs when activated from ⌘K.
// ---------------------------------------------------------------------------

export const SETTINGS_JUMP_EVENT = 'sunny-settings-jump';

export type SettingsJumpDetail = Readonly<{ tab: SettingsTabId }>;

export function dispatchSettingsJump(tab: SettingsTabId): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SettingsJumpDetail>(SETTINGS_JUMP_EVENT, { detail: { tab } }),
  );
}
