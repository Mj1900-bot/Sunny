/**
 * RouterLog — "Recent matches" timeline + "Why didn't a skill fire?" probe.
 *
 * Renders two adjacent surfaces the SkillsPage uses to explain routing:
 *
 *   1. Recent matches: newest-first list of the last 20 routing decisions
 *      the agent loop made. Each row surfaces timestamp, goal (truncated),
 *      top-1 matched skill, cosine score, fired/skipped state, and for
 *      skipped rows the machine-readable reason.
 *
 *   2. Probe: an input field the user types a hypothetical goal into. The
 *      component computes a cheap token-overlap similarity against every
 *      skill's trigger + description and ranks the top 3. This is NOT the
 *      same metric the router uses (that's a trained embedding cosine),
 *      but it gives the user enough signal to reason about shape: "this
 *      goal shares 40% of its tokens with 'summarize inbox' — no wonder
 *      the router didn't pick it; the embedding score is probably ~0.4,
 *      below 0.85."
 *
 * Both surfaces live in one component so the SkillsPage only mounts one
 * cell — they share the list of skills + the same visual language.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { Section, Chip, ScrollList, relTime } from '../_shared';
import {
  useSkillRouterLog,
  skipReasonLabel,
  type RouterLogEntry,
} from '../../store/skillRouterLog';
import type { ProceduralSkill } from './api';

type Props = {
  readonly skills: ReadonlyArray<ProceduralSkill>;
};

// Numeric threshold agentLoop uses for System-1 execution (EXECUTE_THRESHOLD).
// Duplicated here rather than imported to keep the SkillsPage folder free of
// executor dependencies; if this drifts a new test will catch it.
const ROUTER_THRESHOLD = 0.85;

export function RouterLog({ skills }: Props) {
  const entries = useSkillRouterLog((s) => s.entries);
  const clear = useSkillRouterLog((s) => s.clear);
  const [probe, setProbe] = useState('');

  // Derived: top-3 skills for the probe, by cheap token overlap.
  const probeMatches = useMemo(() => {
    const q = probe.trim();
    if (q.length < 3) return [] as ReadonlyArray<ProbeMatch>;
    return rankSkillsByOverlap(q, skills).slice(0, 3);
  }, [probe, skills]);

  return (
    <Section
      title="ROUTER · MATCH LOG"
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={rightMeta}>
            {entries.length} recent · threshold {ROUTER_THRESHOLD}
          </span>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => clear()}
              style={clearButtonStyle}
              title="Clear the local router match log"
            >
              CLEAR
            </button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* --- Recent matches list ----------------------------------- */}
        <div>
          <div style={sectionLabel}>RECENT MATCHES</div>
          {entries.length === 0 ? (
            <div style={emptyRow}>
              No router decisions yet — run a goal and come back.
            </div>
          ) : (
            <ScrollList maxHeight={220}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {entries.map((e) => (
                  <RouterRow key={e.id} entry={e} />
                ))}
              </div>
            </ScrollList>
          )}
        </div>

        {/* --- Why-didn't-a-skill-fire probe -------------------------- */}
        <div>
          <div style={sectionLabel}>WHY DIDN'T A SKILL FIRE?</div>
          <div style={probeHint}>
            Paste a goal to preview how it would rank against your skills (token overlap —
            not the router's embedding score, but a useful proxy for shape).
          </div>
          <input
            type="text"
            value={probe}
            onChange={(evt) => setProbe(evt.target.value)}
            placeholder="e.g. summarize unread emails from this week"
            aria-label="Probe a hypothetical goal"
            autoComplete="off"
            spellCheck={false}
            style={probeInputStyle}
          />
          {probe.trim().length >= 3 && (
            <div style={{ marginTop: 8 }}>
              {probeMatches.length === 0 ? (
                <div style={emptyRow}>
                  No skills overlap with that goal. Either your library is sparse for this
                  shape, or a new skill is about to be born.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {probeMatches.map((m, i) => (
                    <ProbeRow key={m.skill.id} rank={i + 1} match={m} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Router row
// ---------------------------------------------------------------------------

function RouterRow({ entry }: { entry: RouterLogEntry }) {
  const tone: 'green' | 'amber' | 'red' | 'cyan' = entry.fired
    ? 'green'
    : entry.skipReason === 'below-threshold'
      ? 'amber'
      : entry.skipReason === 'skill-error'
        ? 'red'
        : 'cyan';
  const scoreLabel =
    entry.score !== null ? entry.score.toFixed(2) : '—';
  const statusLabel = entry.fired
    ? 'FIRED'
    : `SKIP · ${skipReasonLabel(entry.skipReason ?? 'no-skill').toUpperCase()}`;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '72px 1fr auto auto',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        borderLeft: `2px solid ${BORDER_FOR_TONE[tone]}`,
        background: 'rgba(6, 14, 22, 0.35)',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-2)',
      }}
      title={`Goal: ${entry.goal}`}
    >
      <span style={{ color: 'var(--ink-dim)' }}>{relTime(Math.floor(entry.at / 1000))}</span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--ink)',
        }}
      >
        {truncate(entry.goal, 64)}
        {entry.matchedSkillName && (
          <span style={{ color: 'var(--ink-dim)' }}> → {entry.matchedSkillName}</span>
        )}
      </span>
      <span
        style={{
          color:
            entry.score !== null && entry.score >= entry.threshold
              ? 'var(--green)'
              : entry.score !== null && entry.score >= 0.5
                ? 'var(--amber)'
                : 'var(--ink-dim)',
          fontWeight: 600,
        }}
      >
        {scoreLabel}
      </span>
      <Chip tone={tone}>{statusLabel}</Chip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probe row + similarity helper
// ---------------------------------------------------------------------------

type ProbeMatch = {
  readonly skill: ProceduralSkill;
  readonly score: number;
  /** Shared tokens — used to explain WHY the skill ranks here. */
  readonly sharedTokens: ReadonlyArray<string>;
};

function ProbeRow({ rank, match }: { rank: number; match: ProbeMatch }) {
  const tone: 'green' | 'amber' | 'red' =
    match.score >= 0.5 ? 'green' : match.score >= 0.25 ? 'amber' : 'red';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '24px 1fr auto',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        border: `1px solid ${BORDER_FOR_TONE[tone]}`,
        background: 'rgba(6, 14, 22, 0.45)',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-2)',
      }}
    >
      <span style={rankBadge}>{rank}</span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {match.skill.name}
        </div>
        {match.sharedTokens.length > 0 && (
          <div style={{ color: 'var(--ink-dim)', marginTop: 2 }}>
            shared: {match.sharedTokens.slice(0, 6).join(', ')}
          </div>
        )}
      </div>
      <span
        style={{
          color: tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'var(--red)',
          fontWeight: 600,
        }}
        title={`Jaccard-like token overlap (router uses embedding cosine; threshold ${ROUTER_THRESHOLD})`}
      >
        {match.score.toFixed(2)}
      </span>
    </div>
  );
}

/** Normalise + tokenise: lowercase, strip punctuation, drop stop words and very short tokens. */
function tokenize(text: string): ReadonlyArray<string> {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const raw = cleaned.split(/\s+/).filter((t) => t.length >= 3);
  return raw.filter((t) => !STOP_WORDS.has(t));
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'about', 'what',
  'when', 'where', 'which', 'then', 'than', 'have', 'has', 'had', 'are',
  'was', 'were', 'been', 'being', 'will', 'would', 'could', 'should',
  'into', 'onto', 'your', 'their', 'our', 'my', 'me', 'you', 'he', 'she',
  'it', 'they', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'is', 'be',
  'a', 'an', 'or', 'not', 'no', 'do', 'does', 'did', 'so', 'some',
]);

function rankSkillsByOverlap(
  goal: string,
  skills: ReadonlyArray<ProceduralSkill>,
): ReadonlyArray<ProbeMatch> {
  const goalTokens = new Set(tokenize(goal));
  if (goalTokens.size === 0) return [];
  const ranked: ProbeMatch[] = [];
  for (const s of skills) {
    const corpus = `${s.name} ${s.description} ${s.trigger_text}`;
    const skillTokens = new Set(tokenize(corpus));
    if (skillTokens.size === 0) continue;
    const shared: string[] = [];
    for (const t of goalTokens) if (skillTokens.has(t)) shared.push(t);
    if (shared.length === 0) continue;
    // Jaccard-like: |A ∩ B| / |A ∪ B|. Bounded [0, 1]. Fresh arrays, no mutation of inputs.
    const unionSize = goalTokens.size + skillTokens.size - shared.length;
    const score = unionSize > 0 ? shared.length / unionSize : 0;
    ranked.push({ skill: s, score, sharedTokens: shared });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const BORDER_FOR_TONE: Record<'green' | 'amber' | 'red' | 'cyan', string> = {
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  cyan: 'var(--line-soft)',
};

const sectionLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.24em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
  marginBottom: 6,
};

const rightMeta: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.06em',
};

const emptyRow: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  padding: '8px 10px',
  border: '1px dashed var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.3)',
};

const probeHint: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  lineHeight: 1.5,
  marginBottom: 6,
};

const probeInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.35)',
  outline: 'none',
};

const rankBadge: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--cyan)',
  border: '1px solid var(--line-soft)',
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'rgba(57, 229, 255, 0.06)',
};

const clearButtonStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  color: 'var(--ink-dim)',
  background: 'transparent',
  border: '1px solid var(--line-soft)',
  padding: '3px 8px',
  cursor: 'pointer',
};
