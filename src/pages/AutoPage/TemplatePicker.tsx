// ─────────────────────────────────────────────────────────────────
// TemplatePicker — modal overlay that lists curated JobTemplates.
//
// Loads via `scheduler_templates_list` (may be absent if R9-3 hasn't
// landed yet — in which case the hardcoded fallback list kicks in).
// Install uses `scheduler_install_template`; if unavailable we fall
// back to `scheduler_add` with the hardcoded job spec.
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, type CSSProperties } from 'react';
import { invokeSafe } from '../../lib/tauri';
import { schedulerAdd } from './api';
import type { AddArgs, JobAction, JobTemplate } from './types';

type Props = {
  readonly onClose: () => void;
  readonly onInstalled: () => void;
};

// ─────────────────────────────────────────────────────────────────
// Hardcoded fallback — mirrors src-tauri/src/scheduler_templates.rs
// ─────────────────────────────────────────────────────────────────

const MORNING_BRIEF_GOAL =
  "It's morning. Call mail_unread_count, calendar_today, and weather_current " +
  "for Sunny's city (look up the location via memory_recall if you don't " +
  'have it, otherwise default to Vancouver). Combine into a single spoken ' +
  "brief under 4 sentences. Start with 'Morning, Sunny' and end with " +
  "'Have a good day.'";

const MIDDAY_INBOX_GOAL =
  'Midday inbox triage. Call mail_unread_count and mail_recent (top 10). ' +
  'Speak a one-sentence overview — counts, priorities, any action items.';

const EVENING_RECAP_GOAL =
  "End of day. Call calendar_today, notes_recent, and review today's " +
  'activity. Write a three-sentence recap of what happened and what matters ' +
  'tomorrow to a new Apple Notes note titled "Daily Recap".';

const COMPETITOR_WATCH_GOAL =
  "Weekly competitor scan. Spawn a researcher sub-agent to search 'Frey " +
  "Market competitors news last week' and 'FounderLink competitors news " +
  "last week', compile a 500-word briefing, write to a note.";

const STOCK_WATCHDOG_GOAL =
  'Quick check: call stock_quote for NVDA. If price crossed 200, speak an ' +
  'alert. Otherwise stay silent.';

const FALLBACK_TEMPLATES: ReadonlyArray<JobTemplate> = [
  {
    id: 'morning-brief',
    title: 'Morning brief',
    description:
      'Mail + calendar + weather combined into one spoken brief at 8 am.',
    schedule_hint: 'Every day at 8:00 am',
    kind: 'Interval',
    every_sec: 86_400,
    action: {
      type: 'AgentGoal',
      data: { goal: MORNING_BRIEF_GOAL, speak_answer: true, write_note: null },
    },
  },
  {
    id: 'midday-inbox',
    title: 'Midday inbox triage',
    description:
      'One-sentence unread-mail overview at noon — counts, priorities, action items.',
    schedule_hint: 'Every day at 12:00 pm',
    kind: 'Interval',
    every_sec: 86_400,
    action: {
      type: 'AgentGoal',
      data: { goal: MIDDAY_INBOX_GOAL, speak_answer: true, write_note: null },
    },
  },
  {
    id: 'evening-recap',
    title: 'Evening recap',
    description:
      "Three-sentence summary of today's events and notes, written to Apple Notes.",
    schedule_hint: 'Every day at 6:00 pm',
    kind: 'Interval',
    every_sec: 86_400,
    action: {
      type: 'AgentGoal',
      data: {
        goal: EVENING_RECAP_GOAL,
        speak_answer: false,
        write_note: 'Daily Recap',
      },
    },
  },
  {
    id: 'competitor-watch',
    title: 'Weekly competitor scan',
    description:
      "Researcher sub-agent pulls last week's news on Frey Market and FounderLink competitors.",
    schedule_hint: 'Every Monday at 9:00 am',
    kind: 'Interval',
    every_sec: 604_800,
    action: {
      type: 'AgentGoal',
      data: {
        goal: COMPETITOR_WATCH_GOAL,
        speak_answer: false,
        write_note: 'Competitor Weekly',
      },
    },
  },
  {
    id: 'stock-watchdog',
    title: 'Stock watchdog (NVDA)',
    description:
      'Every 5 minutes, checks NVDA. Silent unless price crosses 200 — then a spoken alert.',
    schedule_hint: 'Every 5 minutes',
    kind: 'Interval',
    every_sec: 300,
    action: {
      type: 'AgentGoal',
      data: { goal: STOCK_WATCHDOG_GOAL, speak_answer: true, write_note: null },
    },
  },
];

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 4, 10, 0.72)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};

const modalStyle: CSSProperties = {
  width: 'min(640px, 100%)',
  maxHeight: '82vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(6, 14, 22, 0.96)',
  border: '1px solid var(--cyan)',
  boxShadow: '0 0 32px rgba(57, 229, 255, 0.18)',
};

const modalHeaderStyle: CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--line-soft)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const modalTitleStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 13,
  letterSpacing: '0.28em',
  color: 'var(--cyan)',
  fontWeight: 700,
};

const modalBodyStyle: CSSProperties = {
  padding: 16,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const itemStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.04)',
  padding: 12,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};

const itemTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const itemTitleStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 12,
  letterSpacing: '0.16em',
  color: 'var(--ink)',
  fontWeight: 700,
};

const itemDescStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  letterSpacing: '0.04em',
  lineHeight: 1.45,
};

const itemHintStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--amber)',
  letterSpacing: '0.08em',
};

const installBtn = (busy: boolean): CSSProperties => ({
  all: 'unset',
  cursor: busy ? 'wait' : 'pointer',
  padding: '6px 14px',
  border: '1px solid var(--cyan)',
  background: 'rgba(57, 229, 255, 0.18)',
  color: '#fff',
  fontFamily: 'var(--display)',
  fontSize: 10.5,
  letterSpacing: '0.22em',
  fontWeight: 700,
  opacity: busy ? 0.6 : 1,
});

const closeBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 13,
  color: 'var(--ink-dim)',
  padding: '2px 8px',
  border: '1px solid var(--line-soft)',
};

const errorBarStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--red)',
  background: 'rgba(255, 77, 94, 0.08)',
  border: '1px solid var(--red)',
  padding: '8px 12px',
  letterSpacing: '0.06em',
};

// ─────────────────────────────────────────────────────────────────
// Install — prefers the Rust command, falls back to scheduler_add.
// ─────────────────────────────────────────────────────────────────

async function installTemplate(template: JobTemplate): Promise<void> {
  // Try the curated server-side install first. `invokeSafe` returns null on
  // error so we can cleanly detect "command not found" vs "command failed".
  const installed = await invokeSafe('scheduler_install_template', {
    id: template.id,
  });
  if (installed !== null) return;

  // Fallback: add a plain job with the template's action + cadence.
  const action: JobAction = template.action;
  const args: AddArgs =
    template.kind === 'Interval'
      ? {
          title: template.title,
          kind: 'Interval',
          every_sec: template.every_sec ?? 86_400,
          action,
        }
      : {
          title: template.title,
          kind: 'Once',
          at: Math.floor(Date.now() / 1000) + 300,
          action,
        };
  await schedulerAdd(args);
}

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────

export function TemplatePicker({ onClose, onInstalled }: Props) {
  const [templates, setTemplates] = useState<ReadonlyArray<JobTemplate>>(
    FALLBACK_TEMPLATES,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load from Rust; fall through to the hardcoded list on any error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const live = await invokeSafe<JobTemplate[]>('scheduler_templates_list');
      if (cancelled) return;
      if (live !== null && live.length > 0) {
        setTemplates(live);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc-to-close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleInstall = async (template: JobTemplate) => {
    if (busyId !== null) return;
    setBusyId(template.id);
    setErr(null);
    try {
      await installTemplate(template);
      onInstalled();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('install template failed:', e);
      setErr(`Install failed: ${msg}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      style={overlayStyle}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Install job template"
    >
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={modalHeaderStyle}>
          <div style={modalTitleStyle}>ADD FROM TEMPLATE</div>
          <button onClick={onClose} style={closeBtn} aria-label="Close">
            ESC
          </button>
        </div>
        <div style={modalBodyStyle}>
          {err !== null && <div style={errorBarStyle}>{err}</div>}
          {/* Group templates by category */}
          {(() => {
            const grouped = new Map<string, JobTemplate[]>();
            for (const t of templates) {
              const cat = (t as Record<string, unknown>).category as string | undefined ?? 'OTHER';
              if (!grouped.has(cat)) grouped.set(cat, []);
              const grp = grouped.get(cat);
              if (grp) grp.push(t);
            }
            return [...grouped.entries()].map(([cat, group]) => (
              <div key={cat} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                <div style={{
                  fontFamily: 'var(--display)',
                  fontSize: 9, letterSpacing: '0.28em',
                  color: 'var(--cyan)', fontWeight: 700,
                  paddingBottom: 4, borderBottom: '1px solid var(--line-soft)',
                }}>{cat}</div>
                {group.map(t => {
                  const busy = busyId === t.id;
                  const icon = (t as Record<string, unknown>).icon as string | undefined;
                  const summary = (t as Record<string, unknown>).summary as string | undefined;
                  return (
                    <div key={t.id} style={itemStyle}>
                      {icon && (
                        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, marginTop: 2, opacity: 0.75 }}>
                          {icon}
                        </span>
                      )}
                      <div style={itemTextStyle}>
                        <div style={itemTitleStyle}>{t.title}</div>
                        <div style={itemDescStyle}>{summary ?? t.description}</div>
                        <div style={itemHintStyle}>{t.schedule_hint}</div>
                      </div>
                      <button
                        onClick={() => { void handleInstall(t); }}
                        disabled={busy || busyId !== null}
                        style={installBtn(busy)}
                      >
                        {busy ? 'INSTALLING…' : 'INSTALL'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
