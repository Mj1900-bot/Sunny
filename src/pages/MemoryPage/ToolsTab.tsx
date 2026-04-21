import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import {
  DISPLAY_FONT,
  badgeStyle,
  buttonStyle,
  emptyStyle,
  errorStyle,
  listStyle,
  metaTextStyle,
  rowHeaderStyle,
  rowStyle,
  searchInputStyle,
  searchRowStyle,
  tabStyle,
} from './styles';
import { formatRelative } from './utils';
import { TauriRequired } from './TauriRequired';
import { Sparkline, padBuckets, alignToDay, type SparklinePoint } from './Sparkline';
import type { ToolStats, ToolUsageRecord } from './types';

const SPARKLINE_DAYS = 14;

// ---------------------------------------------------------------------------
// Tools tab — per-tool reliability + latency + recent failures.
//
// Feeds from the same `tool_usage` SQLite table the critic consults.
// Three windows (24h / 7d / 30d) matching the retention ceiling. Sort
// options aligned with operational debugging intent:
//   • by calls     — "what's SUNNY using most?"
//   • by success   — "which tools are flaking?"
//   • by latency   — "what's slow?"
//   • by recency   — "what did I just run?"
// ---------------------------------------------------------------------------

type Window = '24h' | '7d' | '30d' | 'all';
const WINDOW_SECS: Record<Window, number | null> = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  all: null,
};

type SortKey = 'count' | 'success' | 'latency' | 'recency';

export function ToolsTab(): JSX.Element {
  const [window, setWindow] = useState<Window>('7d');
  const [sort, setSort] = useState<SortKey>('count');
  const [query, setQuery] = useState('');
  const [stats, setStats] = useState<ReadonlyArray<ToolStats>>([]);
  const [recent, setRecent] = useState<ReadonlyArray<ToolUsageRecord>>([]);
  /** Per-tool 14-day sparkline series, keyed by tool_name. Separate from
   *  stats so we don't have to re-fetch the wide aggregate on each click. */
  const [sparks, setSparks] = useState<Record<string, ReadonlyArray<SparklinePoint>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setErr(null);
    try {
      const since = WINDOW_SECS[window];
      const s = await invokeSafe<ReadonlyArray<ToolStats>>('tool_usage_stats', {
        opts: {
          since_secs_ago: since,
          limit: 200,
        },
      });
      const r = await invokeSafe<ReadonlyArray<ToolUsageRecord>>('tool_usage_recent', {
        opts: {
          only_errors: true,
          limit: 20,
        },
      });
      // One global daily_buckets call (no tool_name filter) — returns
      // every day's combined count. Per-tool sparklines need their own
      // filtered call; we fire those in parallel for the top-20 tools
      // that are actually visible. Backgrounding anything below that
      // tier keeps the initial render fast even on large DBs.
      const topToolNames = (s ?? []).slice(0, 30).map(x => x.tool_name);
      const sparkEntries = await Promise.all(
        topToolNames.map(async (name): Promise<[string, ReadonlyArray<SparklinePoint>]> => {
          const rows = await invokeSafe<ReadonlyArray<SparklinePoint>>(
            'tool_usage_daily_buckets',
            { opts: { tool_name: name, days: SPARKLINE_DAYS } },
          );
          const padded = padBuckets(
            rows ?? [],
            SPARKLINE_DAYS,
            alignToDay(Math.floor(Date.now() / 1000)),
          );
          return [name, padded];
        }),
      );
      setStats(s ?? []);
      setRecent(r ?? []);
      setSparks(Object.fromEntries(sparkEntries));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredSorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let rows = needle.length > 0
      ? stats.filter(s => s.tool_name.toLowerCase().includes(needle))
      : [...stats];
    rows.sort((a, b) => {
      switch (sort) {
        case 'count': return b.count - a.count;
        case 'success': return a.success_rate - b.success_rate; // worst first — what needs attention
        case 'latency': return b.latency_p95_ms - a.latency_p95_ms;
        case 'recency': return (b.last_at ?? 0) - (a.last_at ?? 0);
      }
    });
    return rows;
  }, [stats, sort, query]);

  if (!isTauri) return <TauriRequired />;

  const totalCalls = stats.reduce((sum, s) => sum + s.count, 0);
  const totalOk = stats.reduce((sum, s) => sum + s.ok_count, 0);
  const overallRate = totalCalls > 0 ? (totalOk / totalCalls) : null;

  return (
    <>
      {err && <div style={errorStyle}>ERROR · {err}</div>}

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {(['24h', '7d', '30d', 'all'] as const).map(w => (
          <button
            key={w}
            style={tabStyle(window === w)}
            onClick={() => setWindow(w)}
          >
            {w.toUpperCase()}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {overallRate !== null && (
          <span style={{ ...metaTextStyle, alignSelf: 'center' }}>
            {totalCalls} calls · {Math.round(overallRate * 100)}% overall
          </span>
        )}
        <button style={buttonStyle} onClick={() => void refresh()} disabled={loading}>
          {loading ? 'LOADING' : 'REFRESH'}
        </button>
      </div>

      <div style={searchRowStyle}>
        <input
          style={searchInputStyle}
          placeholder="Filter by tool name…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {(['count', 'success', 'latency', 'recency'] as const).map(k => (
            <button key={k} style={tabStyle(sort === k)} onClick={() => setSort(k)}>
              {k.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {filteredSorted.length === 0 ? (
        <div style={emptyStyle}>
          {stats.length === 0
            ? 'NO TOOL CALLS IN WINDOW · run an agent turn to populate this view'
            : `NO TOOLS MATCH "${query}"`}
        </div>
      ) : (
        <div style={listStyle}>
          {filteredSorted.map(s => (
            <StatRow key={s.tool_name} stats={s} spark={sparks[s.tool_name]} />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <>
          <div
            style={{
              fontFamily: DISPLAY_FONT,
              fontSize: 10,
              letterSpacing: '0.22em',
              color: 'var(--amber)',
              marginTop: 20,
              marginBottom: 8,
              textTransform: 'uppercase',
            }}
          >
            Recent Failures ({recent.length})
          </div>
          <div style={listStyle}>
            {recent.map(r => (
              <FailureRow key={r.id} rec={r} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-tool row
// ---------------------------------------------------------------------------

function StatRow({
  stats,
  spark,
}: {
  stats: ToolStats;
  spark?: ReadonlyArray<SparklinePoint>;
}): JSX.Element {
  const pct = Math.round(stats.success_rate * 100);
  const color =
    stats.success_rate >= 0.9
      ? 'var(--green)'
      : stats.success_rate >= 0.7
        ? 'var(--cyan)'
        : stats.success_rate >= 0.5
          ? 'var(--amber)'
          : 'var(--red)';
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <div style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={badgeStyle(color)}>{pct}%</span>
        <strong style={{ fontFamily: DISPLAY_FONT, fontSize: 11, letterSpacing: '0.12em' }}>
          {stats.tool_name}
        </strong>
        <span style={metaTextStyle}>
          {stats.ok_count}/{stats.count} ok · {stats.err_count} err
        </span>
        <span style={metaTextStyle}>
          p50 {stats.latency_p50_ms}ms · p95 {stats.latency_p95_ms}ms
        </span>
        <span style={{ flex: 1 }} />
        {spark && spark.length > 0 && (
          <Sparkline
            points={spark}
            title={`${stats.tool_name} — last 14 days`}
            width={110}
            height={20}
          />
        )}
        {stats.last_at !== null && (
          <span style={metaTextStyle}>
            last: {formatRelative(stats.last_at, nowSec)} {stats.last_ok ? '✓' : '✗'}
          </span>
        )}
      </div>
      <SuccessBar ok={stats.ok_count} total={stats.count} />
    </div>
  );
}

function SuccessBar({ ok, total }: { ok: number; total: number }): JSX.Element {
  if (total === 0) return <></>;
  const pct = Math.max(0, Math.min(100, Math.round((ok / total) * 100)));
  return (
    <div
      style={{
        height: 4,
        width: '100%',
        background: 'rgba(255, 64, 64, 0.25)',
        position: 'relative',
        marginTop: 2,
      }}
      aria-label={`${pct}% success`}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: 'var(--green)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent failures row
// ---------------------------------------------------------------------------

function FailureRow({ rec }: { rec: ToolUsageRecord }): JSX.Element {
  const nowSec = Math.floor(Date.now() / 1000);
  const short = (rec.error_msg ?? '').trim();
  const display = short.length > 240 ? `${short.slice(0, 237)}…` : short;
  return (
    <div style={{ ...rowStyle, borderColor: 'rgba(255, 64, 64, 0.25)' }}>
      <div style={rowHeaderStyle}>
        <span style={badgeStyle('var(--red)')}>ERR</span>
        <strong style={{ fontFamily: DISPLAY_FONT, fontSize: 11, letterSpacing: '0.12em' }}>
          {rec.tool_name}
        </strong>
        <span style={metaTextStyle}>{formatRelative(rec.created_at, nowSec)}</span>
        <span style={metaTextStyle}>{rec.latency_ms}ms</span>
      </div>
      {display.length > 0 && (
        <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink-dim)', fontSize: 11 }}>
          {display}
        </div>
      )}
    </div>
  );
}
