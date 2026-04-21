/**
 * AGENT AUDIT tab — every tool call dispatched by every agent run,
 * with redacted input preview, outcome, duration, and confirm trace.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  chipActiveStyle,
  chipBaseStyle,
  emptyStateStyle,
  hintStyle,
  inputStyle,
  sectionStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  severityColor,
} from './styles';
import { fetchEvents, subscribeEvents } from './api';
import type {
  ConfirmAnsweredEvent,
  ConfirmRequestedEvent,
  SecurityEvent,
  ToolCallEvent,
} from './types';

type AgentRow = {
  readonly event: ToolCallEvent;
  readonly confirmRequested?: ConfirmRequestedEvent;
  readonly confirmAnswered?: ConfirmAnsweredEvent;
};

type RiskFilter = 'all' | 'dangerous' | 'standard';
type OkFilter = 'all' | 'ok' | 'fail' | 'pending';

export function AgentAuditTab() {
  const [events, setEvents] = useState<ReadonlyArray<SecurityEvent>>([]);
  const [risk, setRisk] = useState<RiskFilter>('all');
  const [ok, setOk] = useState<OkFilter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const hist = await fetchEvents(800);
      if (alive) setEvents(hist);
    })();
    const p = subscribeEvents(ev => {
      setEvents(prev => [...prev, ev].slice(-2000));
    });
    return () => {
      alive = false;
      void p.then(u => u && u());
    };
  }, []);

  const rows: ReadonlyArray<AgentRow> = useMemo(() => {
    const toolCalls = events.filter((e): e is ToolCallEvent => e.kind === 'tool_call');
    const confirms = events.filter(
      (e): e is ConfirmRequestedEvent => e.kind === 'confirm_requested',
    );
    const answers = events.filter(
      (e): e is ConfirmAnsweredEvent => e.kind === 'confirm_answered',
    );
    // Group by tool-call id.  Later events for the same id overwrite
    // earlier ones so the final verdict wins.
    const map = new Map<string, AgentRow>();
    for (const tc of toolCalls) {
      map.set(tc.id, { event: tc });
    }
    // ConfirmRequested ids are separate from tool-call ids; we match
    // by (tool, requester, nearest timestamp) as a best-effort link.
    for (const cr of confirms) {
      // Pick the tool call closest in time for the same tool/agent.
      let bestId: string | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const [id, row] of map) {
        if (row.event.tool !== cr.tool) continue;
        const delta = Math.abs(row.event.at - cr.at);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestId = id;
        }
      }
      if (bestId) {
        map.set(bestId, { ...map.get(bestId)!, confirmRequested: cr });
      }
    }
    for (const ans of answers) {
      // ConfirmAnswered carries the same id as ConfirmRequested,
      // which we stitched onto its tool call above.
      for (const [id, row] of map) {
        if (row.confirmRequested?.id === ans.id) {
          map.set(id, { ...row, confirmAnswered: ans });
          break;
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.event.at - a.event.at);
  }, [events]);

  const filtered = rows.filter(r => {
    if (risk !== 'all' && ((risk === 'dangerous') !== r.event.dangerous)) return false;
    if (ok === 'ok' && r.event.ok !== true) return false;
    if (ok === 'fail' && r.event.ok !== false) return false;
    if (ok === 'pending' && r.event.ok !== null) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${r.event.tool} ${r.event.agent} ${r.event.input_preview}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <>
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>AGENT AUDIT</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {filtered.length} / {rows.length} shown
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="filter by tool / agent / input…"
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
          {(['all', 'dangerous', 'standard'] as RiskFilter[]).map(r => (
            <button
              key={r}
              onClick={() => setRisk(r)}
              style={risk === r ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
            >
              {r.toUpperCase()}
            </button>
          ))}
          {(['all', 'ok', 'fail', 'pending'] as OkFilter[]).map(o => (
            <button
              key={o}
              onClick={() => setOk(o)}
              style={ok === o ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
            >
              {o.toUpperCase()}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={emptyStateStyle}>
            No tool calls match this filter yet. Run a chat turn — every agent tool
            dispatch (incl. sub-agents) lands here with full context.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {filtered.slice(0, 300).map(row => (
              <AuditRow
                key={row.event.id}
                row={row}
                open={open === row.event.id}
                onToggle={() => setOpen(prev => (prev === row.event.id ? null : row.event.id))}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AuditRow({
  row,
  open,
  onToggle,
}: {
  row: AgentRow;
  open: boolean;
  onToggle: () => void;
}) {
  const { event, confirmRequested, confirmAnswered } = row;
  const color = severityColor(event.severity);
  const okLabel =
    event.ok === true ? 'OK' : event.ok === false ? 'FAIL' : 'PEND';
  const okColor =
    event.ok === true ? 'var(--green)'
    : event.ok === false ? 'var(--red)'
    : 'var(--ink-dim)';
  return (
    <div style={{ border: `1px solid ${color}2a`, background: `${color}08` }}>
      <button
        onClick={onToggle}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: '68px 64px 160px 1fr auto auto auto',
          alignItems: 'center',
          gap: 10,
          padding: '6px 10px',
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'var(--mono)',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>{formatTime(event.at)}</span>
        <span style={severityBadgeStyle(event.severity)}>{event.dangerous ? 'danger' : 'std'}</span>
        <span style={{ color: 'var(--cyan)' }}>{event.tool}</span>
        <span style={{ color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {event.input_preview}
        </span>
        <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>{event.agent}</span>
        <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
          {event.duration_ms !== null ? `${event.duration_ms}ms` : '…'}
        </span>
        <span style={{ color: okColor, fontSize: 10, letterSpacing: '0.18em', fontWeight: 700 }}>
          {okLabel}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: `1px dashed ${color}2a`, padding: '10px 12px', display: 'grid', gap: 6 }}>
          <Field label="tool" value={event.tool} />
          <Field label="agent" value={event.agent} />
          <Field label="id" value={event.id} mono />
          <Field label="risk" value={event.dangerous ? 'dangerous' : 'standard'} />
          <Field label="outcome" value={event.ok === null ? 'pending' : event.ok ? 'ok' : 'fail'} />
          <Field label="duration" value={event.duration_ms !== null ? `${event.duration_ms} ms` : '—'} />
          <Field label="output" value={event.output_bytes !== null ? `${event.output_bytes} bytes` : '—'} />
          <Field label="input (redacted)" value={event.input_preview} mono />
          {confirmRequested && (
            <Field label="confirm preview" value={confirmRequested.preview} mono />
          )}
          {confirmAnswered && (
            <Field
              label="user"
              value={`${confirmAnswered.approved ? 'approved' : 'denied'}${confirmAnswered.reason ? ' — ' + confirmAnswered.reason : ''}`}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--ink-dim)' }}>
        {label.toUpperCase()}
      </span>
      <span
        style={{
          fontFamily: mono ? 'var(--mono)' : 'var(--mono)',
          fontSize: 11,
          color: 'var(--ink)',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function formatTime(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour12: false });
}
