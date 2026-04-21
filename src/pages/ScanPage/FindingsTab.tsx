import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { scanFindings, scanQuarantine, scanRevealInFinder } from './api';
import type { Finding, VaultItem, Verdict } from './types';
import {
  DISPLAY_FONT,
  chipBaseStyle,
  dangerBtnStyle,
  emptyStateStyle,
  findingHeaderStyle,
  findingRowStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import {
  SIGNAL_LABEL,
  VERDICT_META,
  formatRelativeSecs,
  formatSize,
  shortPath,
} from './types';

// Polling cadence for the findings list. Lower than the status poll because
// the list can grow large and a flicker is ok here.
const POLL_MS = 1200;

const VERDICT_ORDER: ReadonlyArray<Verdict> = ['malicious', 'suspicious', 'info', 'clean'];
type SortKey = 'severity' | 'path' | 'size' | 'recent';

const SORTS: ReadonlyArray<{ id: SortKey; label: string }> = [
  { id: 'severity', label: 'SEVERITY' },
  { id: 'path', label: 'PATH' },
  { id: 'size', label: 'SIZE' },
  { id: 'recent', label: 'RECENT' },
];

type Props = {
  readonly scanId: string | null;
  readonly onQuarantined: (item: VaultItem) => void;
  /** Bumped by the page when the user presses `/` while this tab is visible. */
  readonly searchFocusToken: number;
};

export function FindingsTab({ scanId, onQuarantined, searchFocusToken }: Props) {
  const [findings, setFindings] = useState<ReadonlyArray<Finding>>([]);
  const [filter, setFilter] = useState<Verdict | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('severity');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Row-focus index for arrow-key navigation. -1 means "no row focused"
  // and all hotkeys fall back to their default behavior.
  const [kbdFocus, setKbdFocus] = useState<number>(-1);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Focus search when the "/" shortcut fires.
  useEffect(() => {
    if (searchFocusToken > 0) searchRef.current?.focus();
  }, [searchFocusToken]);

  // Poll findings for the active scan.
  useEffect(() => {
    if (!scanId) {
      setFindings([]);
      setSelected(new Set());
      return;
    }
    let alive = true;
    const tick = async () => {
      const next = await scanFindings(scanId);
      if (alive && next) setFindings(next);
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [scanId]);

  // Auto-fade transient notices.
  useEffect(() => {
    if (notice === null) return;
    const id = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Reset keyboard focus when the visible list changes under us (filter,
  // sort, search, or new findings pouring in during an active scan).
  useEffect(() => {
    setKbdFocus(-1);
  }, [filter, sort, query, scanId]);

  const counts = useMemo(() => {
    const c: Record<Verdict, number> = {
      clean: 0, info: 0, suspicious: 0, malicious: 0, unknown: 0,
    };
    for (const f of findings) c[f.verdict] += 1;
    return c;
  }, [findings]);

  const visible = useMemo(() => {
    const rank = (v: Verdict): number => {
      if (v === 'malicious') return 0;
      if (v === 'suspicious') return 1;
      if (v === 'info') return 2;
      if (v === 'unknown') return 3;
      return 4;
    };
    const q = query.trim().toLowerCase();
    const filtered = findings.filter(f => {
      if (onlyErrors && f.verdict !== 'malicious' && f.verdict !== 'suspicious') return false;
      if (filter !== 'all' && f.verdict !== filter) return false;
      if (q.length === 0) return true;
      return (
        f.path.toLowerCase().includes(q) ||
        f.summary.toLowerCase().includes(q) ||
        (f.sha256 ?? '').toLowerCase().includes(q)
      );
    });
    const sorted = [...filtered];
    switch (sort) {
      case 'severity':
        sorted.sort((a, b) => rank(a.verdict) - rank(b.verdict) || b.inspectedAt - a.inspectedAt);
        break;
      case 'path':
        sorted.sort((a, b) => a.path.localeCompare(b.path));
        break;
      case 'size':
        sorted.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
        break;
      case 'recent':
        sorted.sort((a, b) => b.inspectedAt - a.inspectedAt);
        break;
    }
    return sorted;
  }, [findings, filter, query, sort, onlyErrors]);

  // ---- Actions ----

  const handleQuarantine = useCallback(
    async (finding: Finding) => {
      if (!scanId || busyId !== null) return;
      setBusyId(finding.id);
      setError(null);
      try {
        const item = await scanQuarantine(scanId, finding.id);
        onQuarantined(item);
        setSelected(prev => {
          if (!prev.has(finding.id)) return prev;
          const next = new Set(prev);
          next.delete(finding.id);
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [scanId, busyId, onQuarantined],
  );

  const handleBulkQuarantine = useCallback(async () => {
    if (!scanId) return;
    if (selected.size === 0) return;
    setBulkBusy(true);
    setError(null);
    let ok = 0;
    let fail = 0;
    for (const id of Array.from(selected)) {
      try {
        const item = await scanQuarantine(scanId, id);
        onQuarantined(item);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setSelected(new Set());
    setBulkBusy(false);
    setNotice(`Moved ${ok} to vault${fail > 0 ? ` · ${fail} failed` : ''}`);
  }, [scanId, selected, onQuarantined]);

  const handleReveal = useCallback(async (path: string) => {
    try {
      await scanRevealInFinder(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleExport = useCallback(async () => {
    const payload = {
      scanId,
      exportedAt: new Date().toISOString(),
      counts,
      findings: visible,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sunny-scan-${scanId ?? 'report'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice(`Exported ${visible.length} findings`);
  }, [scanId, counts, visible]);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected(prev => {
      const visibleIds = new Set(visible.map(f => f.id));
      const allSelected = visible.length > 0 && visible.every(f => prev.has(f.id));
      if (allSelected) return new Set();
      return visibleIds;
    });
  }, [visible]);

  // Arrow-key navigation across rows (j/k for vim flavor). Guarded against
  // edits: typing into search or other inputs never steals keystrokes, and
  // Cmd/Ctrl combos go to the global hotkey hook. Enter/space expands the
  // focused row, x toggles bulk-select, q quarantines.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (inEditable) return;
      if (visible.length === 0) return;

      const key = e.key;
      if (key === 'ArrowDown' || key === 'j') {
        e.preventDefault();
        setKbdFocus(i => Math.min(visible.length - 1, i < 0 ? 0 : i + 1));
        return;
      }
      if (key === 'ArrowUp' || key === 'k') {
        e.preventDefault();
        setKbdFocus(i => Math.max(0, i < 0 ? 0 : i - 1));
        return;
      }
      if (kbdFocus < 0) return;
      const focused = visible[kbdFocus];
      if (!focused) return;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        setExpanded(p => (p === focused.id ? null : focused.id));
        return;
      }
      if (key === 'x') {
        e.preventDefault();
        toggleSelect(focused.id);
        return;
      }
      if (key === 'q') {
        e.preventDefault();
        void handleQuarantine(focused);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, kbdFocus, toggleSelect, handleQuarantine]);

  // ---- Render ----

  if (!scanId) {
    return (
      <div style={emptyStateStyle}>
        NO ACTIVE SCAN — START ONE FROM THE SCAN TAB
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <div style={emptyStateStyle}>
        NO FINDINGS YET — SCAN IS RUNNING OR EVERYTHING IS CLEAN
      </div>
    );
  }

  const selectedCount = selected.size;
  const allVisibleSelected =
    visible.length > 0 && visible.every(f => selected.has(f.id));

  return (
    <>
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>FILTERS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {visible.length} shown · {findings.length} total
          </span>
        </div>

        {/* Search */}
        <label style={labelStyle}>SEARCH</label>
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter by path, summary, or SHA-256…  (press / to focus)"
          style={{ ...inputStyle, marginBottom: 10 }}
          aria-label="Search findings"
        />

        {/* Verdict pills */}
        <label style={labelStyle}>VERDICT</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <FilterChip
            label={`ALL · ${findings.length}`}
            active={filter === 'all'}
            color="var(--cyan)"
            onClick={() => setFilter('all')}
          />
          {VERDICT_ORDER.map(v => (
            <FilterChip
              key={v}
              label={`${VERDICT_META[v].label} · ${counts[v]}`}
              active={filter === v}
              color={VERDICT_META[v].color}
              onClick={() => setFilter(v)}
              disabled={counts[v] === 0}
            />
          ))}
        </div>

        {/* Sort */}
        <label style={labelStyle}>SORT</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SORTS.map(s => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              style={{
                ...chipBaseStyle,
                color: sort === s.id ? 'var(--cyan)' : 'var(--ink-dim)',
                borderColor: sort === s.id ? 'var(--cyan)' : 'var(--line-soft)',
                background:
                  sort === s.id ? 'rgba(57, 229, 255, 0.10)' : 'rgba(6, 14, 22, 0.4)',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Errors-only quick filter */}
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setOnlyErrors(v => !v)}
            style={{
              ...chipBaseStyle,
              color: onlyErrors ? '#ff6a6a' : 'var(--ink-dim)',
              borderColor: onlyErrors ? 'rgba(255,106,106,0.65)' : 'var(--line-soft)',
              background: onlyErrors ? 'rgba(255,106,106,0.08)' : 'rgba(6,14,22,0.4)',
              fontSize: 10,
              letterSpacing: '0.14em',
            }}
            title="Show only malicious and suspicious findings"
          >
            {onlyErrors ? '▲ ERRORS ONLY' : 'ERRORS ONLY'}
          </button>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--ink-dim)' }}>
            Toggle to hide clean / info results
          </span>
        </div>

        {/* Bulk action bar */}
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <button
            onClick={toggleSelectAll}
            style={{
              ...mutedBtnStyle,
              borderColor: allVisibleSelected ? 'var(--cyan)' : 'var(--line-soft)',
              color: allVisibleSelected ? 'var(--cyan)' : 'var(--ink-dim)',
            }}
          >
            {allVisibleSelected ? '☑ DESELECT VISIBLE' : '☐ SELECT VISIBLE'}
          </button>
          <button
            onClick={() => void handleBulkQuarantine()}
            disabled={selectedCount === 0 || bulkBusy}
            style={{
              ...dangerBtnStyle,
              opacity: selectedCount === 0 ? 0.4 : 1,
            }}
          >
            {bulkBusy ? 'QUARANTINING…' : `QUARANTINE ${selectedCount || ''} SELECTED`}
          </button>
          <button onClick={() => void handleExport()} style={mutedBtnStyle}>
            EXPORT JSON
          </button>

          {error && (
            <span style={{ ...hintStyle, color: 'var(--amber)', marginLeft: 'auto' }}>
              {error}
            </span>
          )}
          {notice && (
            <span style={{ ...hintStyle, color: 'rgb(120, 255, 170)', marginLeft: 'auto' }}>
              {notice}
            </span>
          )}
        </div>
      </section>

      <div>
        {visible.map((f, i) => (
          <FindingRow
            key={f.id}
            finding={f}
            expanded={expanded === f.id}
            selected={selected.has(f.id)}
            kbdFocused={kbdFocus === i}
            onToggle={() => setExpanded(p => (p === f.id ? null : f.id))}
            onToggleSelect={() => toggleSelect(f.id)}
            onQuarantine={() => void handleQuarantine(f)}
            onReveal={() => void handleReveal(f.path)}
            busy={busyId === f.id}
          />
        ))}
        {visible.length === 0 && (
          <div style={emptyStateStyle}>NO FINDINGS MATCH THIS FILTER</div>
        )}
        {visible.length > 0 && (
          <div
            style={{
              ...hintStyle,
              fontSize: 9.5,
              marginTop: 8,
              color: 'var(--ink-dim)',
              letterSpacing: '0.16em',
              textAlign: 'center',
            }}
          >
            KEYBOARD · ↑/↓ navigate · ENTER expand · X select · Q quarantine · / search
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function FindingRow({
  finding,
  expanded,
  selected,
  kbdFocused,
  onToggle,
  onToggleSelect,
  onQuarantine,
  onReveal,
  busy,
}: {
  finding: Finding;
  expanded: boolean;
  selected: boolean;
  kbdFocused: boolean;
  onToggle: () => void;
  onToggleSelect: () => void;
  onQuarantine: () => void;
  onReveal: () => void;
  busy: boolean;
}) {
  const meta = VERDICT_META[finding.verdict];
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Scroll the row into view when the keyboard cursor lands on it.
  useEffect(() => {
    if (kbdFocused) {
      rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [kbdFocused]);
  return (
    <div
      ref={rowRef}
      className={`scan-finding-row${kbdFocused ? ' is-kbd-focus' : ''}`}
      style={{
        ...findingRowStyle,
        borderColor: kbdFocused
          ? 'var(--cyan)'
          : selected
            ? 'var(--cyan)'
            : 'var(--line-soft)',
        background: selected ? 'rgba(57, 229, 255, 0.04)' : 'rgba(6, 14, 22, 0.4)',
      }}
    >
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
        style={{
          ...findingHeaderStyle,
          gridTemplateColumns: '18px 96px 1fr auto auto',
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={e => {
            e.stopPropagation();
            onToggleSelect();
          }}
          onClick={e => e.stopPropagation()}
          aria-label="Select for bulk action"
          style={{ accentColor: 'var(--cyan)', cursor: 'pointer' }}
        />
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
          title={finding.path}
        >
          {shortPath(finding.path, 80)}
        </span>
        <span style={{ ...hintStyle, fontSize: 10 }}>
          {formatSize(finding.size)}
        </span>
        <span
          style={{
            ...hintStyle,
            fontSize: 10,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        >
          ▸
        </span>
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
            <span style={{ color: meta.color }}>▸</span> {finding.summary}
          </div>

          {/* Signals */}
          {finding.signals.length > 0 && (
            <>
              <div style={signalHeaderStyle}>SIGNALS · {finding.signals.length}</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {finding.signals.map((s, i) => {
                  const sv = VERDICT_META[s.weight];
                  return (
                    <div
                      key={`${s.kind}-${i}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '110px auto 1fr',
                        gap: 10,
                        alignItems: 'center',
                        padding: '6px 8px',
                        border: '1px dashed var(--line-soft)',
                        background: 'rgba(4, 10, 16, 0.5)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 9.5,
                          letterSpacing: '0.18em',
                          color: 'var(--ink-dim)',
                          textTransform: 'uppercase',
                        }}
                      >
                        {SIGNAL_LABEL[s.kind]}
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          padding: '0 6px',
                          fontFamily: 'var(--mono)',
                          fontSize: 9,
                          letterSpacing: '0.18em',
                          color: sv.color,
                          border: `1px solid ${sv.border}`,
                          background: sv.bg,
                        }}
                      >
                        {sv.label}
                      </span>
                      <span
                        style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)' }}
                      >
                        {s.detail}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Metadata */}
          <div style={{ ...signalHeaderStyle, marginTop: 14 }}>METADATA</div>
          <div style={metaGridStyle}>
            <MetaRow label="PATH" value={finding.path} />
            <MetaRow label="SIZE" value={formatSize(finding.size)} />
            <MetaRow label="SHA-256" value={finding.sha256 ?? '(not hashed)'} />
            <MetaRow label="INSPECTED" value={formatRelativeSecs(finding.inspectedAt)} />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              onClick={onQuarantine}
              disabled={busy}
              style={finding.verdict === 'malicious' ? dangerBtnStyle : primaryBtnStyle}
            >
              {busy ? 'QUARANTINING…' : 'MOVE TO VAULT'}
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
            <button
              style={mutedBtnStyle}
              onClick={e => {
                e.stopPropagation();
                void navigator.clipboard?.writeText(finding.path);
              }}
            >
              COPY PATH
            </button>
            {finding.sha256 && (
              <button
                style={mutedBtnStyle}
                onClick={e => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(finding.sha256 ?? '');
                }}
              >
                COPY SHA-256
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  color,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...chipBaseStyle,
        color: active ? color : 'var(--ink-dim)',
        borderColor: active ? color : 'var(--line-soft)',
        background: active ? 'rgba(57, 229, 255, 0.10)' : 'rgba(6, 14, 22, 0.4)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.22em',
          color: 'var(--ink-dim)',
          textTransform: 'uppercase',
          paddingTop: 2,
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

const signalHeaderStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontSize: 9.5,
  letterSpacing: '0.24em',
  color: 'var(--cyan)',
  textTransform: 'uppercase',
  fontWeight: 700,
  marginBottom: 6,
};

const metaGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '100px 1fr',
  rowGap: 6,
  columnGap: 12,
};
