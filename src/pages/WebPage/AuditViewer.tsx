import type { ReactElement } from 'react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';
import type { AuditRecord } from './types';

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(2, 6, 12, 0.72)',
  zIndex: 55,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'center',
  padding: 20,
};

const panel: CSSProperties = {
  background: 'rgba(4, 12, 20, 0.98)',
  border: '1px solid var(--cyan)',
  maxWidth: 1100,
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
};

const btn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  color: 'var(--cyan)',
  fontSize: 10,
  letterSpacing: '0.14em',
  height: 24,
  lineHeight: '24px',
};

export function AuditViewer({ onClose }: { onClose: () => void }): ReactElement {
  const [rows, setRows] = useState<AuditRecord[]>([]);
  const [filter, setFilter] = useState('');
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const [profileFilter, setProfileFilter] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    if (!isTauri) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await invoke<AuditRecord[]>('browser_audit_recent', { limit: 500 });
      setRows(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter(r => {
      if (onlyBlocked && !r.blocked_by) return false;
      if (profileFilter && r.profile_id !== profileFilter) return false;
      if (f.length === 0) return true;
      return (
        r.host.toLowerCase().includes(f) ||
        r.method.toLowerCase().includes(f) ||
        (r.blocked_by?.toLowerCase().includes(f) ?? false) ||
        (r.tab_id?.toLowerCase().includes(f) ?? false)
      );
    });
  }, [rows, filter, onlyBlocked, profileFilter]);

  const profiles = useMemo(() => {
    return Array.from(new Set(rows.map(r => r.profile_id))).sort();
  }, [rows]);

  const clearOlder = async () => {
    if (!window.confirm('Delete audit rows older than 24h?')) return;
    await invokeSafe<number>('browser_audit_clear_older', { seconds: 24 * 60 * 60 });
    await refresh();
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <header
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--line-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              flex: 1,
              fontFamily: "'Orbitron', var(--display, var(--mono))",
              letterSpacing: '0.18em',
              color: 'var(--cyan)',
              fontSize: 13,
            }}
          >
            AUDIT · {visible.length} / {rows.length}
          </div>
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter host/method/blocked_by/tab…"
            style={{
              all: 'unset',
              flex: 1,
              height: 24,
              padding: '0 8px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(4, 10, 16, 0.5)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink)',
              maxWidth: 320,
            }}
          />
          <select
            value={profileFilter}
            onChange={e => setProfileFilter(e.target.value)}
            style={{
              height: 24,
              padding: '0 4px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(4, 10, 16, 0.5)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink)',
            }}
          >
            <option value="">all profiles</option>
            {profiles.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label
            style={{
              fontSize: 10,
              color: 'var(--ink-dim)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <input
              type="checkbox"
              checked={onlyBlocked}
              onChange={e => setOnlyBlocked(e.target.checked)}
            />
            blocked only
          </label>
          <button type="button" onClick={() => void refresh()} style={btn} disabled={busy}>
            {busy ? '…' : 'REFRESH'}
          </button>
          <button
            type="button"
            onClick={() => void clearOlder()}
            style={{ ...btn, color: '#ff9b9b', borderColor: '#ff9b9b' }}
          >
            PURGE &gt;24H
          </button>
          <button type="button" onClick={onClose} style={{ ...btn, color: 'var(--ink-dim)' }}>
            CLOSE
          </button>
        </header>

        {err && (
          <div style={{ color: '#ff9b9b', padding: '6px 14px' }}>
            {err}
          </div>
        )}

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: "'JetBrains Mono', var(--mono)",
              fontSize: 11,
            }}
          >
            <thead>
              <tr
                style={{
                  background: 'rgba(0, 220, 255, 0.04)',
                  color: 'var(--cyan)',
                  letterSpacing: '0.14em',
                  fontSize: 9,
                }}
              >
                <Th>TS</Th>
                <Th>PROFILE</Th>
                <Th>METHOD</Th>
                <Th>HOST:PORT</Th>
                <Th>BYTES IN</Th>
                <Th>BYTES OUT</Th>
                <Th>MS</Th>
                <Th>BLOCKED</Th>
                <Th>TAB</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr
                  key={r.id}
                  style={{
                    borderBottom: '1px dotted var(--line-soft)',
                    color: r.blocked_by ? '#ff9b9b' : 'var(--ink)',
                  }}
                >
                  <Td>{formatTs(r.ts)}</Td>
                  <Td>{r.profile_id}</Td>
                  <Td>{r.method}</Td>
                  <Td title={`${r.host}:${r.port}`}>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'inline-block',
                        maxWidth: 260,
                      }}
                    >
                      {r.host}:{r.port}
                    </span>
                  </Td>
                  <Td>{r.bytes_in}</Td>
                  <Td>{r.bytes_out}</Td>
                  <Td>{r.duration_ms}</Td>
                  <Td>{r.blocked_by ?? ''}</Td>
                  <Td>{r.tab_id ?? ''}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div style={{ padding: 24, color: 'var(--ink-dim)' }}>
              {'// no rows match the current filter'}
            </div>
          )}
        </div>

        <footer
          style={{
            padding: '6px 14px',
            fontSize: 9,
            color: 'var(--ink-dim)',
            borderTop: '1px dashed var(--line-soft)',
            letterSpacing: '0.12em',
          }}
        >
          {'// audit rows record host:port + sizes + timing. URL paths are never stored.'}
          <br />
          {'// the tor profile has `audit: false` — no rows land here for tor traffic.'}
        </footer>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 500 }}>{children}</th>
  );
}

function Td({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}): ReactElement {
  return (
    <td style={{ padding: '4px 10px' }} title={title}>
      {children}
    </td>
  );
}

function formatTs(seconds: number): string {
  try {
    const d = new Date(seconds * 1000);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return String(seconds);
  }
}
