/**
 * INTRUSION tab — three feeds the user cares about:
 *
 *   1. LaunchAgents / LaunchDaemons diff against stored baseline.
 *   2. Login items (current list — AppleScript probe).
 *   3. Unsigned-binary events emitted by the codesign tripwire.
 *
 * "Mark all reviewed" rewrites the baseline so old entries stop
 * surfacing once the user has triaged them.
 */

import { useEffect, useState } from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  emptyStateStyle,
  hintStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  severityColor,
} from './styles';
import {
  fetchEvents,
  fetchLaunchBaseline,
  fetchLaunchDiff,
  fetchLoginItems,
  resetLaunchBaseline,
  subscribeEvents,
} from './api';
import type {
  LaunchBaseline,
  LaunchDiff,
  UnsignedBinaryEvent,
} from './types';

export function IntrusionTab() {
  const [baseline, setBaseline] = useState<LaunchBaseline | null>(null);
  const [diff, setDiff] = useState<LaunchDiff | null>(null);
  const [loginItems, setLoginItems] = useState<ReadonlyArray<string>>([]);
  const [unsignedEvents, setUnsignedEvents] = useState<ReadonlyArray<UnsignedBinaryEvent>>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const reload = async () => {
    setBusy(true);
    const [b, d, li, evs] = await Promise.all([
      fetchLaunchBaseline(),
      fetchLaunchDiff(),
      fetchLoginItems(),
      fetchEvents(800),
    ]);
    setBaseline(b);
    setDiff(d);
    setLoginItems(li);
    setUnsignedEvents(
      evs
        .filter((e): e is UnsignedBinaryEvent => e.kind === 'unsigned_binary')
        .sort((a, b) => b.at - a.at)
        .slice(0, 50),
    );
    setBusy(false);
  };

  useEffect(() => {
    void reload();
    const p = subscribeEvents(ev => {
      if (ev.kind === 'unsigned_binary') {
        setUnsignedEvents(prev => [ev, ...prev].slice(0, 50));
      }
      if (ev.kind === 'launch_agent_delta' || ev.kind === 'login_item_delta') {
        void reload();
      }
    });
    return () => {
      void p.then(u => u && u());
    };
  }, []);

  const onResetBaseline = async () => {
    setBusy(true);
    const n = await resetLaunchBaseline();
    setToast(`baseline reset — tracking ${n} plist${n === 1 ? '' : 's'}`);
    window.setTimeout(() => setToast(null), 3500);
    await reload();
    setBusy(false);
  };

  const onRevealInFinder = (path: string) => {
    void invokeSafe('scan_reveal_in_finder', { path });
  };

  return (
    <>
      {/* LaunchAgents diff */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>LAUNCH AGENTS / DAEMONS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Baseline:{' '}
            {baseline?.captured_at
              ? new Date(baseline.captured_at * 1000).toLocaleString()
              : '—'}
          </span>
          <button type="button" style={mutedBtnStyle} onClick={() => void reload()} disabled={busy}>
            {busy ? 'SCANNING…' : 'RESCAN'}
          </button>
          <button type="button" style={primaryBtnStyle} onClick={() => void onResetBaseline()} disabled={busy}>
            MARK ALL REVIEWED
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

        {!diff || (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) ? (
          <div style={emptyStateStyle}>
            No drift from baseline. {diff?.unchanged_count ?? 0} plist
            {diff?.unchanged_count === 1 ? '' : 's'} unchanged.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {diff.added.map(e => (
              <DeltaRow
                key={`added-${e.path}`}
                change="ADDED"
                color="var(--red)"
                path={e.path}
                sub={`${e.sha1.slice(0, 12)} · ${formatBytes(e.size)}`}
                onReveal={() => onRevealInFinder(e.path)}
              />
            ))}
            {diff.changed.map(c => (
              <DeltaRow
                key={`changed-${c.path}`}
                change="MODIFIED"
                color="var(--amber)"
                path={c.path}
                sub={`${c.previous.sha1.slice(0, 10)} → ${c.current.sha1.slice(0, 10)}`}
                onReveal={() => onRevealInFinder(c.path)}
              />
            ))}
            {diff.removed.map(e => (
              <DeltaRow
                key={`removed-${e.path}`}
                change="REMOVED"
                color="var(--ink-dim)"
                path={e.path}
                sub={`${e.sha1.slice(0, 12)} · was ${formatBytes(e.size)}`}
                onReveal={() => onRevealInFinder(e.path)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Login items */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>LOGIN ITEMS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {loginItems.length} item{loginItems.length === 1 ? '' : 's'}
          </span>
        </div>
        {loginItems.length === 0 ? (
          <div style={emptyStateStyle}>
            No login items — or Automation permission hasn't been granted to Sunny yet
            so the System Events probe returned nothing.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {loginItems.map(name => (
              <div
                key={name}
                style={{
                  padding: '6px 10px',
                  border: '1px solid var(--line-soft)',
                  background: 'rgba(4, 10, 16, 0.45)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--ink)',
                }}
              >
                {name}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Unsigned binary events */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>UNSIGNED BINARIES</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Fires when a binary Sunny launches fails <code>codesign --verify</code>.
          </span>
        </div>
        {unsignedEvents.length === 0 ? (
          <div style={emptyStateStyle}>
            No unsigned-binary events. Every app you've opened through Sunny was signed.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {unsignedEvents.map(ev => (
              <div
                key={`${ev.at}-${ev.path}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '72px 80px 1fr auto',
                  gap: 10,
                  padding: '6px 10px',
                  border: `1px solid ${severityColor(ev.severity)}33`,
                  background: `${severityColor(ev.severity)}08`,
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
                  {new Date(ev.at * 1000).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                <span style={severityBadgeStyle(ev.severity)}>{ev.severity}</span>
                <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={ev.reason}
                >
                  {ev.path}
                  <span style={{ color: 'var(--ink-dim)' }}> · {ev.initiator}</span>
                </span>
                <button type="button" style={mutedBtnStyle} onClick={() => onRevealInFinder(ev.path)}>
                  REVEAL
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function DeltaRow({
  change,
  color,
  path,
  sub,
  onReveal,
}: {
  change: string;
  color: string;
  path: string;
  sub: string;
  onReveal: () => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 1fr 240px auto',
        gap: 10,
        alignItems: 'center',
        padding: '6px 10px',
        border: `1px solid ${color}44`,
        background: `${color}08`,
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <span style={{ color, fontWeight: 700, letterSpacing: '0.2em', fontSize: 10 }}>{change}</span>
      <span
        style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={path}
      >
        {path}
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>{sub}</span>
      <button type="button" style={mutedBtnStyle} onClick={onReveal}>
        REVEAL
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
