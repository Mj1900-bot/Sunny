/**
 * Security OVERVIEW — high-end live monitor.
 *
 * Layout (top to bottom):
 *   - Big threat gauge + headline + bucket cards (AGENT / NET / PERM / HOST).
 *   - Sparkline trio: tool calls/min, egress bytes/min, events/min.
 *   - 60-minute attack timeline (severity-banded bar).
 *   - Canary + integrity status strip.
 *   - Top egress hosts (bytes).
 *   - Live event feed (last 40) with quick actions.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  DISPLAY_FONT,
  dangerBtnStyle,
  emptyStateStyle,
  hintStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  severityColor,
  statCardStyle,
  statLabelStyle,
  statValueStyle,
} from './styles';
import {
  fetchCanaryStatus,
  fetchIntegrityGrid,
  fetchPolicy,
  fetchSummary,
  panic,
  panicReset,
  subscribeEvents,
  subscribeSummary,
} from './api';
import type {
  CanaryStatus,
  EnforcementPolicy,
  IntegrityGrid,
  SecurityEvent,
  Summary,
} from './types';
import { EventBreakdown, HostFlow, PostureGrade, Sparkline, ThreatGauge, TimelineBar, type TimelineCell } from './viz';

const EMPTY_SUMMARY: Summary = {
  severity: 'ok', agent: 'ok', net: 'ok', perm: 'ok', host: 'ok',
  panic_mode: false,
  counts: {
    events_window: 0, tool_calls_window: 0, net_requests_window: 0,
    warn_window: 0, crit_window: 0, egress_bytes_window: 0, anomalies_window: 0,
  },
  threat_score: 0,
  minute_events: new Array(60).fill(0),
  minute_tool_calls: new Array(60).fill(0),
  minute_net_bytes: new Array(60).fill(0),
  top_hosts: [],
  updated_at: 0,
};

export function OverviewTab() {
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [feed, setFeed] = useState<ReadonlyArray<SecurityEvent>>([]);
  const [canary, setCanary] = useState<CanaryStatus | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityGrid | null>(null);
  const [policy, setPolicy] = useState<EnforcementPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await fetchSummary();
      const c = await fetchCanaryStatus();
      const ig = await fetchIntegrityGrid();
      const p = await fetchPolicy();
      if (!alive) return;
      setSummary(s);
      setCanary(c);
      setIntegrity(ig);
      setPolicy(p);
    })();
    // Re-fetch canary + integrity + policy every 20s so the strips
    // stay fresh without needing dedicated event types.
    const poll = window.setInterval(async () => {
      const c = await fetchCanaryStatus();
      const ig = await fetchIntegrityGrid();
      const p = await fetchPolicy();
      if (!alive) return;
      setCanary(c);
      setIntegrity(ig);
      setPolicy(p);
    }, 20_000);
    const unsubs: Array<Promise<() => void>> = [
      subscribeSummary(s => setSummary(s)),
      subscribeEvents(ev => {
        setFeed(prev => [ev, ...prev].slice(0, 80));
      }),
    ];
    return () => {
      alive = false;
      window.clearInterval(poll);
      unsubs.forEach(p => void p.then(u => u && u()));
    };
  }, []);

  const timelineCells: TimelineCell[] = useMemo(() => {
    // Stitch warn / crit counts onto the minute-event array by
    // walking the recent feed and stamping their minute index.
    // The feed covers the most recent events; for minutes with no
    // observed feed entries we just report the raw count from the
    // summary (severity unknown).
    const cells: TimelineCell[] = summary.minute_events.map(v => ({
      events: v, warn: 0, crit: 0,
    }));
    const now = Math.floor(Date.now() / 1000);
    for (const ev of feed) {
      const age = now - ev.at;
      if (age < 0 || age >= 60 * 60) continue;
      const idx = summary.minute_events.length - 1 - Math.floor(age / 60);
      if (idx < 0 || idx >= cells.length) continue;
      const sev = severityOf(ev);
      if (sev === 'crit') cells[idx] = { ...cells[idx], crit: cells[idx].crit + 1 };
      else if (sev === 'warn') cells[idx] = { ...cells[idx], warn: cells[idx].warn + 1 };
    }
    return cells;
  }, [summary, feed]);

  const onPanic = async () => {
    setBusy(true);
    const r = await panic('overview panic button');
    setBusy(false);
    setToast(
      r.already_active
        ? 'panic mode was already engaged'
        : `panic engaged — ${r.daemons_disabled} daemon${r.daemons_disabled === 1 ? '' : 's'} disabled`,
    );
    window.setTimeout(() => setToast(null), 4000);
  };

  const onRelease = async () => {
    setBusy(true);
    const r = await panicReset('overview');
    setBusy(false);
    setToast(r.note);
    window.setTimeout(() => setToast(null), 4000);
  };

  const onExport = async () => {
    const home = (window as unknown as { __HOME?: string }).__HOME ?? '/Users/sunny';
    const dst = `${home}/Desktop/sunny-security-audit-${Date.now()}.jsonl`;
    const bytes = await invokeSafe<number>('security_audit_export', { dst });
    setToast(bytes ? `exported ${bytes} bytes → ${dst}` : 'nothing to export yet');
    window.setTimeout(() => setToast(null), 5000);
  };

  const severity = summary.severity;
  const panicMode = summary.panic_mode;

  return (
    <>
      {/* Live region for screen readers — announces threat-level and panic state changes. */}
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {panicMode
          ? 'PANIC MODE — agents blocked, egress refused'
          : `Threat level: ${severity}`}
      </div>
      {/* Gauge + 4 bucket cards */}
      <section
        style={{
          ...sectionStyle,
          borderColor: panicMode ? 'var(--red)' : severityColor(severity),
          boxShadow: panicMode ? '0 0 18px rgba(255, 77, 94, 0.25)' : 'none',
          display: 'grid',
          gridTemplateColumns: '220px 1fr',
          gap: 18,
          alignItems: 'center',
        }}
      >
        <ThreatGauge score={summary.threat_score} panicMode={panicMode} size={200} />

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{
              ...severityBadgeStyle(panicMode ? 'crit' : severity),
              padding: '2px 10px',
              fontSize: 10,
            }}>
              {panicMode ? 'PANIC' : severity.toUpperCase()}
            </span>
            <span
              style={{
                fontFamily: DISPLAY_FONT,
                fontSize: 13,
                letterSpacing: '0.18em',
                color: 'var(--ink)',
                fontWeight: 600,
              }}
            >
              {panicMode
                ? 'agents blocked · egress refused · daemons paused'
                : summary.headline || 'no active threats in the last 2 minutes'}
            </span>
            <span style={{ ...hintStyle, marginLeft: 'auto', fontSize: 10 }}>
              updated {summary.updated_at ? timeAgo(summary.updated_at) : '—'}
            </span>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
          }}>
            <BucketCard label="AGENT" status={summary.agent}
              sub={`${summary.counts.tool_calls_window} calls/2m`} />
            <BucketCard label="NETWORK" status={summary.net}
              sub={`${summary.counts.net_requests_window} req · ${formatBytes(summary.counts.egress_bytes_window)}`} />
            <BucketCard label="PERMISSIONS" status={summary.perm}
              sub="TCC drift monitor" />
            <BucketCard label="HOST" status={summary.host}
              sub="LaunchAgents · login items" />
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
            marginTop: 8,
          }}>
            <MiniStat label="EVENTS" value={summary.counts.events_window} />
            <MiniStat label="WARN" value={summary.counts.warn_window} tone="amber" />
            <MiniStat label="CRIT" value={summary.counts.crit_window} tone="red" />
            <MiniStat label="ANOMALIES" value={summary.counts.anomalies_window} tone="amber" />
          </div>

          {toast && (
            <div
              style={{
                marginTop: 10,
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
        </div>
      </section>

      {/* Posture grade — composite of integrity + hardening. */}
      <section style={sectionStyle}>
        <PostureGrade {...computePosture(integrity, policy, canary)} />
      </section>

      {/* Sparkline trio — 60-min rolling */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>LIVE RATES</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>last 60 min</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <SparkCard
            label="TOOL CALLS / MIN"
            series={summary.minute_tool_calls}
            latest={lastValue(summary.minute_tool_calls)}
            stroke="var(--cyan)"
          />
          <SparkCard
            label="EGRESS BYTES / MIN"
            series={summary.minute_net_bytes}
            latest={formatBytes(lastValue(summary.minute_net_bytes))}
            stroke="var(--violet)"
            fill="rgba(198, 155, 255, 0.18)"
            formatter={formatBytes}
          />
          <SparkCard
            label="TOTAL EVENTS / MIN"
            series={summary.minute_events}
            latest={lastValue(summary.minute_events)}
            stroke="var(--amber)"
            fill="rgba(255, 179, 71, 0.16)"
          />
        </div>
      </section>

      {/* 60-minute attack timeline */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>ATTACK TIMELINE</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            60 min · bar height = events · red/amber = severity
          </span>
        </div>
        <TimelineBar cells={timelineCells} width={960} height={44} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 4,
            marginTop: 6,
            fontFamily: 'var(--mono)',
            fontSize: 9,
            color: 'var(--ink-dim)',
            letterSpacing: '0.12em',
          }}
        >
          <span>−60m</span>
          <span style={{ textAlign: 'center' }}>−45m</span>
          <span style={{ textAlign: 'center' }}>−30m</span>
          <span style={{ textAlign: 'center' }}>−15m</span>
          <span style={{ textAlign: 'right' }}>now</span>
        </div>
      </section>

      {/* Canary + Integrity strip */}
      <section
        style={{
          ...sectionStyle,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        <CanaryCard canary={canary} />
        <IntegritySnapshotCard integrity={integrity} />
      </section>

      {/* Quick actions */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>QUICK ACTIONS</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {panicMode ? (
            <button type="button" style={primaryBtnStyle} disabled={busy} onClick={() => void onRelease()}>
              {busy ? 'RELEASING…' : '◎ RELEASE PANIC'}
            </button>
          ) : (
            <button type="button" style={dangerBtnStyle} disabled={busy} onClick={() => void onPanic()}>
              {busy ? 'ARMING…' : '◉ PANIC (!)'}
            </button>
          )}
          <button type="button" style={mutedBtnStyle} onClick={() => void onExport()}>
            EXPORT AUDIT LOG
          </button>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Hotkey: <kbd style={kbd}>!</kbd> panic ·{' '}
            <kbd style={kbd}>1</kbd>–<kbd style={kbd}>7</kbd> tabs
          </span>
        </div>
      </section>

      {/* Event breakdown + top hosts side-by-side */}
      <section
        style={{
          ...sectionStyle,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        <div>
          <div style={sectionTitleStyle}>
            <span>EVENT BREAKDOWN</span>
            <span style={{ ...hintStyle, marginLeft: 'auto' }}>
              last {feed.length} events
            </span>
          </div>
          <EventBreakdown rows={deriveBreakdown(feed)} />
        </div>
        <div>
          <div style={sectionTitleStyle}>
            <span>TOP EGRESS HOSTS · 60m</span>
            <span style={{ ...hintStyle, marginLeft: 'auto' }}>
              {summary.top_hosts.length} host{summary.top_hosts.length === 1 ? '' : 's'}
            </span>
          </div>
          <HostFlow hosts={summary.top_hosts} />
        </div>
      </section>

      {/* Live feed */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>LIVE FEED</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            newest first · last {feed.length} events
          </span>
        </div>
        {feed.length === 0 ? (
          <div style={emptyStateStyle}>
            Waiting for events. Run a chat turn, trigger a scan, or open an app — anything
            the agent does lands here in real time.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {feed.slice(0, 40).map((ev, i) => (
              <FeedRow key={i} ev={ev} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// sub-components
// ---------------------------------------------------------------------------

function BucketCard({
  label,
  status,
  sub,
}: {
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  sub: string;
}) {
  const color = severityColor(status);
  const active = status !== 'ok' && status !== 'unknown';
  return (
    <div style={{
      ...statCardStyle,
      borderColor: active ? color : 'var(--line-soft)',
      background: active ? `linear-gradient(180deg, ${color}12, rgba(4, 10, 16, 0.5))` : statCardStyle.background,
    }}>
      <span style={statLabelStyle}>{label}</span>
      <span style={{ ...statValueStyle, color, fontSize: 15 }}>
        {status.toUpperCase()}
      </span>
      <span style={{ ...hintStyle, fontSize: 9.5 }}>{sub}</span>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = 'cyan',
}: {
  label: string;
  value: number;
  tone?: 'cyan' | 'amber' | 'red';
}) {
  const color = tone === 'red' ? 'var(--red)' : tone === 'amber' ? 'var(--amber)' : 'var(--cyan)';
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.5)',
        padding: '6px 10px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        fontFamily: 'var(--mono)',
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: '0.22em', color: 'var(--ink-dim)' }}>{label}</span>
      <span style={{ fontSize: 16, color, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function SparkCard({
  label,
  series,
  latest,
  stroke,
  fill,
  formatter,
}: {
  label: string;
  series: ReadonlyArray<number>;
  latest: string | number;
  stroke: string;
  fill?: string;
  formatter?: (n: number) => string;
}) {
  const _ = formatter; // not used currently, kept for future axis labels
  void _;
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.5)',
        padding: '10px 12px',
        display: 'grid',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.22em', color: 'var(--ink-dim)' }}>
          {label}
        </span>
        <span style={{ fontFamily: DISPLAY_FONT, fontSize: 18, color: stroke, fontWeight: 700 }}>
          {latest}
        </span>
      </div>
      <Sparkline data={series} width={260} height={48} stroke={stroke} fill={fill} />
    </div>
  );
}

function CanaryCard({ canary }: { canary: CanaryStatus | null }) {
  const armed = canary?.armed ?? false;
  const color = armed ? 'var(--green)' : 'var(--ink-dim)';
  return (
    <div style={{ border: '1px solid var(--line-soft)', background: 'rgba(4, 10, 16, 0.45)', padding: 12 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: color,
          boxShadow: `0 0 6px ${color}`,
        }} />
        <span style={{ fontFamily: DISPLAY_FONT, fontSize: 10, letterSpacing: '0.24em', fontWeight: 700, color }}>
          CANARY · {armed ? 'ARMED' : 'OFFLINE'}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)' }}>
        {canary?.token_preview || '—'}
      </div>
      <div style={{ ...hintStyle, fontSize: 10, marginTop: 4 }}>
        Fake key planted in env + <code>~/.sunny/security/canary.txt</code>. Any outbound
        request containing it auto-engages panic mode — there is no legitimate reason for
        this string to leave the machine.
      </div>
    </div>
  );
}

function IntegritySnapshotCard({ integrity }: { integrity: IntegrityGrid | null }) {
  if (!integrity) {
    return (
      <div style={{ border: '1px solid var(--line-soft)', background: 'rgba(4, 10, 16, 0.45)', padding: 12 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 10, letterSpacing: '0.24em', color: 'var(--ink-dim)', marginBottom: 8 }}>
          SYSTEM INTEGRITY
        </div>
        <div style={hintStyle}>Probing SIP / Gatekeeper / FileVault / Firewall…</div>
      </div>
    );
  }
  const rows: Array<{ key: string; label: string; status: string; summary: string }> = [
    { key: 'sip', label: 'SIP', status: integrity.sip.status, summary: integrity.sip.summary },
    { key: 'gatekeeper', label: 'GATEKEEPER', status: integrity.gatekeeper.status, summary: integrity.gatekeeper.summary },
    { key: 'filevault', label: 'FILEVAULT', status: integrity.filevault.status, summary: integrity.filevault.summary },
    { key: 'firewall', label: 'FIREWALL', status: integrity.firewall.status, summary: integrity.firewall.summary },
    { key: 'bundle', label: 'BUNDLE', status: integrity.bundle.status, summary: integrity.bundle.summary },
    { key: 'profiles', label: 'PROFILES', status: integrity.config_profiles.status, summary: integrity.config_profiles.summary },
  ];
  return (
    <div style={{ border: '1px solid var(--line-soft)', background: 'rgba(4, 10, 16, 0.45)', padding: 12 }}>
      <div style={{ fontFamily: DISPLAY_FONT, fontSize: 10, letterSpacing: '0.24em', color: 'var(--cyan)', marginBottom: 8, fontWeight: 700 }}>
        SYSTEM INTEGRITY
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {rows.map(r => {
          const color = severityColor(r.status as 'ok' | 'warn' | 'crit' | 'unknown');
          return (
            <div
              key={r.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '10px 1fr',
                gap: 6,
                alignItems: 'center',
                padding: '4px 6px',
                border: `1px solid ${color}33`,
                background: `${color}0a`,
                fontFamily: 'var(--mono)',
                fontSize: 10,
              }}
              title={`${r.label}: ${r.summary}`}
            >
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: color, boxShadow: `0 0 4px ${color}`,
                }}
              />
              <span style={{ color: 'var(--ink)' }}>
                <strong style={{ color, letterSpacing: '0.18em', fontSize: 9 }}>{r.label}</strong>
                <span style={{ color: 'var(--ink-dim)', marginLeft: 6 }}>{r.summary}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FeedRow({ ev }: { ev: SecurityEvent }) {
  const { sev, title, body } = describeEvent(ev);
  const color = severityColor(sev);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '70px 98px 1fr',
        gap: 10,
        alignItems: 'center',
        padding: '4px 8px',
        border: `1px solid ${color}22`,
        background: `${color}0a`,
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
      title={body}
    >
      <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
        {formatTime(ev.at)}
      </span>
      <span style={severityBadgeStyle(sev)}>{ev.kind.replace(/_/g, ' ')}</span>
      <span
        style={{
          color: 'var(--ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <strong style={{ color }}>{title}</strong>
        {body && <span style={{ color: 'var(--ink-dim)' }}> — {body}</span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeEvent(ev: SecurityEvent): { sev: 'info' | 'warn' | 'crit'; title: string; body: string } {
  switch (ev.kind) {
    case 'tool_call':
      return {
        sev: ev.severity,
        title: `${ev.agent} → ${ev.tool}${ev.ok === false ? ' ✗' : ev.ok ? ' ✓' : ' …'}`,
        body: ev.input_preview,
      };
    case 'net_request':
      return {
        sev: ev.severity,
        title: `${ev.method} ${ev.host}${ev.path_prefix}`,
        body: `${ev.initiator}${ev.status ? ` · ${ev.status}` : ''}${ev.bytes ? ` · ${ev.bytes}B` : ''}`,
      };
    case 'confirm_requested':
      return { sev: 'warn', title: `confirm requested · ${ev.tool}`, body: `by ${ev.requester}` };
    case 'confirm_answered':
      return {
        sev: ev.approved ? 'info' : 'warn',
        title: ev.approved ? 'user approved' : 'user denied',
        body: ev.reason || '',
      };
    case 'secret_read':
      return { sev: 'info', title: `secret read · ${ev.provider}`, body: ev.caller };
    case 'permission_change':
      return {
        sev: ev.severity,
        title: `permission · ${ev.key}`,
        body: `${ev.previous ?? '?'} → ${ev.current}`,
      };
    case 'launch_agent_delta':
      return { sev: ev.severity, title: `LaunchAgent ${ev.change}`, body: ev.path };
    case 'login_item_delta':
      return { sev: ev.severity, title: `login item ${ev.change}`, body: ev.name };
    case 'unsigned_binary':
      return { sev: ev.severity, title: 'unsigned binary', body: `${ev.path} · ${ev.initiator}` };
    case 'prompt_injection':
      return { sev: ev.severity, title: `prompt injection @ ${ev.source}`, body: `${ev.signals.length} pattern(s) · ${ev.excerpt}` };
    case 'canary_tripped':
      return { sev: 'crit', title: 'CANARY TRIPPED', body: `→ ${ev.destination}` };
    case 'tool_rate_anomaly':
      return { sev: ev.severity, title: `${ev.tool} anomaly`, body: `rate ${ev.rate_per_min.toFixed(0)}/min · baseline ${ev.baseline_per_min.toFixed(1)} · z=${ev.z_score.toFixed(1)}` };
    case 'integrity_status':
      return { sev: ev.severity, title: `integrity · ${ev.key}`, body: `${ev.status} · ${ev.detail}` };
    case 'file_integrity_change':
      return { sev: ev.severity, title: `FIM · ${ev.path.split('/').pop()}`, body: `${(ev.prev_sha256 || '').slice(0, 8)} → ${ev.curr_sha256.slice(0, 8)}` };
    case 'panic':
      return { sev: 'crit', title: 'PANIC ENGAGED', body: ev.reason };
    case 'panic_reset':
      return { sev: 'warn', title: 'panic released', body: `by ${ev.by}` };
    case 'notice':
      return { sev: ev.severity, title: ev.source, body: ev.message };
    default:
      return { sev: 'info', title: (ev as { kind: string }).kind, body: '' };
  }
}

function severityOf(ev: SecurityEvent): 'info' | 'warn' | 'crit' {
  switch (ev.kind) {
    case 'panic': case 'canary_tripped': return 'crit';
    case 'panic_reset': case 'confirm_requested': return 'warn';
    case 'confirm_answered': return ev.approved ? 'info' : 'warn';
    case 'secret_read': return 'info';
    default: return (ev as { severity?: 'info' | 'warn' | 'crit' }).severity ?? 'info';
  }
}

function lastValue(a: ReadonlyArray<number>): number {
  return a.length ? a[a.length - 1] : 0;
}

function formatBytes(n: number): string {
  if (!n) return '0';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatTime(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour12: false });
}

/**
 * Aggregate recent events by kind + worst-severity-seen for the
 * horizontal-bar breakdown on Overview.
 */
function deriveBreakdown(
  events: ReadonlyArray<SecurityEvent>,
): ReadonlyArray<{ kind: string; count: number; severity: 'info' | 'warn' | 'crit' }> {
  const map = new Map<string, { count: number; severity: 'info' | 'warn' | 'crit' }>();
  for (const ev of events) {
    const sev = severityOf(ev);
    const cur = map.get(ev.kind) ?? { count: 0, severity: 'info' as const };
    cur.count += 1;
    if (rank(sev) > rank(cur.severity)) cur.severity = sev;
    map.set(ev.kind, cur);
  }
  return Array.from(map.entries())
    .map(([kind, v]) => ({ kind, ...v }))
    .sort((a, b) => b.count - a.count);
}

function rank(s: 'info' | 'warn' | 'crit'): number {
  return s === 'crit' ? 3 : s === 'warn' ? 2 : 1;
}

/**
 * Composite posture score (0-100) — separate axis from the threat
 * score.  Threat score = "what's happening right now"; posture =
 * "how hardened are we".  A well-hardened machine should hold a
 * high posture grade even when the threat score spikes briefly.
 */
function computePosture(
  integrity: IntegrityGrid | null,
  policy: EnforcementPolicy | null,
  canary: CanaryStatus | null,
): { score: number; breakdown: ReadonlyArray<{ label: string; value: number; max: number }> } {
  // Integrity — 25 points.  Each of SIP / Gatekeeper / FileVault /
  // Firewall / bundle-codesign / profiles contributes ~4.
  const integrityCats: Array<'ok' | 'warn' | 'crit' | 'unknown'> = integrity
    ? [
        integrity.sip.status as 'ok',
        integrity.gatekeeper.status as 'ok',
        integrity.filevault.status as 'ok',
        integrity.firewall.status as 'ok',
        integrity.bundle.status as 'ok',
        integrity.config_profiles.status as 'ok',
      ]
    : ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'];
  const integrityScore = integrityCats.reduce((n, s) => {
    if (s === 'ok') return n + 4;
    if (s === 'warn') return n + 2;
    return n;
  }, 0); // 0-24, scale to 25
  const integrityPts = Math.min(25, Math.round((integrityScore / 24) * 25));

  // Enforcement — 40 points.
  //   egress_mode block=20, warn=10, observe=0
  //   force_confirm_all true=6
  //   scrub_prompts true=6
  //   subagent_role_scoping true=8
  const enforcementPts = policy
    ? (policy.egress_mode === 'block' ? 20 : policy.egress_mode === 'warn' ? 10 : 0)
      + (policy.force_confirm_all ? 6 : 0)
      + (policy.scrub_prompts ? 6 : 0)
      + (policy.subagent_role_scoping ? 8 : 0)
    : 0;

  // Tripwires — 15 points.
  //   canary armed = 10
  //   bundle signed = 5
  const tripwirePts =
    (canary?.armed ? 10 : 0) +
    (integrity?.bundle.status === 'ok' ? 5 : 0);

  // Base hygiene — 20 points (always given).  Reflects the fact
  // that Sunny runs the Phase-1/2 watchers, has audit logging, and
  // has the hash-chained JSONL. This is baseline; it falls off if
  // we ever ship a build without those.
  const hygienePts = 20;

  const total = integrityPts + enforcementPts + tripwirePts + hygienePts;
  return {
    score: Math.min(100, total),
    breakdown: [
      { label: 'BASELINE', value: hygienePts, max: 20 },
      { label: 'ENFORCEMENT', value: enforcementPts, max: 40 },
      { label: 'INTEGRITY', value: integrityPts, max: 25 },
      { label: 'TRIPWIRES', value: tripwirePts, max: 15 },
    ],
  };
}

function timeAgo(unix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const kbd: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  padding: '0 5px',
  border: '1px solid var(--line-soft)',
  color: 'var(--cyan)',
  background: 'rgba(6, 14, 22, 0.7)',
};
