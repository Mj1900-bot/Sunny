/**
 * NETWORK tab — every outbound request with initiator, status, bytes,
 * and per-host rollup.  Phase 1 is observation-only; the "block host"
 * affordance is surfaced but marked as a Phase 2 enforcement hook.
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
  statCardStyle,
  statLabelStyle,
  statValueStyle,
  statsRowStyle,
} from './styles';
import { fetchEvents, subscribeEvents } from './api';
import type { NetRequestEvent, SecurityEvent } from './types';
import { FlowDiagram, type FlowEdge } from './viz';

type HostRollup = {
  readonly host: string;
  readonly count: number;
  readonly bytes: number;
  readonly lastAt: number;
  readonly initiators: ReadonlyArray<string>;
  readonly errors: number;
};

type InitiatorFilter = 'all' | 'agent' | 'non_agent';

export function NetworkTab() {
  const [events, setEvents] = useState<ReadonlyArray<SecurityEvent>>([]);
  const [filter, setFilter] = useState<InitiatorFilter>('all');
  const [query, setQuery] = useState('');

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

  const requests = useMemo<ReadonlyArray<NetRequestEvent>>(() => {
    return events
      .filter((e): e is NetRequestEvent => e.kind === 'net_request')
      // Collapse pre/post events — keep the post (has status+duration).
      .filter((e, _i, arr) => {
        if (e.status === null && e.duration_ms === null) {
          // This is the pre-event. Drop it if we can find a later
          // completed one with the same id.
          return !arr.some(other => other.id === e.id && other !== e && other.duration_ms !== null);
        }
        return true;
      })
      .sort((a, b) => b.at - a.at);
  }, [events]);

  const filtered = requests.filter(r => {
    const isAgent = r.initiator.startsWith('agent:');
    if (filter === 'agent' && !isAgent) return false;
    if (filter === 'non_agent' && isAgent) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${r.host}${r.path_prefix}${r.initiator}${r.method}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const rollup = useMemo<ReadonlyArray<HostRollup>>(() => {
    const map = new Map<string, { count: number; bytes: number; last: number; initiators: Set<string>; errors: number }>();
    for (const r of requests) {
      const cur = map.get(r.host) ?? { count: 0, bytes: 0, last: 0, initiators: new Set(), errors: 0 };
      cur.count += 1;
      cur.bytes += r.bytes ?? 0;
      cur.last = Math.max(cur.last, r.at);
      cur.initiators.add(r.initiator);
      if (r.blocked || (r.status !== null && r.status >= 400)) cur.errors += 1;
      map.set(r.host || '(unknown)', cur);
    }
    return Array.from(map.entries())
      .map(([host, v]) => ({
        host,
        count: v.count,
        bytes: v.bytes,
        lastAt: v.last,
        initiators: Array.from(v.initiators),
        errors: v.errors,
      }))
      .sort((a, b) => b.count - a.count);
  }, [requests]);

  const totalBytes = requests.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const blockedCount = requests.filter(r => r.blocked).length;

  return (
    <>
      {/* Summary stats */}
      <div style={statsRowStyle}>
        <div style={statCardStyle}>
          <span style={statLabelStyle}>TOTAL REQUESTS</span>
          <span style={{ ...statValueStyle, color: 'var(--cyan)' }}>{requests.length}</span>
        </div>
        <div style={statCardStyle}>
          <span style={statLabelStyle}>DISTINCT HOSTS</span>
          <span style={{ ...statValueStyle, color: 'var(--cyan)' }}>{rollup.length}</span>
        </div>
        <div style={statCardStyle}>
          <span style={statLabelStyle}>BYTES IN</span>
          <span style={{ ...statValueStyle, color: 'var(--cyan)' }}>{formatBytes(totalBytes)}</span>
        </div>
        <div style={statCardStyle}>
          <span style={statLabelStyle}>BLOCKED</span>
          <span style={{ ...statValueStyle, color: blockedCount > 0 ? 'var(--red)' : 'var(--green)' }}>
            {blockedCount}
          </span>
        </div>
      </div>

      {/* Flow diagram — initiator → host with byte-proportional ribbons */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>EGRESS FLOW · initiator → host</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>ribbon width ∝ bytes in window</span>
        </div>
        <FlowDiagram edges={deriveFlow(requests)} width={920} height={240} />
      </section>

      {/* Per-host rollup */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>PER-HOST ROLLUP</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>top 20 by request count</span>
        </div>
        {rollup.length === 0 ? (
          <div style={emptyStateStyle}>No outbound egress yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {rollup.slice(0, 20).map(h => (
              <div
                key={h.host}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 80px 100px 160px 80px',
                  gap: 10,
                  padding: '5px 10px',
                  border: '1px solid var(--line-soft)',
                  background: h.errors > 0 ? 'rgba(255, 179, 71, 0.06)' : 'rgba(4, 10, 16, 0.45)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                <span style={{ color: 'var(--ink)' }}>{h.host || '(no host)'}</span>
                <span style={{ color: 'var(--cyan)', textAlign: 'right' }}>{h.count}</span>
                <span style={{ color: 'var(--ink-dim)', textAlign: 'right' }}>{formatBytes(h.bytes)}</span>
                <span style={{ color: 'var(--ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={h.initiators.join(', ')}
                >
                  {h.initiators.slice(0, 2).join(', ')}{h.initiators.length > 2 ? ` +${h.initiators.length - 2}` : ''}
                </span>
                <span
                  style={{
                    color: h.errors > 0 ? 'var(--amber)' : 'var(--green)',
                    textAlign: 'right',
                    fontSize: 10,
                  }}
                >
                  {h.errors > 0 ? `${h.errors} err` : 'ok'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Raw request list */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>REQUESTS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {filtered.length} / {requests.length} shown
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Filter network requests"
            placeholder="filter host / path / initiator…"
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
          {(['all', 'agent', 'non_agent'] as InitiatorFilter[]).map(f => (
            <button
              type="button"
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              style={filter === f ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
            >
              {f.toUpperCase().replace('_', '-')}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={emptyStateStyle}>No matching requests.</div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {filtered.slice(0, 300).map(r => (
              <RequestRow key={`${r.id}-${r.at}`} ev={r} />
            ))}
          </div>
        )}
      </section>

      <section style={{ ...sectionStyle, borderStyle: 'dashed' }}>
        <div style={sectionTitleStyle}>ENFORCEMENT (Phase 2)</div>
        <p style={hintStyle}>
          The Network tab is observation-only in Phase 1. Per-host block / positive
          egress allowlists for agent-initiated requests ship in Phase 2 — see
          <code style={{ marginLeft: 6 }}>docs/SECURITY.md</code> for the roadmap.
          Panic mode already refuses all egress via the shared HTTP client.
        </p>
      </section>
    </>
  );
}

function RequestRow({ ev }: { ev: NetRequestEvent }) {
  const color = ev.blocked
    ? 'var(--red)'
    : ev.status && ev.status >= 400 ? 'var(--amber)'
    : severityColor(ev.severity);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '70px 60px 70px 1fr 110px 70px 80px',
        gap: 10,
        alignItems: 'center',
        padding: '4px 8px',
        border: `1px solid ${color}22`,
        background: `${color}08`,
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>{formatTime(ev.at)}</span>
      <span style={severityBadgeStyle(ev.blocked ? 'crit' : ev.severity)}>{ev.method}</span>
      <span style={{ color: 'var(--cyan)', fontSize: 10 }}>{ev.status ?? '---'}</span>
      <span
        style={{
          color: 'var(--ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={`${ev.host}${ev.path_prefix}`}
      >
        {ev.host}
        <span style={{ color: 'var(--ink-dim)' }}>{ev.path_prefix}</span>
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ev.initiator}
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10, textAlign: 'right' }}>
        {ev.bytes !== null ? formatBytes(ev.bytes) : '—'}
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10, textAlign: 'right' }}>
        {ev.duration_ms !== null ? `${ev.duration_ms}ms` : '…'}
      </span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTime(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Aggregate NetRequest events into (initiator → host) edges with
 * total bytes + count for the FlowDiagram.  Top 12 edges kept; rest
 * drop off so the SVG stays readable.
 */
function deriveFlow(requests: ReadonlyArray<NetRequestEvent>): ReadonlyArray<FlowEdge> {
  const map = new Map<string, { from: string; to: string; bytes: number; count: number }>();
  for (const r of requests) {
    if (r.blocked) continue;
    const from = r.initiator || 'unknown';
    const to = r.host || '(unknown)';
    const key = `${from}→${to}`;
    const cur = map.get(key) ?? { from, to, bytes: 0, count: 0 };
    cur.bytes += r.bytes ?? 0;
    cur.count += 1;
    map.set(key, cur);
  }
  const edges = Array.from(map.values());
  edges.sort((a, b) => b.bytes - a.bytes || b.count - a.count);
  return edges.slice(0, 12);
}
