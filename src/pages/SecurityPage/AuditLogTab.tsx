/**
 * AUDIT LOG tab — full ring-buffer view + export to JSONL.
 *
 * The file-backed `events.jsonl` is append-only and rotates at 10 MB.
 * This tab fetches the last ~2000 events from the in-memory ring and
 * offers an "export everything" button that copies the full JSONL to
 * a user-chosen path.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  chipActiveStyle,
  chipBaseStyle,
  emptyStateStyle,
  hintStyle,
  inputStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  severityColor,
} from './styles';
import { exportAudit, fetchEvents, subscribeEvents } from './api';
import type { SecurityEvent, Severity } from './types';

type SeverityFilter = 'all' | Severity;

const KIND_LABEL: Record<SecurityEvent['kind'], string> = {
  tool_call: 'tool',
  confirm_requested: 'confirm?',
  confirm_answered: 'confirm!',
  secret_read: 'secret',
  net_request: 'net',
  permission_change: 'perm',
  launch_agent_delta: 'plist',
  login_item_delta: 'login',
  unsigned_binary: 'unsigned',
  prompt_injection: 'inject',
  canary_tripped: 'CANARY',
  tool_rate_anomaly: 'anomaly',
  integrity_status: 'integrity',
  file_integrity_change: 'fim',
  panic: 'PANIC',
  panic_reset: 'release',
  notice: 'note',
};

export function AuditLogTab() {
  const [events, setEvents] = useState<ReadonlyArray<SecurityEvent>>([]);
  const [sevFilter, setSevFilter] = useState<SeverityFilter>('all');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<SecurityEvent['kind'] | 'all'>('all');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const hist = await fetchEvents(2000);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events
      .filter(ev => {
        if (kindFilter !== 'all' && ev.kind !== kindFilter) return false;
        if (sevFilter !== 'all') {
          const sev = severityOf(ev);
          if (sev !== sevFilter) return false;
        }
        if (q) {
          const hay = JSON.stringify(ev).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .slice()
      .reverse();
  }, [events, sevFilter, kindFilter, query]);

  const onExport = async () => {
    const home = (window as unknown as { __HOME?: string }).__HOME ?? '/Users/sunny';
    const dst = `${home}/Desktop/sunny-security-audit-${Date.now()}.jsonl`;
    const bytes = await exportAudit(dst);
    setToast(bytes ? `exported ${bytes} bytes → ${dst}` : 'nothing to export yet');
    window.setTimeout(() => setToast(null), 5000);
  };

  return (
    <>
      {/* Screen-reader live region — announces new event count without visual noise. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {filtered.length} of {events.length} events
      </div>
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>AUDIT LOG</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {filtered.length} / {events.length} shown · ring buffer &amp; JSONL at
            <code style={{ marginLeft: 6 }}>~/.sunny/security/events.jsonl</code>
          </span>
          <button type="button" style={primaryBtnStyle} onClick={() => void onExport()}>
            EXPORT JSONL
          </button>
        </div>

        {toast && (
          <div
            style={{
              marginBottom: 10,
              padding: '6px 10px',
              border: '1px solid var(--cyan)',
              background: 'rgba(57, 229, 255, 0.10)',
              color: 'var(--cyan)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
            }}
          >
            {toast}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search audit events"
            placeholder="search any field…"
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
          {(['all', 'info', 'warn', 'crit'] as SeverityFilter[]).map(s => (
            <button
              type="button"
              key={s}
              onClick={() => setSevFilter(s)}
              aria-pressed={sevFilter === s}
              style={sevFilter === s ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button
            type="button"
            onClick={() => setKindFilter('all')}
            aria-pressed={kindFilter === 'all'}
            style={kindFilter === 'all' ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
          >
            ALL
          </button>
          {(Object.keys(KIND_LABEL) as SecurityEvent['kind'][]).map(k => (
            <button
              type="button"
              key={k}
              onClick={() => setKindFilter(k)}
              aria-pressed={kindFilter === k}
              style={kindFilter === k ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={emptyStateStyle}>No events match the filter.</div>
        ) : (
          <div style={{ display: 'grid', gap: 2 }}>
            {filtered.slice(0, 500).map((ev, i) => (
              <AuditRow key={i} ev={ev} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AuditRow({ ev }: { ev: SecurityEvent }) {
  const sev = severityOf(ev);
  const color = severityColor(sev);
  const body = compactBody(ev);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '70px 80px 80px 1fr',
        gap: 8,
        padding: '3px 8px',
        border: `1px solid ${color}22`,
        background: `${color}06`,
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
      }}
    >
      <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>{formatTime(ev.at)}</span>
      <span style={severityBadgeStyle(sev)}>{sev}</span>
      <span style={{ color: 'var(--cyan)', fontSize: 10 }}>{KIND_LABEL[ev.kind]}</span>
      <span
        style={{
          color: 'var(--ink-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={body}
      >
        {body}
      </span>
    </div>
  );
}

function severityOf(ev: SecurityEvent): Severity {
  switch (ev.kind) {
    case 'panic': return 'crit';
    case 'panic_reset':
    case 'confirm_requested': return 'warn';
    case 'confirm_answered': return ev.approved ? 'info' : 'warn';
    case 'secret_read': return 'info';
    default: return (ev as { severity: Severity }).severity ?? 'info';
  }
}

function compactBody(ev: SecurityEvent): string {
  switch (ev.kind) {
    case 'tool_call':
      return `${ev.agent} → ${ev.tool} · ${ev.input_preview}`;
    case 'net_request':
      return `${ev.method} ${ev.host}${ev.path_prefix} · ${ev.initiator} · ${ev.status ?? '—'}${ev.bytes ? ` · ${ev.bytes}B` : ''}`;
    case 'confirm_requested':
      return `${ev.requester} → ${ev.tool}: ${ev.preview}`;
    case 'confirm_answered':
      return `${ev.approved ? 'approved' : 'denied'}${ev.reason ? ' — ' + ev.reason : ''}`;
    case 'secret_read':
      return `${ev.provider} (${ev.caller})`;
    case 'permission_change':
      return `${ev.key}: ${ev.previous ?? '?'} → ${ev.current}`;
    case 'launch_agent_delta':
      return `${ev.change} · ${ev.path}`;
    case 'login_item_delta':
      return `${ev.change} · ${ev.name}`;
    case 'unsigned_binary':
      return `${ev.path} · ${ev.initiator} · ${ev.reason}`;
    case 'prompt_injection':
      return `${ev.source} · ${ev.signals.join(', ')}${ev.excerpt ? ' — ' + ev.excerpt : ''}`;
    case 'canary_tripped':
      return `→ ${ev.destination} · ${ev.context}`;
    case 'tool_rate_anomaly':
      return `${ev.tool} rate ${ev.rate_per_min.toFixed(0)}/min · baseline ${ev.baseline_per_min.toFixed(1)} · z=${ev.z_score.toFixed(1)}`;
    case 'integrity_status':
      return `${ev.key}: ${ev.status} · ${ev.detail}`;
    case 'file_integrity_change':
      return `${ev.path} · ${ev.prev_sha256 ? ev.prev_sha256.slice(0, 8) : 'new'} → ${ev.curr_sha256.slice(0, 8)}`;
    case 'panic':
      return ev.reason;
    case 'panic_reset':
      return `by ${ev.by}`;
    case 'notice':
      return `${ev.source}: ${ev.message}`;
    default:
      return JSON.stringify(ev);
  }
}

function formatTime(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour12: false });
}
