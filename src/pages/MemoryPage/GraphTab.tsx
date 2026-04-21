import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import {
  DISPLAY_FONT,
  emptyStyle,
  errorStyle,
  metaTextStyle,
  rowStyle,
  searchInputStyle,
} from './styles';
import { KIND_BADGE, LIST_LIMIT } from './constants';
import { TauriRequired } from './TauriRequired';
import type { EpisodicItem, EpisodicKind, SemanticFact } from './types';
import { formatRelativeMs, useDebouncedQuery } from './utils';

function fmtRel(tsSec: number): string {
  // The semantic store stores timestamps in seconds; formatRelativeMs takes
  // milliseconds (and matches the relative-time rules used elsewhere).
  return formatRelativeMs(tsSec * 1000);
}

// ---------------------------------------------------------------------------
// GraphTab — radial graph of everything in memory: semantic facts (by subject)
// and episodic events (by kind). Same caps as the EPISODIC / SEMANTIC tabs.
// ---------------------------------------------------------------------------

type MemoryCluster = {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly store: 'semantic' | 'episodic';
  readonly semanticFacts: ReadonlyArray<SemanticFact>;
  readonly episodicItems: ReadonlyArray<EpisodicItem>;
};

function clusterCount(c: MemoryCluster): number {
  return c.semanticFacts.length + c.episodicItems.length;
}

function episodicKindLabel(kind: EpisodicKind): string {
  return KIND_BADGE[kind]?.label ?? kind.replace(/_/g, ' ').toUpperCase();
}

function episodicKindColor(kind: EpisodicKind): string {
  return KIND_BADGE[kind]?.color ?? 'var(--ink-dim)';
}

const VIEWBOX = 520;
const CENTER = VIEWBOX / 2;
const SUBJECT_RING_MIN = 158;
const SUBJECT_RING_MAX = 196;
const FACT_RING_BASE = 40;
const FACT_RING_STEP = 14;
const MIN_SUBJECT_RADIUS = 12;
const MAX_SUBJECT_RADIUS = 32;
const FACT_RADIUS = 3.5;

const PALETTE = [
  'var(--cyan)',
  'var(--green)',
  'var(--amber)',
  'var(--violet)',
  '#7dd3fc',
  '#f9a8d4',
  '#fca5a5',
  '#86efac',
  '#fcd34d',
  '#c4b5fd',
] as const;

const UNKNOWN_SUBJECT = '(unknown)';

const NO_SUBJECT_COLOR = 'var(--ink-dim)';

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

function subjectColor(subject: string): string {
  if (!subject) return NO_SUBJECT_COLOR;
  return PALETTE[hashHue(subject)];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function subjectRadius(factCount: number, max: number): number {
  if (max <= 0) return MIN_SUBJECT_RADIUS;
  const t = Math.sqrt(factCount / max); // sqrt-scale so one big subject doesn't starve small ones
  return MIN_SUBJECT_RADIUS + (MAX_SUBJECT_RADIUS - MIN_SUBJECT_RADIUS) * t;
}

function hubRingForClusterCount(n: number): number {
  if (n <= 1) return SUBJECT_RING_MIN + 10;
  const t = Math.min(1, Math.max(0, (n - 2) / 26));
  return SUBJECT_RING_MIN + (SUBJECT_RING_MAX - SUBJECT_RING_MIN) * t;
}

function factPackScale(factTotal: number): number {
  if (factTotal <= 28) return 1;
  if (factTotal <= 52) return 1.06;
  return 1.14;
}

function buildMemoryClusters(
  semanticFacts: ReadonlyArray<SemanticFact>,
  episodicItems: ReadonlyArray<EpisodicItem>,
): MemoryCluster[] {
  const out: MemoryCluster[] = [];

  const semMap = new Map<string, SemanticFact[]>();
  for (const f of semanticFacts) {
    const subj = (f.subject ?? '').trim() || UNKNOWN_SUBJECT;
    const list = semMap.get(subj);
    if (list) list.push(f);
    else semMap.set(subj, [f]);
  }
  for (const [subject, sfacts] of semMap) {
    const sorted = [...sfacts].sort((a, b) => b.updated_at - a.updated_at);
    out.push({
      id: `sem:${subject}`,
      label: subject,
      color: subjectColor(subject),
      store: 'semantic',
      semanticFacts: sorted,
      episodicItems: [],
    });
  }

  const epiMap = new Map<EpisodicKind, EpisodicItem[]>();
  for (const it of episodicItems) {
    const list = epiMap.get(it.kind);
    if (list) list.push(it);
    else epiMap.set(it.kind, [it]);
  }
  for (const [kind, items] of epiMap) {
    const sorted = [...items].sort((a, b) => b.created_at - a.created_at);
    out.push({
      id: `epi:${kind}`,
      label: episodicKindLabel(kind),
      color: episodicKindColor(kind),
      store: 'episodic',
      semanticFacts: [],
      episodicItems: sorted,
    });
  }

  out.sort(
    (a, b) =>
      clusterCount(b) - clusterCount(a) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type RailRow =
  | { readonly t: 'semantic'; readonly fact: SemanticFact }
  | { readonly t: 'episodic'; readonly item: EpisodicItem };

function railRowTime(r: RailRow): number {
  return r.t === 'semantic' ? r.fact.updated_at : r.item.created_at;
}

function hoverKeySemantic(id: string): string {
  return `s:${id}`;
}

function hoverKeyEpisodic(id: string): string {
  return `e:${id}`;
}

function clusterIdForRailRow(row: RailRow): string {
  if (row.t === 'semantic') {
    const subj = (row.fact.subject ?? '').trim() || UNKNOWN_SUBJECT;
    return `sem:${subj}`;
  }
  return `epi:${row.item.kind}`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function entranceStyle(delayMs: number, prefersReducedMotion: boolean): CSSProperties {
  if (prefersReducedMotion) {
    return { opacity: 1 };
  }
  return {
    opacity: 0,
    animation: `sunnyGraphFadeUp 0.55s cubic-bezier(0.22, 1, 0.36, 1) forwards`,
    animationDelay: `${delayMs}ms`,
  };
}

export function GraphTab(): JSX.Element {
  const [semanticFacts, setSemanticFacts] = useState<ReadonlyArray<SemanticFact>>([]);
  const [episodicItems, setEpisodicItems] = useState<ReadonlyArray<EpisodicItem>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [highlightClusterId, setHighlightClusterId] = useState<string | null>(null);
  const [showSemantic, setShowSemantic] = useState(true);
  const [showEpisodic, setShowEpisodic] = useState(true);
  const [clusterQueryRaw, setClusterQueryRaw] = useState('');
  const clusterQueryDebounced = useDebouncedQuery(clusterQueryRaw);
  const reqRef = useRef(0);

  const loadData = useCallback(async () => {
    if (!isTauri) return;
    const token = ++reqRef.current;
    setErr(null);
    setLoading(true);
    try {
      const [facts, episodic] = await Promise.all([
        invokeSafe<ReadonlyArray<SemanticFact>>('memory_fact_list', {
          subject: null,
          limit: LIST_LIMIT,
          offset: 0,
        }),
        invokeSafe<ReadonlyArray<EpisodicItem>>('memory_episodic_list', {
          limit: LIST_LIMIT,
          offset: 0,
        }),
      ]);
      if (token !== reqRef.current) return;
      setSemanticFacts(facts ?? []);
      setEpisodicItems(episodic ?? []);
    } catch (e) {
      if (token !== reqRef.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const semanticForGraph = useMemo(
    () => (showSemantic ? semanticFacts : []),
    [showSemantic, semanticFacts],
  );
  const episodicForGraph = useMemo(
    () => (showEpisodic ? episodicItems : []),
    [showEpisodic, episodicItems],
  );

  const allClusters = useMemo(
    () => buildMemoryClusters(semanticForGraph, episodicForGraph),
    [semanticForGraph, episodicForGraph],
  );

  const displayClusters = useMemo(() => {
    const q = clusterQueryDebounced.trim().toLowerCase();
    if (!q) return allClusters;
    return allClusters.filter(c => c.label.toLowerCase().includes(q));
  }, [allClusters, clusterQueryDebounced]);

  const hubRingRadius = useMemo(
    () => hubRingForClusterCount(displayClusters.length),
    [displayClusters.length],
  );

  useEffect(() => {
    if (!selectedClusterId) return;
    if (!displayClusters.some(c => c.id === selectedClusterId)) {
      setSelectedClusterId(null);
    }
  }, [selectedClusterId, displayClusters]);

  const maxClusterCount = useMemo(() => {
    let m = 0;
    for (const c of displayClusters) {
      const n = clusterCount(c);
      if (n > m) m = n;
    }
    return m;
  }, [displayClusters]);

  const selectedCluster = useMemo(
    () =>
      selectedClusterId ? displayClusters.find(c => c.id === selectedClusterId) ?? null : null,
    [displayClusters, selectedClusterId],
  );

  const visibleRows = useMemo((): ReadonlyArray<RailRow> => {
    if (selectedCluster) {
      if (selectedCluster.store === 'semantic') {
        return selectedCluster.semanticFacts.map(f => ({ t: 'semantic' as const, fact: f }));
      }
      return selectedCluster.episodicItems.map(item => ({ t: 'episodic' as const, item }));
    }
    const merged: RailRow[] = [
      ...semanticForGraph.map(f => ({ t: 'semantic' as const, fact: f })),
      ...episodicForGraph.map(item => ({ t: 'episodic' as const, item })),
    ];
    merged.sort((a, b) => railRowTime(b) - railRowTime(a));
    return merged.slice(0, 80);
  }, [semanticForGraph, episodicForGraph, selectedCluster]);

  const focusClusterId = selectedClusterId ?? highlightClusterId;
  const isDimmed = focusClusterId !== null;

  const prefersReducedMotion = usePrefersReducedMotion();

  const graphLayoutKey = useMemo(
    () => displayClusters.map(c => c.id).join('\0'),
    [displayClusters],
  );

  const hoveredSemantic = useMemo(() => {
    if (!hoverKey?.startsWith('s:')) return null;
    const id = hoverKey.slice(2);
    return semanticFacts.find(f => f.id === id) ?? null;
  }, [hoverKey, semanticFacts]);

  const hoveredEpisodic = useMemo(() => {
    if (!hoverKey?.startsWith('e:')) return null;
    const id = hoverKey.slice(2);
    return episodicItems.find(i => i.id === id) ?? null;
  }, [hoverKey, episodicItems]);

  if (!isTauri) return <TauriRequired />;

  const clusterCountN = displayClusters.length;
  const semanticN = semanticFacts.length;
  const episodicN = episodicItems.length;
  const graphSemanticN = semanticForGraph.length;
  const graphEpisodicN = episodicForGraph.length;
  const hasAny = semanticN > 0 || episodicN > 0;
  const graphFiltered =
    allClusters.length !== displayClusters.length ||
    semanticN !== graphSemanticN ||
    episodicN !== graphEpisodicN;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div style={summaryRowStyle}>
        <span style={summaryPillStyle}>
          <strong style={summaryStrong}>{clusterCountN}</strong>&nbsp;CLUSTERS
          {graphFiltered && allClusters.length !== clusterCountN && (
            <span style={{ color: 'var(--ink-dim)', fontWeight: 400 }}>&nbsp;/&nbsp;{allClusters.length}</span>
          )}
        </span>
        <span style={summaryPillStyle} title="Items currently included in the graph (respects layer toggles)">
          <strong style={summaryStrong}>{graphSemanticN}</strong>&nbsp;SEM&nbsp;·&nbsp;
          <strong style={summaryStrong}>{graphEpisodicN}</strong>&nbsp;EPI
        </span>
        <span style={{ ...summaryPillStyle, borderColor: 'transparent', paddingLeft: 0 }}>
          STORE&nbsp;
          <strong style={summaryStrong}>{semanticN}</strong>
          <span style={{ color: 'var(--ink-dim)' }}> / </span>
          <strong style={summaryStrong}>{episodicN}</strong>
        </span>
        {selectedClusterId && (
          <button
            type="button"
            onClick={() => setSelectedClusterId(null)}
            style={clearBtnStyle}
            title="Show all"
          >
            CLEAR FILTER ·{' '}
            {truncate(selectedCluster?.label ?? selectedClusterId, 32)}
          </button>
        )}
        <button
          type="button"
          onClick={() => void loadData()}
          disabled={loading}
          style={refreshBtnStyle}
          title="Reload from disk"
        >
          {loading ? '…' : 'REFRESH'}
        </button>
      </div>

      <div style={controlsRowStyle}>
        <span style={{ color: 'var(--ink-dim)', fontSize: 9, letterSpacing: '0.14em' }}>LAYERS</span>
        <button
          type="button"
          aria-pressed={showSemantic}
          onClick={() => setShowSemantic(v => !v)}
          style={{
            ...layerToggleStyle,
            borderColor: showSemantic ? 'rgba(57, 229, 255, 0.45)' : 'var(--line-soft)',
            color: showSemantic ? 'var(--cyan)' : 'var(--ink-dim)',
            opacity: showSemantic ? 1 : 0.55,
          }}
        >
          SEMANTIC
        </button>
        <button
          type="button"
          aria-pressed={showEpisodic}
          onClick={() => setShowEpisodic(v => !v)}
          style={{
            ...layerToggleStyle,
            borderColor: showEpisodic ? 'rgba(57, 229, 255, 0.45)' : 'var(--line-soft)',
            color: showEpisodic ? 'var(--cyan)' : 'var(--ink-dim)',
            opacity: showEpisodic ? 1 : 0.55,
          }}
        >
          EPISODIC
        </button>
        <input
          type="search"
          value={clusterQueryRaw}
          onChange={e => setClusterQueryRaw(e.target.value)}
          placeholder="Filter clusters…"
          aria-label="Filter clusters by name"
          style={{ ...searchInputStyle, flex: 1, minWidth: 140, maxWidth: 320 }}
        />
      </div>

      {err && <div style={errorStyle}>{err}</div>}

      {!hasAny && !loading ? (
        <div style={emptyStyle}>
          NO MEMORIES YET — add episodic notes or run the agent; semantic facts appear after consolidation.
        </div>
      ) : displayClusters.length === 0 && !loading ? (
        <div style={emptyStyle}>
          {!showSemantic && !showEpisodic
            ? 'ENABLE SEMANTIC OR EPISODIC TO BUILD THE GRAPH.'
            : clusterQueryDebounced.trim()
              ? 'NO CLUSTERS MATCH THIS FILTER — try another search or clear the box.'
              : 'NO CLUSTERS IN VIEW.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(360px, 1fr) minmax(260px, 340px)',
            gap: 14,
            minHeight: 0,
          }}
        >
          {/* -------- SVG graph -------- */}
          <div style={canvasFrameStyle}>
            <style>{`
              @keyframes sunnyGraphFadeUp {
                from {
                  opacity: 0;
                  transform: translate3d(0, 7px, 0);
                }
                to {
                  opacity: 1;
                  transform: translate3d(0, 0, 0);
                }
              }
              @keyframes sunnyGraphTooltipIn {
                from {
                  opacity: 0;
                  transform: translate3d(0, 6px, 0);
                }
                to {
                  opacity: 1;
                  transform: translate3d(0, 0, 0);
                }
              }
            `}</style>
            <svg
              viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
              width="100%"
              height="100%"
              style={{ display: 'block' }}
              role="img"
              aria-label="Memory graph: semantic subjects and episodic kinds"
              onMouseLeave={() => {
                setHighlightClusterId(null);
                setHoverKey(null);
              }}
            >
              <defs>
                <filter
                  id="sunnyGraphHubGlow"
                  x="-65%"
                  y="-65%"
                  width="230%"
                  height="230%"
                  colorInterpolationFilters="sRGB"
                >
                  <feGaussianBlur in="SourceAlpha" stdDeviation="2.2" result="b" />
                  <feOffset in="b" dx="0" dy="0" result="o" />
                  <feMerge>
                    <feMergeNode in="o" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <radialGradient id="sunnyGraphCanvasVignette" cx="50%" cy="45%" r="58%">
                  <stop offset="0%" stopColor="rgba(57, 229, 255, 0.07)" />
                  <stop offset="55%" stopColor="rgba(4, 10, 16, 0)" />
                  <stop offset="100%" stopColor="rgba(4, 10, 16, 0.5)" />
                </radialGradient>
              </defs>

              <rect
                x={0}
                y={0}
                width={VIEWBOX}
                height={VIEWBOX}
                fill="url(#sunnyGraphCanvasVignette)"
                style={{ pointerEvents: 'none' }}
              />

              {/* outer ring guide — slow rotate (dashes appear to drift) */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={hubRingRadius}
                fill="none"
                stroke="rgba(57, 229, 255, 0.12)"
                strokeWidth={1}
                strokeDasharray="4 9"
                strokeLinecap="round"
              >
                {!prefersReducedMotion && (
                  <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from={`0 ${CENTER} ${CENTER}`}
                    to={`360 ${CENTER} ${CENTER}`}
                    dur="110s"
                    repeatCount="indefinite"
                  />
                )}
              </circle>

              <g key={graphLayoutKey} className="sunny-graph-root">
              {/* edges from hub to satellites */}
              {displayClusters.map((cluster, i) => {
                const pos = clusterPosition(i, displayClusters.length, hubRingRadius);
                const n = clusterCount(cluster);
                const pack = factPackScale(n);
                const faded = isDimmed && focusClusterId !== cluster.id;
                return (
                  <g
                    key={`edges-${cluster.id}`}
                    style={entranceStyle(18 + i * 32, prefersReducedMotion)}
                  >
                    {cluster.semanticFacts.map((f, fi) => {
                      const satellite = factSatellite(pos, fi, n, pack);
                      const hk = hoverKeySemantic(f.id);
                      return (
                        <line
                          key={`edge-${f.id}`}
                          x1={pos.x}
                          y1={pos.y}
                          x2={satellite.x}
                          y2={satellite.y}
                          stroke={cluster.color}
                          strokeOpacity={faded ? 0.06 : hoverKey === hk ? 0.88 : 0.38}
                          strokeWidth={hoverKey === hk ? 1.5 : 0.65}
                        />
                      );
                    })}
                    {cluster.episodicItems.map((it, fi) => {
                      const offset = cluster.semanticFacts.length;
                      const satellite = factSatellite(pos, fi + offset, n, pack);
                      const hk = hoverKeyEpisodic(it.id);
                      return (
                        <line
                          key={`edge-${it.id}`}
                          x1={pos.x}
                          y1={pos.y}
                          x2={satellite.x}
                          y2={satellite.y}
                          stroke={cluster.color}
                          strokeOpacity={faded ? 0.06 : hoverKey === hk ? 0.88 : 0.38}
                          strokeWidth={hoverKey === hk ? 1.5 : 0.65}
                        />
                      );
                    })}
                  </g>
                );
              })}

              {/* satellites — circles = semantic, diamonds = episodic */}
              {displayClusters.map((cluster, i) => {
                const pos = clusterPosition(i, displayClusters.length, hubRingRadius);
                const n = clusterCount(cluster);
                const pack = factPackScale(n);
                const faded = isDimmed && focusClusterId !== cluster.id;
                let nodeIdx = 0;
                return (
                  <g key={`dots-${cluster.id}`}>
                    {cluster.semanticFacts.map((f, fi) => {
                      const s = factSatellite(pos, fi, n, pack);
                      const hk = hoverKeySemantic(f.id);
                      const isHover = hoverKey === hk;
                      const pr = isHover ? FACT_RADIUS + 1.6 : FACT_RADIUS;
                      const d = 72 + i * 34 + nodeIdx++ * 10;
                      return (
                        <g key={f.id} style={entranceStyle(d, prefersReducedMotion)}>
                          <title>{truncate(f.text, 160)}</title>
                          <circle
                            cx={s.x}
                            cy={s.y}
                            r={pr}
                            fill={cluster.color}
                            fillOpacity={faded ? 0.18 : isHover ? 1 : 0.78}
                            stroke={isHover ? 'var(--ink)' : 'rgba(255,255,255,0.12)'}
                            strokeWidth={isHover ? 1.2 : 0.6}
                            style={{
                              cursor: 'pointer',
                              transition:
                                'r 0.22s cubic-bezier(0.22, 1, 0.36, 1), fill-opacity 0.2s ease, stroke-width 0.2s ease',
                            }}
                            onMouseEnter={() => {
                              setHighlightClusterId(cluster.id);
                              setHoverKey(hk);
                            }}
                          />
                        </g>
                      );
                    })}
                    {cluster.episodicItems.map((it, fi) => {
                      const offset = cluster.semanticFacts.length;
                      const s = factSatellite(pos, fi + offset, n, pack);
                      const hk = hoverKeyEpisodic(it.id);
                      const isHover = hoverKey === hk;
                      const pr = isHover ? FACT_RADIUS + 1.6 : FACT_RADIUS;
                      const side = pr * 2.75;
                      const d = 72 + i * 34 + nodeIdx++ * 10;
                      return (
                        <g key={it.id} style={entranceStyle(d, prefersReducedMotion)}>
                          <title>{truncate(it.text, 160)}</title>
                          <g
                            transform={`translate(${s.x},${s.y}) rotate(45)`}
                            style={{ cursor: 'pointer' }}
                            onMouseEnter={() => {
                              setHighlightClusterId(cluster.id);
                              setHoverKey(hk);
                            }}
                          >
                            <rect
                              x={-side / 2}
                              y={-side / 2}
                              width={side}
                              height={side}
                              fill={cluster.color}
                              fillOpacity={faded ? 0.18 : isHover ? 1 : 0.78}
                              stroke={isHover ? 'var(--ink)' : 'rgba(255,255,255,0.12)'}
                              strokeWidth={isHover ? 1.2 : 0.6}
                              style={{
                                transition:
                                  'fill-opacity 0.2s ease, stroke-width 0.2s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
                              }}
                            />
                          </g>
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {/* hub nodes */}
              {displayClusters.map((cluster, i) => {
                const pos = clusterPosition(i, displayClusters.length, hubRingRadius);
                const cnt = clusterCount(cluster);
                const r = subjectRadius(cnt, maxClusterCount);
                const active = selectedClusterId === cluster.id;
                const dimmed = isDimmed && focusClusterId !== cluster.id;
                const hubHot = highlightClusterId === cluster.id || active;
                const hubLabel =
                  cluster.store === 'semantic'
                    ? truncate(cluster.label.toUpperCase(), 12)
                    : truncate(cluster.label, 12);
                return (
                  <g key={`sub-${cluster.id}`} transform={`translate(${pos.x}, ${pos.y})`}>
                    <g
                      style={{
                        cursor: 'pointer',
                        ...entranceStyle(48 + i * 40, prefersReducedMotion),
                      }}
                      onMouseEnter={() => setHighlightClusterId(cluster.id)}
                      onClick={() =>
                        setSelectedClusterId(prev => (prev === cluster.id ? null : cluster.id))
                      }
                    >
                      <circle
                        cx={0}
                        cy={0}
                        r={active ? r * 1.06 : r}
                        fill={cluster.color}
                        fillOpacity={dimmed ? 0.12 : active ? 0.42 : 0.26}
                        stroke={cluster.color}
                        strokeOpacity={dimmed ? 0.22 : 1}
                        strokeWidth={active ? 2.8 : 1.5}
                        filter={hubHot && !dimmed ? 'url(#sunnyGraphHubGlow)' : undefined}
                        style={{
                          transition:
                            'fill-opacity 0.25s ease, stroke-width 0.22s cubic-bezier(0.22, 1, 0.36, 1), r 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                      />
                      <text
                        x={0}
                        y={3}
                        fill={dimmed ? 'var(--ink-dim)' : 'var(--ink)'}
                        fontFamily="var(--mono)"
                        fontSize={9}
                        textAnchor="middle"
                        style={{ letterSpacing: '0.1em', pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {hubLabel}
                      </text>
                      <text
                        x={0}
                        y={14}
                        fill={dimmed ? 'var(--ink-dim)' : cluster.color}
                        fontFamily="var(--mono)"
                        fontSize={8}
                        textAnchor="middle"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        ×{cnt}
                      </text>
                    </g>
                  </g>
                );
              })}

              </g>

              <text
                x={CENTER}
                y={CENTER - 6}
                fill="var(--cyan)"
                fontFamily={DISPLAY_FONT}
                fontSize={10}
                textAnchor="middle"
                style={{ letterSpacing: '0.22em', userSelect: 'none' }}
              >
                MEMORY
              </text>
              <text
                x={CENTER}
                y={CENTER + 8}
                fill="var(--ink-2)"
                fontFamily="var(--mono)"
                fontSize={8}
                textAnchor="middle"
                style={{ letterSpacing: '0.18em', userSelect: 'none' }}
              >
                GRAPH
              </text>
              <text
                x={CENTER}
                y={CENTER + 24}
                fill="var(--ink-dim)"
                fontFamily="var(--mono)"
                fontSize={7}
                textAnchor="middle"
                style={{ letterSpacing: '0.12em', userSelect: 'none' }}
              >
                ○ FACT · ◇ EVENT
              </text>
            </svg>

            {(hoveredSemantic || hoveredEpisodic) && (
              <div
                style={{
                  ...tooltipStyle,
                  animation: prefersReducedMotion
                    ? undefined
                    : 'sunnyGraphTooltipIn 0.32s cubic-bezier(0.22, 1, 0.36, 1) both',
                }}
              >
                {hoveredSemantic && (
                  <>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 9,
                        color: 'var(--ink-dim)',
                        letterSpacing: '0.14em',
                      }}
                    >
                      SEMANTIC · {(hoveredSemantic.subject || UNKNOWN_SUBJECT).toUpperCase()} · CONF{' '}
                      {hoveredSemantic.confidence.toFixed(2)}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--label)',
                        fontSize: 12,
                        color: 'var(--ink)',
                        marginTop: 4,
                        lineHeight: 1.4,
                      }}
                    >
                      {truncate(hoveredSemantic.text, 200)}
                    </div>
                    <div style={{ ...metaTextStyle, marginTop: 4 }}>
                      {fmtRel(hoveredSemantic.updated_at)} · {hoveredSemantic.source}
                    </div>
                  </>
                )}
                {hoveredEpisodic && (
                  <>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 9,
                        color: 'var(--ink-dim)',
                        letterSpacing: '0.14em',
                      }}
                    >
                      EPISODIC · {episodicKindLabel(hoveredEpisodic.kind)}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--label)',
                        fontSize: 12,
                        color: 'var(--ink)',
                        marginTop: 4,
                        lineHeight: 1.4,
                      }}
                    >
                      {truncate(hoveredEpisodic.text, 200)}
                    </div>
                    <div style={{ ...metaTextStyle, marginTop: 4 }}>
                      {fmtRel(hoveredEpisodic.created_at)}
                      {hoveredEpisodic.tags.length > 0
                        ? ` · ${hoveredEpisodic.tags.slice(0, 4).join(', ')}`
                        : ''}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* -------- Detail rail -------- */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <div
              style={{
                fontFamily: DISPLAY_FONT,
                fontSize: 10,
                letterSpacing: '0.22em',
                color: selectedCluster ? selectedCluster.color : 'var(--cyan)',
                fontWeight: 700,
                padding: '4px 2px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>
                {selectedCluster
                  ? truncate(
                      selectedCluster.store === 'semantic'
                        ? selectedCluster.label.toUpperCase()
                        : selectedCluster.label,
                      28,
                    )
                  : 'RECENT MEMORY'}
              </span>
              <span style={{ color: 'var(--ink-dim)', fontSize: 9 }}>
                {visibleRows.length} ITEMS
              </span>
            </div>

            <div style={subjectChipsRowStyle}>
              {displayClusters.slice(0, 12).map(cluster => {
                const active = selectedClusterId === cluster.id;
                const chipText =
                  cluster.store === 'semantic' ? truncate(cluster.label, 14) : truncate(cluster.label, 16);
                return (
                  <button
                    key={cluster.id}
                    type="button"
                    onClick={() =>
                      setSelectedClusterId(prev => (prev === cluster.id ? null : cluster.id))
                    }
                    style={{
                      ...subjectChipStyle,
                      borderColor: active ? cluster.color : 'var(--line-soft)',
                      background: active ? 'rgba(57, 229, 255, 0.1)' : 'rgba(6, 14, 22, 0.55)',
                      color: active ? cluster.color : 'var(--ink-2)',
                    }}
                    title={cluster.store === 'semantic' ? 'Semantic subject' : 'Episodic kind'}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: cluster.store === 'semantic' ? 3 : 0,
                        transform: cluster.store === 'episodic' ? 'rotate(45deg)' : undefined,
                        background: cluster.color,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chipText}
                    </span>
                    <span style={{ color: 'var(--ink-dim)', fontSize: 9 }}>×{clusterCount(cluster)}</span>
                  </button>
                );
              })}
              {displayClusters.length > 12 && (
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    letterSpacing: '0.12em',
                    color: 'var(--ink-dim)',
                    padding: '4px 6px',
                  }}
                >
                  +{displayClusters.length - 12} MORE
                </span>
              )}
            </div>

            <div
              style={factListStyle}
              onMouseLeave={() => {
                setHighlightClusterId(null);
                setHoverKey(null);
              }}
            >
              {visibleRows.length === 0 ? (
                <div style={emptyStyle}>Nothing in this cluster.</div>
              ) : (
                visibleRows.map(row => {
                  if (row.t === 'semantic') {
                    const f = row.fact;
                    const color = subjectColor(f.subject || UNKNOWN_SUBJECT);
                    const hk = hoverKeySemantic(f.id);
                    const isHover = hoverKey === hk;
                    const cid = clusterIdForRailRow(row);
                    const inView = displayClusters.some(c => c.id === cid);
                    return (
                      <div
                        key={`s-${f.id}`}
                        style={{
                          ...rowStyle,
                          borderLeft: `2px solid ${color}`,
                          background: isHover ? 'rgba(57, 229, 255, 0.07)' : 'rgba(4, 10, 16, 0.45)',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={() => {
                          if (inView) setHighlightClusterId(cid);
                          setHoverKey(hk);
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontFamily: 'var(--mono)',
                            fontSize: 9,
                            color: 'var(--ink-dim)',
                            letterSpacing: '0.14em',
                            marginBottom: 3,
                          }}
                        >
                          <span style={{ color }}>SEM · {(f.subject || UNKNOWN_SUBJECT).toUpperCase()}</span>
                          <span>{fmtRel(f.updated_at)}</span>
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--label)',
                            fontSize: 12,
                            color: 'var(--ink)',
                            lineHeight: 1.4,
                          }}
                        >
                          {f.text}
                        </div>
                        <div
                          style={{
                            ...metaTextStyle,
                            marginTop: 3,
                            display: 'flex',
                            gap: 10,
                            fontSize: 9,
                          }}
                        >
                          <span>CONF {f.confidence.toFixed(2)}</span>
                          <span>{f.source}</span>
                        </div>
                      </div>
                    );
                  }
                  const item = row.item;
                  const color = episodicKindColor(item.kind);
                  const hk = hoverKeyEpisodic(item.id);
                  const isHover = hoverKey === hk;
                  const cid = clusterIdForRailRow(row);
                  const inView = displayClusters.some(c => c.id === cid);
                  return (
                    <div
                      key={`e-${item.id}`}
                      style={{
                        ...rowStyle,
                        borderLeft: `2px solid ${color}`,
                        background: isHover ? 'rgba(57, 229, 255, 0.07)' : 'rgba(4, 10, 16, 0.45)',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={() => {
                        if (inView) setHighlightClusterId(cid);
                        setHoverKey(hk);
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontFamily: 'var(--mono)',
                          fontSize: 9,
                          color: 'var(--ink-dim)',
                          letterSpacing: '0.14em',
                          marginBottom: 3,
                        }}
                      >
                        <span style={{ color }}>EPI · {episodicKindLabel(item.kind)}</span>
                        <span>{fmtRel(item.created_at)}</span>
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--label)',
                          fontSize: 12,
                          color: 'var(--ink)',
                          lineHeight: 1.4,
                        }}
                      >
                        {item.text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function clusterPosition(
  index: number,
  total: number,
  ringRadius: number,
): { readonly x: number; readonly y: number } {
  if (total === 0) return { x: CENTER, y: CENTER };
  const theta = (index / total) * Math.PI * 2 - Math.PI / 2;
  return {
    x: CENTER + Math.cos(theta) * ringRadius,
    y: CENTER + Math.sin(theta) * ringRadius,
  };
}

function factSatellite(
  hub: { readonly x: number; readonly y: number },
  factIndex: number,
  factTotal: number,
  packScale: number,
): { readonly x: number; readonly y: number } {
  if (factTotal <= 0) return hub;
  const slotsPerRing = 8;
  const ring = Math.floor(factIndex / slotsPerRing);
  const slot = factIndex % slotsPerRing;
  const radius = (FACT_RING_BASE + ring * FACT_RING_STEP) * packScale;
  const phase = ring % 2 === 0 ? 0 : Math.PI / slotsPerRing;
  const theta = (slot / slotsPerRing) * Math.PI * 2 + phase;
  return {
    x: hub.x + Math.cos(theta) * radius,
    y: hub.y + Math.sin(theta) * radius,
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const summaryRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  letterSpacing: '0.12em',
};

const summaryPillStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  padding: '3px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
};

const summaryStrong: CSSProperties = {
  color: 'var(--cyan)',
  fontWeight: 700,
};

const clearBtnStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '3px 10px',
  border: '1px solid rgba(255, 179, 71, 0.4)',
  background: 'rgba(255, 179, 71, 0.08)',
  color: 'var(--amber)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
};

const canvasFrameStyle: CSSProperties = {
  position: 'relative',
  border: '1px solid var(--line-soft)',
  borderRadius: 10,
  overflow: 'hidden',
  background:
    'radial-gradient(ellipse 85% 70% at 50% 42%, rgba(57, 229, 255, 0.07) 0%, rgba(4, 10, 16, 0.92) 52%, rgba(2, 6, 10, 0.98) 100%)',
  boxShadow:
    'inset 0 1px 0 rgba(255, 255, 255, 0.04), inset 0 0 48px rgba(57, 229, 255, 0.04), 0 8px 32px rgba(0, 0, 0, 0.45)',
  padding: 10,
  aspectRatio: '1',
  minHeight: 0,
  maxHeight: 520,
};

const tooltipStyle: CSSProperties = {
  position: 'absolute',
  left: 14,
  bottom: 14,
  maxWidth: 260,
  padding: '10px 12px',
  border: '1px solid rgba(57, 229, 255, 0.2)',
  borderRadius: 6,
  background: 'linear-gradient(165deg, rgba(12, 22, 30, 0.97) 0%, rgba(4, 10, 16, 0.98) 100%)',
  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.5), 0 0 20px rgba(57, 229, 255, 0.08)',
  pointerEvents: 'none',
  backdropFilter: 'blur(8px)',
};

const subjectChipsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const subjectChipStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.1em',
  maxWidth: 180,
  transition: 'border-color 0.2s ease, background 0.2s ease, color 0.2s ease, transform 0.18s ease',
};

const factListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '2px 0',
};

const controlsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
};

const layerToggleStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  borderRadius: 4,
  transition: 'border-color 0.2s ease, color 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease',
};

const refreshBtnStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '3px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
};
