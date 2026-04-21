import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './Panel';
import type { ProcessRow } from '../hooks/useMetrics';
import { FALLBACK_PROCS } from '../data/seeds';
import { invokeSafe, isTauri } from '../lib/tauri';
import { toast } from '../hooks/useToast';
import { useView } from '../store/view';

type Props = { procs: ProcessRow[] };

type SortMode = 'cpu' | 'mem' | 'name';
type Size = 'auto' | 8 | 16 | 32;

const SORT_KEY = 'sunny.procs.sort.v1';
const SIZE_KEY = 'sunny.procs.size.v2';

function loadSort(): SortMode {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SORT_KEY) : null;
  if (raw === 'mem' || raw === 'name') return raw;
  return 'cpu';
}

function loadSize(): Size {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SIZE_KEY) : null;
  if (raw === '8' || raw === '16' || raw === '32') return Number(raw) as Size;
  if (raw === 'auto') return 'auto';
  return 'auto';
}

function fmtMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

function fmtTotalMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function arrow(delta: number): string {
  if (delta > 0.5) return '\u2191';
  if (delta < -0.5) return '\u2193';
  return '\u00b7';
}

/** Compact long reverse-DNS / bundle-id style process names so they fit on
 *  a single row without relying on ellipsis. Examples:
 *    com.apple.WebKit.WebContent  → WebKit.WebContent
 *    com.apple.WebKit.GPU         → WebKit.GPU
 *    com.docker.backend           → docker.backend
 *  Names that are already short are returned unchanged. */
function shortenProcName(name: string): string {
  if (name.length <= 18) return name;
  if (name.startsWith('com.apple.')) return name.slice('com.apple.'.length);
  if (name.startsWith('com.')) {
    const rest = name.slice(4);
    const dot = rest.indexOf('.');
    return dot > 0 ? rest : rest;
  }
  return name;
}

/** Approximate row height used by auto-size to fit as many rows as possible
 *  into the available panel body. Matches `.proc .row` height in sunny.css
 *  (padding 4px top/bottom + ~16px text = ~24px). */
const ROW_HEIGHT_PX = 24;
const HEADER_HEIGHT_PX = 22;
const FOOTER_HEIGHT_PX = 26;
const FILTER_HEIGHT_PX = 28;

async function revealInActivityMonitor(name: string): Promise<void> {
  if (!isTauri) {
    toast.info(`Would focus ${name} in Activity Monitor`);
    return;
  }
  await invokeSafe<void>('open_app', { name: 'Activity Monitor' });
  toast.success(`Activity Monitor · ${name}`);
}

async function copyPid(name: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(name);
    toast.success(`Copied "${name}"`);
  } catch {
    toast.error('Copy failed');
  }
}

export function ProcessesPanel({ procs }: Props) {
  const { dockHidden } = useView();
  const [sort, setSort] = useState<SortMode>(() => loadSort());
  const [size, setSize] = useState<Size>(() => loadSize());
  const [filter, setFilter] = useState<string>('');
  const [autoRows, setAutoRows] = useState<number>(dockHidden ? 20 : 8);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sort); } catch { /* ignore */ }
  }, [sort]);
  useEffect(() => {
    try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* ignore */ }
  }, [size]);

  // Auto-fit: measure body and compute how many rows fit. Re-measures on
  // dock toggle (height animates from 260 → 556) and viewport resize.
  useEffect(() => {
    if (size !== 'auto') return undefined;
    const el = bodyRef.current;
    if (!el) return undefined;
    const measure = () => {
      const h = el.clientHeight || 0;
      const showFilter = dockHidden;
      const available = h - HEADER_HEIGHT_PX - FOOTER_HEIGHT_PX - (showFilter ? FILTER_HEIGHT_PX : 0);
      const rows = Math.max(5, Math.floor(available / ROW_HEIGHT_PX));
      setAutoRows(rows);
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    const onWin = () => measure();
    window.addEventListener('resize', onWin);
    // Re-measure after CSS height animation completes (~300ms)
    const t = window.setTimeout(measure, 320);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWin);
      window.clearTimeout(t);
    };
  }, [size, dockHidden]);

  const base = procs.length > 0 ? procs : FALLBACK_PROCS;
  const filterLc = filter.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!filterLc) return base;
    return base.filter(p => p.name.toLowerCase().includes(filterLc));
  }, [base, filterLc]);

  const displayCount = size === 'auto' ? autoRows : size;

  const rows = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      if (sort === 'cpu') return b.cpu - a.cpu;
      if (sort === 'mem') return b.mem_mb - a.mem_mb;
      return a.name.localeCompare(b.name);
    });
    return sorted.slice(0, displayCount);
  }, [filtered, sort, displayCount]);

  const prevRef = useRef<Record<string, number>>({});
  const prev = prevRef.current;

  const totalCpu = base.reduce((sum, p) => sum + p.cpu, 0);
  const totalMem = base.reduce((sum, p) => sum + p.mem_mb, 0);

  const nextPrev = rows.reduce<Record<string, number>>(
    (acc, p) => ({ ...acc, [p.name]: p.cpu }),
    {}
  );
  prevRef.current = nextPrev;

  const onRowClick = useCallback((name: string) => {
    void revealInActivityMonitor(name);
  }, []);

  const cycleSize = useCallback(() => {
    setSize(s => {
      if (s === 'auto') return 8;
      if (s === 8) return 16;
      if (s === 16) return 32;
      return 'auto';
    });
  }, []);

  const right = useMemo(() => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={() => setSort(s => (s === 'cpu' ? 'mem' : s === 'mem' ? 'name' : 'cpu'))}
        className="hdr-chip"
        title={`Sort: ${sort.toUpperCase()} — click to cycle`}
      >
        {sort === 'cpu' ? 'CPU' : sort === 'mem' ? 'MEM' : 'A-Z'} ▾
      </button>
      <button
        type="button"
        onClick={cycleSize}
        className="hdr-chip"
        title={`Show ${size === 'auto' ? 'auto' : size} rows — click to cycle`}
      >
        {size === 'auto' ? 'AUTO' : size}
      </button>
    </span>
  ), [sort, size, cycleSize]);

  return (
    <Panel id="p-proc" title="PROCESSES" right={right}>
      <div className="proc" ref={bodyRef} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {dockHidden && (
          <div style={{ marginBottom: 6, height: 22, flexShrink: 0 }}>
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="filter… (e.g. chrome)"
              spellCheck={false}
              style={{
                width: '100%',
                height: 22,
                padding: '0 8px',
                background: 'rgba(57,229,255,0.04)',
                border: '1px solid var(--line-soft)',
                color: 'var(--ink)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}
        <div className="row hdr">
          <span>TOP {rows.length}{filterLc ? ` · ${filtered.length}` : ''}</span>
          <span
            onClick={() => setSort('cpu')}
            className={`sort-h${sort === 'cpu' ? ' active' : ''}`}
          >
            CPU
          </span>
          <span
            onClick={() => setSort('mem')}
            className={`sort-h${sort === 'mem' ? ' active' : ''}`}
          >
            MEM
          </span>
        </div>
        <div style={{ flex: '1 1 auto', overflow: 'hidden' }}>
          {rows.map((p, i) => {
            const previous = prev[p.name];
            const delta = previous === undefined ? 0 : p.cpu - previous;
            const mark = arrow(delta);
            return (
              <div
                key={`${p.name}-${i}`}
                className="row clickable"
                onClick={() => onRowClick(p.name)}
                onContextMenu={e => { e.preventDefault(); void copyPid(p.name); }}
                title={`Open ${p.name} in Activity Monitor · right-click to copy name`}
              >
                <b>
                  <span className="parrow">{mark}</span>
                  <span className="pname">{shortenProcName(p.name)}</span>
                </b>
                <span className={`val${p.cpu > 20 ? ' hi' : ''}`}>{Math.round(p.cpu)}%</span>
                <span className="val">{fmtMem(p.mem_mb)}</span>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div style={{ padding: '8px 0', color: 'var(--ink-dim)', fontSize: 11, textAlign: 'center' }}>
              no matches
            </div>
          )}
        </div>
        <div
          style={{
            flexShrink: 0,
            marginTop: 4,
            paddingTop: 5,
            borderTop: '1px solid var(--line-soft)',
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ink-dim)',
            letterSpacing: '0.06em',
          }}
        >
          <span>Σ {base.length} procs</span>
          <span>CPU <b style={{ color: 'var(--cyan)', fontWeight: 700 }}>{Math.round(totalCpu)}%</b></span>
          <span>MEM <b style={{ color: 'var(--cyan)', fontWeight: 700 }}>{fmtTotalMem(totalMem)}</b></span>
        </div>
      </div>
    </Panel>
  );
}
