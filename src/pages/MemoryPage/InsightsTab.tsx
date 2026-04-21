import { useEffect, useMemo, useState, type JSX } from 'react';
import { useInsights, type Insight, type InsightKind } from '../../store/insights';
import { INSIGHT_KIND_META } from './constants';
import {
  DISPLAY_FONT,
  badgeStyle,
  buttonStyle,
  dangerButtonStyle,
  emptyStyle,
  listStyle,
  metaTextStyle,
  rowHeaderStyle,
  rowStyle,
  searchInputStyle,
  searchRowStyle,
  tabStyle,
} from './styles';
import { formatRelativeMs, safeStringify } from './utils';

// ---------------------------------------------------------------------------
// Insights tab — reads directly from the useInsights store
//
// Features:
//   • kind-filter chips (only kinds present in current session show)
//   • text search across title + detail (debounced)
//   • CLEAR wipes the session feed
//   • COPY exports filtered insights as JSON to clipboard — useful for
//     bug reports and for dropping a run's decisions into a notes doc
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 160;

export function InsightsTab(): JSX.Element {
  const insights = useInsights(s => s.insights);
  const clear = useInsights(s => s.clear);
  const [filter, setFilter] = useState<'all' | InsightKind>('all');
  const [rawQuery, setRawQuery] = useState('');
  const query = useDebounced(rawQuery, SEARCH_DEBOUNCE_MS);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  const kindsPresent = useMemo(() => {
    const set = new Set<InsightKind>();
    for (const i of insights) set.add(i.kind);
    return Array.from(set);
  }, [insights]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let rows = filter === 'all' ? insights : insights.filter(i => i.kind === filter);
    if (needle.length > 0) {
      rows = rows.filter(
        i =>
          i.title.toLowerCase().includes(needle) ||
          i.detail.toLowerCase().includes(needle) ||
          i.kind.toLowerCase().includes(needle),
      );
    }
    return rows;
  }, [insights, filter, query]);

  // Auto-clear the "COPIED" chip after 1.5 s so the user gets a
  // clean affordance without needing to manually dismiss anything.
  useEffect(() => {
    if (copiedAt === null) return;
    const t = window.setTimeout(() => setCopiedAt(null), 1500);
    return () => window.clearTimeout(t);
  }, [copiedAt]);

  const onCopy = async (): Promise<void> => {
    const payload = filtered.map(i => ({
      at: new Date(i.createdAt).toISOString(),
      kind: i.kind,
      title: i.title,
      detail: i.detail,
      data: i.data ?? null,
    }));
    const body = JSON.stringify(payload, null, 2);
    try {
      // Prefer the async clipboard API; fall back to a textarea for older
      // WebKits (Tauri uses wry which honors writeText but we belt-and-brace).
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      } else {
        const ta = document.createElement('textarea');
        ta.value = body;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedAt(Date.now());
    } catch (err) {
      console.error('[insights] clipboard copy failed:', err);
    }
  };

  return (
    <>
      <div style={searchRowStyle}>
        <input
          style={searchInputStyle}
          placeholder="Search insights (title + detail)…"
          value={rawQuery}
          onChange={e => setRawQuery(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button style={tabStyle(filter === 'all')} onClick={() => setFilter('all')}>
          ALL <span style={{ opacity: 0.5, marginLeft: 6 }}>{insights.length}</span>
        </button>
        {kindsPresent.map(k => (
          <button key={k} style={tabStyle(filter === k)} onClick={() => setFilter(k)}>
            {INSIGHT_KIND_META[k].label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {filtered.length > 0 && (
          <button style={buttonStyle} onClick={() => void onCopy()}>
            {copiedAt !== null ? 'COPIED' : 'COPY JSON'}
          </button>
        )}
        {insights.length > 0 && (
          <button style={dangerButtonStyle} onClick={() => clear()}>
            CLEAR
          </button>
        )}
      </div>
      {filtered.length === 0 ? (
        <div style={emptyStyle}>
          {insights.length === 0
            ? 'NO INSIGHTS YET · SUNNY will log here when it fires a skill, learns something, or makes a routing decision'
            : query
              ? `NO INSIGHTS MATCH "${query}"`
              : `NO ${filter.toUpperCase()} INSIGHTS`}
        </div>
      ) : (
        <div style={listStyle}>
          {filtered.map(i => (
            <InsightRow key={i.id} insight={i} />
          ))}
        </div>
      )}
    </>
  );
}

function InsightRow({ insight }: { insight: Insight }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const meta = INSIGHT_KIND_META[insight.kind];
  const hasData = insight.data !== undefined && insight.data !== null;
  return (
    <div style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={badgeStyle(meta.color)}>{meta.label}</span>
        <strong style={{ fontFamily: DISPLAY_FONT, fontSize: 11, letterSpacing: '0.12em' }}>
          {insight.title}
        </strong>
        <span style={metaTextStyle}>{formatRelativeMs(insight.createdAt)}</span>
        <span style={{ flex: 1 }} />
        {hasData && (
          <button style={buttonStyle} onClick={() => setExpanded(v => !v)}>
            {expanded ? 'HIDE DATA' : 'DATA'}
          </button>
        )}
      </div>
      <div style={{ color: 'var(--ink)' }}>{insight.detail}</div>
      {expanded && hasData && (
        <pre
          style={{
            margin: 0,
            padding: '6px 8px',
            fontSize: 10.5,
            background: 'rgba(6, 14, 22, 0.7)',
            color: 'var(--ink-dim)',
            border: '1px solid var(--line-soft)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {safeStringify(insight.data)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small debounce hook — local to this tab because the other tabs already
// have their own via useDebouncedQuery in index.tsx. Duplicating keeps
// each tab independently editable without cross-file coupling.
// ---------------------------------------------------------------------------
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
