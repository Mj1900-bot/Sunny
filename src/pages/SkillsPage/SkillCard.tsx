import { useCallback, useMemo, useState } from 'react';
import { Chip, Toolbar, ToolbarButton, ProgressRing, relTime, Sparkline } from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import type { ProceduralSkill } from './api';
import { recordSkillRun, getSkillHistory, successRateSeries } from './skillHistory';
import {
  computeTrustClass,
  validateRecipe,
  type TrustClass,
  type ValidationResult,
} from '../../lib/skillExecutor';

/**
 * Inspect a raw recipe blob for a `capabilities` string array. Mirrors the
 * tolerance of `parseRecipe`: anything malformed reads as "absent" (legacy
 * full-access) rather than throwing — we don't want a UI crash on a
 * corrupted row. Returns the distinct tool names on success, `null` when
 * the field is missing/invalid (render as "unscoped").
 */
function readCapabilities(raw: unknown): ReadonlyArray<string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const caps = (raw as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(caps)) return null;
  const names: string[] = [];
  for (const c of caps) {
    if (typeof c !== 'string' || c.length === 0) return null;
    if (!names.includes(c)) names.push(c);
  }
  return names;
}

/** Auto-generate category tags from skill name. */
function autoTags(name: string): ReadonlyArray<string> {
  const lower = name.toLowerCase();
  const tags: string[] = [];
  if (lower.includes('code') || lower.includes('debug') || lower.includes('refactor')) tags.push('CODE');
  if (lower.includes('write') || lower.includes('draft') || lower.includes('edit')) tags.push('WRITE');
  if (lower.includes('search') || lower.includes('find') || lower.includes('look')) tags.push('SEARCH');
  if (lower.includes('analyze') || lower.includes('check') || lower.includes('review')) tags.push('ANALYZE');
  if (lower.includes('mail') || lower.includes('email') || lower.includes('message')) tags.push('COMMS');
  if (lower.includes('schedule') || lower.includes('calendar') || lower.includes('remind')) tags.push('PLAN');
  if (lower.includes('file') || lower.includes('folder') || lower.includes('download')) tags.push('FILES');
  if (tags.length === 0) tags.push('GENERAL');
  return tags;
}

const TAG_COLORS: Record<string, string> = {
  CODE: 'var(--teal)',
  WRITE: 'var(--gold)',
  SEARCH: 'var(--cyan)',
  ANALYZE: 'var(--violet)',
  COMMS: 'var(--pink)',
  PLAN: 'var(--amber)',
  FILES: 'var(--green)',
  GENERAL: 'var(--ink-dim)',
};

/** Map trust class → tone + label. "unknown" gets a muted look so it
 *  doesn't draw the eye away from trusted/flaky signals. */
const TRUST_STYLE: Record<TrustClass, { tone: 'green' | 'amber' | 'red' | 'dim'; label: string; title: string }> = {
  fresh:   { tone: 'amber', label: 'FRESH',   title: 'Never run — run it once to start building trust.' },
  trusted: { tone: 'green', label: 'TRUSTED', title: 'High success rate across repeated runs.' },
  flaky:   { tone: 'red',   label: 'FLAKY',   title: 'Low success rate — recipe may need attention.' },
  unknown: { tone: 'dim',   label: 'UNKNOWN', title: 'Not enough runs to judge reliability yet.' },
};

/** Map validation outcome → tone + label + tooltip. The tooltip tells the
 *  user which specific tool references are stale, which is the most common
 *  failure mode for a synthesized recipe. */
function validationBadge(v: ValidationResult): {
  tone: 'green' | 'amber' | 'red';
  label: string;
  title: string;
} {
  if (v.valid) {
    return { tone: 'green', label: 'VALID', title: 'All tool refs and argument shapes check out.' };
  }
  const shapeIssue = v.issues.find(i => i.kind === 'recipe_shape');
  if (shapeIssue) {
    return { tone: 'red', label: 'INVALID', title: shapeIssue.message };
  }
  if (v.missingTools.length > 0) {
    return {
      tone: 'amber',
      label: 'STALE',
      title: `Missing tool${v.missingTools.length === 1 ? '' : 's'}: ${v.missingTools.join(', ')}`,
    };
  }
  // Shape OK, every tool resolves, but some input shapes mismatch — treat
  // as invalid since the recipe would fail at dispatch time.
  return {
    tone: 'red',
    label: 'INVALID',
    title: v.issues.map(i => i.message).join('\n'),
  };
}

export function SkillCard({
  skill, onDelete, onEdit, onShare,
}: {
  skill: ProceduralSkill;
  onDelete: () => void;
  onEdit: () => void;
  /** Sprint-13 η — user clicked SHARE (⇗). Parent owns the modal and the
   *  pubkey resolver so every card doesn't have to re-fetch trust state. */
  onShare?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rate = skill.uses_count > 0 ? (skill.success_count / skill.uses_count) * 100 : 0;
  const healthTone = rate >= 80 ? 'green' : rate >= 50 ? 'amber' : rate > 0 ? 'red' : 'cyan';
  const history = getSkillHistory(skill.id);
  const series = successRateSeries(history);
  const tags = autoTags(skill.name);

  // Trust class is pure-derived from telemetry; no memo needed — useMemo
  // here is just to keep the JSX slim.
  const trust = useMemo(() => computeTrustClass(skill), [skill]);
  const trustMeta = TRUST_STYLE[trust];

  // Validation is re-run on demand via the "VALIDATE NOW" button. We also
  // run it once on mount so the badge reflects current tool-registry state
  // without the user having to click. A bump counter forces a fresh
  // `validateRecipe` call by changing the `useMemo` dep.
  const [validationNonce, setValidationNonce] = useState(0);
  const validation = useMemo<ValidationResult | null>(() => {
    if (skill.recipe === undefined || skill.recipe === null) return null;
    return validateRecipe(skill.recipe);
    // validationNonce forces re-computation when the user clicks "Validate Now".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.recipe, skill.id, validationNonce]);
  const validationMeta = validation ? validationBadge(validation) : null;
  const revalidate = useCallback(() => {
    setValidationNonce(n => n + 1);
  }, []);

  // Capability scope indicator (sprint-10 δ / κ v9 #3). Derived directly
  // from the recipe blob so the UI reflects what the executor will
  // actually enforce, not a separate piece of state that could drift.
  const capabilities = useMemo(() => readCapabilities(skill.recipe), [skill.recipe]);
  const scopeMeta = useMemo<{
    tone: 'green' | 'amber';
    label: string;
    title: string;
  } | null>(() => {
    if (skill.recipe === undefined || skill.recipe === null) return null;
    if (capabilities === null) {
      return {
        tone: 'amber',
        label: 'UNSCOPED',
        title: 'Legacy recipe with no capability list — can call any registered tool (full-access default).',
      };
    }
    const n = capabilities.length;
    return {
      tone: 'green',
      label: `SCOPED (${n} tool${n === 1 ? '' : 's'})`,
      title: n === 0
        ? 'Answer-only recipe — no tool calls permitted.'
        : `Can only call: ${capabilities.join(', ')}`,
    };
  }, [skill.recipe, capabilities]);

  const handleRun = () => {
    // Fire and record result asynchronously; askSunny returns void in UI context.
    askSunny(
      `Apply the procedural skill "${skill.name}" to what I am doing right now. ` +
      `Skill description: ${skill.description}. ` +
      (skill.trigger_text ? `It should fire when: ${skill.trigger_text}.` : ''),
      'skills',
    );
    recordSkillRun(skill.id, true);
  };

  const handleCopy = async () => {
    const lines = [
      skill.name,
      '',
      skill.description,
      '',
      skill.trigger_text ? `When: ${skill.trigger_text}` : '',
      skill.skill_path ? `Path: ${skill.skill_path}` : '',
      '',
      `Uses: ${skill.uses_count} · Success: ${skill.success_count} (${skill.uses_count > 0 ? `${rate.toFixed(0)}%` : '—'})`,
      skill.last_used_at ? `Last used: ${new Date(skill.last_used_at).toLocaleString()}` : '',
    ].filter(Boolean);
    const ok = await copyToClipboard(lines.join('\n'));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDeleteClick = () => {
    if (confirmDelete) {
      onDelete();
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(true);
    window.setTimeout(() => setConfirmDelete(false), 3000);
  };

  return (
    <div
      className="skill-card-hover"
      style={{
        border: `1px solid ${healthTone === 'red' ? 'rgba(255, 77, 94, 0.35)' : 'var(--line-soft)'}`,
        background: 'rgba(6, 14, 22, 0.5)',
        backdropFilter: 'blur(4px)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        position: 'relative',
        overflow: 'hidden',
        animation: 'fadeSlideIn 250ms ease-out',
      }}
    >
      {/* Shimmer overlay on hover (CSS-driven) */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${healthTone === 'red' ? 'var(--red)' : 'var(--cyan)'}66, transparent)`,
          opacity: 0.5,
        }}
      />

      {/* Header: name + progress ring + sparkline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ProgressRing
          progress={skill.uses_count > 0 ? rate / 100 : 0}
          size={36}
          tone={healthTone === 'green' ? 'green' : healthTone === 'amber' ? 'amber' : healthTone === 'red' ? 'red' : 'cyan'}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={skill.name}
            style={{
              fontFamily: 'var(--label)', fontSize: 14, fontWeight: 600, color: 'var(--ink)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >{skill.name}</div>
          {/* Category tags */}
          <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
            {tags.map(tag => (
              <span
                key={tag}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 8,
                  letterSpacing: '0.16em',
                  fontWeight: 700,
                  color: TAG_COLORS[tag] ?? 'var(--ink-dim)',
                  border: `1px solid ${TAG_COLORS[tag] ?? 'var(--line-soft)'}`,
                  padding: '1px 5px',
                  background: 'rgba(6, 14, 22, 0.6)',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <Chip tone={healthTone}>{skill.uses_count === 0 ? 'NEW' : `${rate.toFixed(0)}%`}</Chip>
        {series.length >= 2 && (
          <Sparkline
            values={series}
            width={56}
            height={20}
            tone={healthTone === 'green' ? 'green' : healthTone === 'amber' ? 'amber' : healthTone === 'red' ? 'red' : 'cyan'}
            filled
          />
        )}
      </div>

      {/* Trust + validation badges. Only render when we have a synthesized
          recipe to validate OR when the skill has been run enough to derive
          a meaningful trust class. For pure-prose skills (no recipe) we
          still show the trust pill so the user understands the signal. */}
      {(validationMeta || scopeMeta || trust !== 'unknown' || skill.uses_count === 0) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip tone={trustMeta.tone} title={trustMeta.title}>{trustMeta.label}</Chip>
          {scopeMeta && (
            <Chip tone={scopeMeta.tone} title={scopeMeta.title}>
              {scopeMeta.tone === 'green' ? '🔒 ' : '⚠️ '}{scopeMeta.label}
            </Chip>
          )}
          {validationMeta && (
            <Chip tone={validationMeta.tone} title={validationMeta.title}>
              {validationMeta.label}
            </Chip>
          )}
          {validationMeta && validation && !validation.valid && validation.missingTools.length > 0 && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                color: 'var(--ink-dim)',
                letterSpacing: '0.04em',
              }}
              title={validation.missingTools.join(', ')}
            >
              missing: {validation.missingTools.slice(0, 2).join(', ')}
              {validation.missingTools.length > 2 ? `, +${validation.missingTools.length - 2}` : ''}
            </span>
          )}
        </div>
      )}

      {/* Description */}
      <div style={{
        fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
        lineHeight: 1.5, marginTop: 2,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{skill.description}</div>

      {/* Meta stats row */}
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4,
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--cyan)' }}>◈</span> {skill.uses_count} uses
        </span>
        {history.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: 'var(--amber)' }}>◇</span> {history.length} local
          </span>
        )}
        {skill.last_used_at && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 6px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(57, 229, 255, 0.04)',
          }}>
            <span style={{ color: 'var(--green)' }}>▪</span>
            {relTime(skill.last_used_at)}
          </span>
        )}
        {skill.skill_path && <span title={skill.skill_path} style={{ color: 'var(--teal)' }}>⬡ code</span>}
      </div>

      {/* Trigger text */}
      {skill.trigger_text && (
        <div style={{
          marginTop: 4, padding: '4px 8px',
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)',
          border: '1px dashed var(--line-soft)', fontStyle: 'italic',
          background: 'rgba(57, 229, 255, 0.02)',
        }}>when: {skill.trigger_text.slice(0, 100)}</div>
      )}

      {/* Actions toolbar */}
      <Toolbar style={{ marginTop: 6 }}>
        <ToolbarButton onClick={onEdit} tone="cyan">EDIT</ToolbarButton>
        <ToolbarButton onClick={() => { void handleCopy(); }} tone="gold">{copied ? 'COPIED' : 'COPY'}</ToolbarButton>
        <ToolbarButton tone="violet" onClick={handleRun}>RUN THIS</ToolbarButton>
        {/* Sprint-13 η — SHARE signed bundle. Disabled for unsigned skills
            (there's nothing to export with provenance) and when the parent
            didn't wire `onShare`. The ⇗ glyph is deliberate: matches the
            macOS share metaphor without borrowing the iOS square-with-arrow
            which renders inconsistently across webviews. */}
        {onShare && (
          <ToolbarButton
            tone="teal"
            onClick={onShare}
            disabled={!skill.signature || !skill.signer_fingerprint}
            title={
              skill.signature
                ? 'Export this signed skill to clipboard or file'
                : 'Only signed skills can be shared (edit → save to sign)'
            }
            aria-label={`Share signed skill ${skill.name}`}
          >
            ⇗ SHARE
          </ToolbarButton>
        )}
        {validation && (
          <ToolbarButton
            tone="teal"
            onClick={revalidate}
            title="Re-check tool refs and argument shapes against the current registry"
          >
            VALIDATE NOW
          </ToolbarButton>
        )}
        <ToolbarButton
          tone="red"
          onClick={handleDeleteClick}
        >
          {confirmDelete ? 'CONFIRM?' : 'DELETE'}
        </ToolbarButton>
      </Toolbar>
    </div>
  );
}
