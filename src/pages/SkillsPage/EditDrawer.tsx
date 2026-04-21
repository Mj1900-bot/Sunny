import { useMemo, useState } from 'react';
import { Section, Toolbar, ToolbarButton, ProgressRing, relTime } from '../_shared';
import { askSunny } from '../../lib/askSunny';
import type { ProceduralSkill } from './api';
import { getSkillHistory, recordSkillRun, type RunEntry } from './skillHistory';

export function EditDrawer({
  skill, onClose, onSave,
}: {
  skill: ProceduralSkill | null;
  onClose: () => void;
  onSave: (id: string, patch: Partial<ProceduralSkill>) => void | Promise<void>;
}) {
  // The parent remounts this component on a new skill (keyed by id), so
  // we can seed local state straight from props — no sync-in-effect
  // hazard, no stale form values when switching skills.
  const [name, setName] = useState(skill?.name ?? '');
  const [desc, setDesc] = useState(skill?.description ?? '');
  const [trig, setTrig] = useState(skill?.trigger_text ?? '');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  if (!skill) return null;

  const rate = skill.uses_count > 0
    ? (skill.success_count / skill.uses_count) * 100
    : 0;
  const healthTone = rate >= 80 ? 'green' : rate >= 50 ? 'amber' : rate > 0 ? 'red' : 'cyan';

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(skill.id, { name, description: desc, trigger_text: trig });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleTestRun = () => {
    askSunny(
      `Apply the procedural skill "${name}" to what I am doing right now. ` +
      `Skill description: ${desc}. ` +
      (trig ? `It should fire when: ${trig}.` : ''),
      'skills',
    );
    recordSkillRun(skill.id, true);
  };

  return (
    <Section title="EDIT SKILL" right={skill.id.slice(0, 8)}>
      {/* Skill stats header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 12px',
        marginBottom: 12,
        border: '1px solid var(--line-soft)',
        background: 'rgba(57, 229, 255, 0.03)',
        animation: 'fadeSlideIn 200ms ease-out',
      }}>
        <ProgressRing
          progress={skill.uses_count > 0 ? rate / 100 : 0}
          size={42}
          tone={healthTone === 'green' ? 'green' : healthTone === 'amber' ? 'amber' : 'cyan'}
        />
        <div style={{ flex: 1 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
          }}>
            <StatMini label="USES" value={String(skill.uses_count)} color="var(--cyan)" />
            <StatMini label="SUCCESS" value={`${rate.toFixed(0)}%`} color={healthTone === 'green' ? 'var(--green)' : healthTone === 'amber' ? 'var(--amber)' : 'var(--red)'} />
            <StatMini label="LAST USED" value={skill.last_used_at ? relTime(skill.last_used_at) : '—'} color="var(--ink-dim)" />
          </div>
        </div>
      </div>

      {/* Form fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field
          label="NAME"
          value={name}
          onChange={setName}
          placeholder="Descriptive skill name"
          maxLen={100}
        />
        <Field
          label="DESCRIPTION"
          value={desc}
          onChange={setDesc}
          multiline
          placeholder="What does this skill do? Be specific for better AI matching."
          maxLen={500}
        />
        <Field
          label="WHEN TO FIRE"
          value={trig}
          onChange={setTrig}
          multiline
          placeholder="Describe the trigger conditions (e.g., 'when debugging Python code')"
          maxLen={300}
        />
      </div>

      {/* Skill path viewer */}
      {skill.skill_path && (
        <div style={{
          marginTop: 10,
          padding: '6px 10px',
          border: '1px solid var(--line-soft)',
          background: 'rgba(0, 210, 180, 0.04)',
        }}>
          <div style={{
            fontFamily: 'var(--display)',
            fontSize: 8,
            letterSpacing: '0.22em',
            color: 'var(--teal)',
            fontWeight: 700,
            marginBottom: 4,
          }}>
            CODE PATH
          </div>
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink-2)',
            wordBreak: 'break-all',
          }}>
            {skill.skill_path}
          </div>
        </div>
      )}

      {/* History toggle */}
      <div style={{ marginTop: 10 }}>
        <button
          onClick={() => setShowHistory(h => !h)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: 'var(--display)',
            fontSize: 9,
            letterSpacing: '0.22em',
            color: 'var(--cyan)',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{
            transform: showHistory ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            display: 'inline-block',
          }}>▸</span>
          RECENT RUNS
        </button>
        {showHistory && <HistoryList skillId={skill.id} />}
      </div>

      {/* Action buttons */}
      <Toolbar style={{ marginTop: 12 }}>
        <ToolbarButton onClick={submit} tone="cyan" disabled={busy}>
          {busy ? 'SAVING…' : 'SAVE'}
        </ToolbarButton>
        <ToolbarButton tone="violet" onClick={handleTestRun}>
          TEST RUN
        </ToolbarButton>
        <ToolbarButton onClick={onClose} disabled={busy}>CANCEL · ESC</ToolbarButton>
      </Toolbar>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatMini({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{
        fontFamily: 'var(--display)',
        fontSize: 7,
        letterSpacing: '0.22em',
        color: 'var(--ink-dim)',
        fontWeight: 700,
      }}>{label}</span>
      <span style={{
        fontFamily: 'var(--mono)',
        fontSize: 13,
        fontWeight: 700,
        color,
      }}>{value}</span>
    </div>
  );
}

function HistoryList({ skillId }: { skillId: string }) {
  const history = useMemo(() => getSkillHistory(skillId).slice(-5).reverse(), [skillId]);

  if (history.length === 0) {
    return (
      <div style={{
        marginTop: 6,
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-dim)',
        fontStyle: 'italic',
      }}>
        No local run history yet.
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      animation: 'fadeSlideIn 150ms ease-out',
    }}>
      {history.map((r: RunEntry, i: number) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 8,
            padding: '3px 8px',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            borderLeft: `2px solid ${r.ok ? 'var(--green)' : 'var(--red)'}`,
            background: r.ok ? 'rgba(125, 255, 154, 0.03)' : 'rgba(255, 77, 94, 0.03)',
          }}
        >
          <span style={{ color: 'var(--ink-dim)' }}>
            {new Date(r.ts * 1000).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
            {r.ok ? 'OK' : 'FAIL'}
          </span>
        </div>
      ))}
    </div>
  );
}

function Field({
  label, value, onChange, multiline, placeholder, maxLen,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  maxLen?: number;
}) {
  const Cmp = multiline ? 'textarea' : 'input';
  const remaining = maxLen ? maxLen - value.length : null;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
      }}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
          color: 'var(--ink-2)', fontWeight: 700,
        }}>{label}</span>
        {remaining !== null && (
          <span style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            color: remaining < 20 ? 'var(--amber)' : 'var(--ink-dim)',
          }}>
            {remaining}
          </span>
        )}
      </div>
      <Cmp
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          const next = e.target.value;
          if (maxLen && next.length > maxLen) return;
          onChange(next);
        }}
        rows={multiline ? 3 : undefined}
        placeholder={placeholder}
        style={{
          all: 'unset', boxSizing: 'border-box',
          padding: '6px 10px',
          fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink)',
          border: '1px solid var(--line-soft)',
          background: 'rgba(0, 0, 0, 0.3)',
          minHeight: multiline ? 56 : undefined,
        }}
      />
    </label>
  );
}
