import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  scanRevealInFinder,
  scanVaultDelete,
  scanVaultList,
  scanVaultRestore,
} from './api';
import type { VaultItem, Verdict } from './types';
import {
  chipBaseStyle,
  dangerBtnStyle,
  emptyStateStyle,
  findingHeaderStyle,
  findingRowStyle,
  hintStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
  statCardStyle,
  statLabelStyle,
  statValueStyle,
  statsRowStyle,
} from './styles';
import {
  SIGNAL_LABEL,
  VERDICT_META,
  formatRelativeSecs,
  formatSize,
  shortPath,
} from './types';

// Vault list poll — the user is likely on this tab while a scan fills it in,
// so keep it fresh without hammering Rust.
const POLL_MS = 2000;

// Two-step confirmation window for destructive actions.
const CONFIRM_MS = 3000;

type Props = {
  /** Bump to force an immediate refresh (e.g. after a quarantine happens). */
  readonly refreshToken: number;
};

export function VaultTab({ refreshToken }: Props) {
  const [items, setItems] = useState<ReadonlyArray<VaultItem>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [armedRestore, setArmedRestore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await scanVaultList();
      setItems(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, refreshToken]);

  // Auto-disarm confirmation prompts.
  useEffect(() => {
    if (armedDelete === null && armedRestore === null) return;
    const id = window.setTimeout(() => {
      setArmedDelete(null);
      setArmedRestore(null);
    }, CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [armedDelete, armedRestore]);

  useEffect(() => {
    if (notice === null) return;
    const id = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(id);
  }, [notice]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (armedDelete !== id) {
        setArmedDelete(id);
        setArmedRestore(null);
        return;
      }
      setArmedDelete(null);
      setError(null);
      try {
        await scanVaultDelete(id);
        setNotice('Permanently deleted.');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [armedDelete, refresh],
  );

  const handleRestore = useCallback(
    async (id: string, overwrite: boolean) => {
      if (!overwrite && armedRestore !== id) {
        setArmedRestore(id);
        setArmedDelete(null);
        return;
      }
      setArmedRestore(null);
      setError(null);
      try {
        const path = await scanVaultRestore(id, overwrite);
        setNotice(`Restored to ${path}`);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [armedRestore, refresh],
  );

  // Header stats: count + total bytes + per-verdict breakdown.
  const stats = useMemo(() => {
    const counts: Record<Verdict, number> = {
      clean: 0, info: 0, suspicious: 0, malicious: 0, unknown: 0,
    };
    let totalSize = 0;
    for (const it of items) {
      counts[it.verdict] += 1;
      totalSize += it.size;
    }
    return { counts, totalSize };
  }, [items]);

  const onReveal = useCallback(async (path: string) => {
    try {
      await scanRevealInFinder(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleBulkRestore = useCallback(async () => {
    if (selected.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    setError(null);
    let ok = 0; let fail = 0;
    for (const id of Array.from(selected)) {
      try { await scanVaultRestore(id, false); ok += 1; }
      catch { fail += 1; }
    }
    setSelected(new Set());
    setBulkBusy(false);
    setNotice(`Restored ${ok}${fail > 0 ? ` · ${fail} failed` : ''}`);
    await refresh();
  }, [selected, bulkBusy, refresh]);

  const handleBulkDelete = useCallback(async () => {
    if (selected.size === 0 || bulkBusy) return;
    if (!window.confirm(`Permanently delete ${selected.size} file${selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBulkBusy(true);
    setError(null);
    let ok = 0; let fail = 0;
    for (const id of Array.from(selected)) {
      try { await scanVaultDelete(id); ok += 1; }
      catch { fail += 1; }
    }
    setSelected(new Set());
    setBulkBusy(false);
    setNotice(`Deleted ${ok}${fail > 0 ? ` · ${fail} failed` : ''}`);
    await refresh();
  }, [selected, bulkBusy, refresh]);

  if (items.length === 0) {
    return (
      <>
        <section style={sectionStyle}>
          <div style={sectionTitleStyle}>
            <span>VAULT</span>
            <span style={{ ...hintStyle, marginLeft: 'auto' }}>0 items</span>
          </div>
          <div style={hintStyle}>
            The virus vault is where flagged files get isolated. Move a finding
            here from the <strong style={{ color: 'var(--cyan)' }}>FINDINGS</strong>{' '}
            tab — it'll be atomically relocated to <code>~/.sunny/scan_vault/</code>{' '}
            and its permissions locked to <code>000</code> so nothing can execute or read it
            by accident.
          </div>
        </section>
        <div style={emptyStateStyle}>NOTHING QUARANTINED</div>
      </>
    );
  }

  return (
    <>
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>VAULT</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {items.length} quarantined item{items.length === 1 ? '' : 's'}
          </span>
        </div>

        {/* Header stats */}
        <div style={{ ...statsRowStyle, marginBottom: 12 }}>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>TOTAL</span>
            <span style={statValueStyle}>{items.length}</span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>SIZE</span>
            <span style={statValueStyle}>{formatSize(stats.totalSize)}</span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>MALICIOUS</span>
            <span style={{ ...statValueStyle, color: '#ff6a6a' }}>
              {stats.counts.malicious}
            </span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>SUSPICIOUS</span>
            <span style={{ ...statValueStyle, color: 'var(--amber)' }}>
              {stats.counts.suspicious}
            </span>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>INFO</span>
            <span style={{ ...statValueStyle, color: 'var(--cyan)' }}>
              {stats.counts.info}
            </span>
          </div>
        </div>

        <div style={hintStyle}>
          Quarantined files live in <code>~/.sunny/scan_vault/</code> with permission{' '}
          <code>000</code>. Restore moves them back to their original path.
        </div>
        {notice && (
          <div
            style={{
              ...hintStyle,
              marginTop: 10,
              color: 'rgb(120, 255, 170)',
            }}
          >
            {notice}
          </div>
        )}
        {error && (
          <div style={{ ...hintStyle, marginTop: 10, color: 'var(--amber)' }}>{error}</div>
        )}
      </section>

      {/* Bulk action bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() =>
            setSelected(prev =>
              prev.size === items.length ? new Set<string>() : new Set(items.map(i => i.id)),
            )
          }
          style={{
            ...mutedBtnStyle,
            color: selected.size === items.length && items.length > 0 ? 'var(--cyan)' : 'var(--ink-dim)',
            borderColor: selected.size === items.length && items.length > 0 ? 'var(--cyan)' : 'var(--line-soft)',
          }}
        >
          {selected.size === items.length && items.length > 0 ? 'DESELECT ALL' : 'SELECT ALL'}
        </button>
        {selected.size > 0 && (
          <>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--ink-dim)' }}>
              {selected.size} selected
            </span>
            <button
              onClick={() => void handleBulkRestore()}
              disabled={bulkBusy}
              style={{ ...primaryBtnStyle, fontSize: 10, padding: '4px 12px' }}
            >
              {bulkBusy ? 'RESTORING…' : 'RESTORE SELECTED'}
            </button>
            <button
              onClick={() => void handleBulkDelete()}
              disabled={bulkBusy}
              style={{ ...dangerBtnStyle, fontSize: 10, padding: '4px 12px' }}
            >
              {bulkBusy ? 'DELETING…' : 'DELETE SELECTED'}
            </button>
          </>
        )}
      </div>

      <div>
        {items.map(item => (
          <VaultRow
            key={item.id}
            item={item}
            selected={selected.has(item.id)}
            onSelect={() => toggleSelect(item.id)}
            expanded={expanded === item.id}
            onToggle={() => setExpanded(p => (p === item.id ? null : item.id))}
            onRestore={(overwrite: boolean) => void handleRestore(item.id, overwrite)}
            onDelete={() => void handleDelete(item.id)}
            onReveal={() => void onReveal(item.vaultPath)}
            deleteArmed={armedDelete === item.id}
            restoreArmed={armedRestore === item.id}
          />
        ))}
      </div>
    </>
  );
}

function VaultRow({
  item,
  selected,
  onSelect,
  expanded,
  onToggle,
  onRestore,
  onDelete,
  onReveal,
  deleteArmed,
  restoreArmed,
}: {
  item: VaultItem;
  selected: boolean;
  onSelect: () => void;
  expanded: boolean;
  onToggle: () => void;
  onRestore: (overwrite: boolean) => void;
  onDelete: () => void;
  onReveal: () => void;
  deleteArmed: boolean;
  restoreArmed: boolean;
}) {
  const meta = VERDICT_META[item.verdict];
  const stripeClass =
    item.verdict === 'malicious'
      ? 'scan-vault-row is-malicious'
      : item.verdict === 'suspicious'
        ? 'scan-vault-row is-suspicious'
        : 'scan-vault-row';
  return (
    <div className={stripeClass} style={findingRowStyle}>
      <div
        style={{ display: 'flex', alignItems: 'center' }}
      >
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onSelect(); }}
          aria-label={selected ? 'Deselect' : 'Select'}
          style={{
            all: 'unset',
            cursor: 'pointer',
            width: 16,
            height: 16,
            border: `1px solid ${selected ? 'var(--cyan)' : 'var(--line-soft)'}`,
            background: selected ? 'rgba(57,229,255,0.18)' : 'rgba(4,10,16,0.4)',
            flexShrink: 0,
            margin: '0 10px 0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--cyan)',
          }}
        >
          {selected ? '✓' : ''}
        </button>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle();
            }
          }}
          style={{ ...findingHeaderStyle, flex: 1 }}
        >
          <span
            style={{
              display: 'inline-flex',
              justifyContent: 'center',
              padding: '2px 8px',
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
            letterSpacing: '0.18em',
            border: `1px solid ${meta.border}`,
            color: meta.color,
            background: meta.bg,
          }}
        >
          {meta.label}
        </span>
        <span
          style={{
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={item.originalPath}
        >
          {shortPath(item.originalPath, 80)}
        </span>
        <span style={{ ...hintStyle, fontSize: 10 }}>{formatSize(item.size)}</span>
        <span style={{ ...hintStyle, fontSize: 10 }}>
          {formatRelativeSecs(item.quarantinedAt)}
        </span>
        </div>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--line-soft)',
            padding: '12px 16px',
            background: 'rgba(6, 14, 22, 0.28)',
          }}
        >
          <div style={{ ...hintStyle, fontSize: 11, marginBottom: 10 }}>
            <span style={{ color: meta.color }}>▸</span> {item.reason}
          </div>

          {item.signals.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {item.signals.map(s => (
                <span
                  key={s}
                  style={{
                    ...chipBaseStyle,
                    padding: '2px 8px',
                    fontSize: 10,
                    letterSpacing: '0.16em',
                  }}
                >
                  {SIGNAL_LABEL[s]}
                </span>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              rowGap: 6,
              columnGap: 12,
            }}
          >
            <Meta label="ORIGINAL" value={item.originalPath} />
            <Meta label="VAULT PATH" value={item.vaultPath} />
            <Meta label="SHA-256" value={item.sha256 || '(unknown)'} />
            <Meta label="SIZE" value={formatSize(item.size)} />
            <Meta label="QUARANTINED" value={formatRelativeSecs(item.quarantinedAt)} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button style={primaryBtnStyle} onClick={() => onRestore(false)}>
              {restoreArmed ? 'CONFIRM · RESTORE' : 'RESTORE'}
            </button>
            <button
              style={mutedBtnStyle}
              onClick={e => {
                e.stopPropagation();
                onRestore(true);
              }}
              title="Overwrite if a file already sits at the original path"
            >
              RESTORE (OVERWRITE)
            </button>
            <button
              style={mutedBtnStyle}
              onClick={e => {
                e.stopPropagation();
                onReveal();
              }}
            >
              REVEAL IN FINDER
            </button>
            <button style={dangerBtnStyle} onClick={onDelete}>
              {deleteArmed ? 'CONFIRM · DELETE FOREVER' : 'DELETE FOREVER'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.22em',
          color: 'var(--ink-dim)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--ink)',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </>
  );
}
