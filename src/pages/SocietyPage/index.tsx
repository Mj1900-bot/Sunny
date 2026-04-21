/**
 * SOCIETY — the roster of agent personas + live sub-agent fleet.
 *
 * Distinct from AUTO, which shows scheduled jobs. SOCIETY answers:
 * "who are Sunny's sub-agents and what are they built for?" plus "what's
 * actually running right now." The roster pulls `ROLES` from the society
 * dispatcher config; the fleet pulls from `useSubAgentsLive`.
 *
 * Layout:
 *  1. Header stats + quick actions (span 12)
 *  2. Roster grid (span 7) | Fleet orbit + distribution (span 5)
 *  3. Live fleet tree (span 12)
 */

import { useMemo, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, ScrollList,
  PageLead, Toolbar, ToolbarButton, TabBar, FilterInput,
  useDebounced, useFlashMessage,
} from '../_shared';
import { downloadTextFile, societyFleetJson } from '../_shared/snapshots';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import { ROLES, type RoleId } from '../../lib/society/roles';
import {
  useSubAgentsLive,
  type SubAgent,
  type SubAgentRole,
} from '../../store/subAgentsLive';
import { RoleCard } from './RoleCard';
import { FleetNode } from './FleetNode';
import { FleetOrbit } from './FleetOrbit';
import { RoleDistribution } from './RoleDistribution';
import { TranscriptPanel } from './TranscriptPanel';
import { selectVisibleFleet, type FleetMode } from './fleetVisibility';

// ---------------------------------------------------------------------------
// Graph view types
// ---------------------------------------------------------------------------

type FleetView = 'list' | 'graph';

type GraphNode = {
  readonly agent: SubAgent;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
};

type GraphEdge = {
  readonly from: GraphNode;
  readonly to: GraphNode;
  readonly status: SubAgent['status'];
  /** Parent endedAt → child startedAt, in ms. Null when parent still running. */
  readonly handoffMs: number | null;
};

const GRAPH_NODE_WIDTH = 180;
const GRAPH_NODE_HEIGHT = 62;
const GRAPH_H_GAP = 24;
const GRAPH_V_GAP = 90;
const GRAPH_PAD_X = 24;
const GRAPH_PAD_Y = 20;

function edgeStroke(status: SubAgent['status']): string {
  if (status === 'running') return 'var(--cyan)';
  if (status === 'error') return 'var(--red)';
  return 'var(--green)';
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Lay out the fleet as a top-down tree. Roots sit on a shared top row, each
 * subtree gets its own horizontal slot based on descendant leaf count.
 */
function layoutGraph(
  roots: ReadonlyArray<SubAgent>,
  childrenOf: Map<string, SubAgent[]>,
): { readonly nodes: ReadonlyArray<GraphNode>; readonly edges: ReadonlyArray<GraphEdge>; readonly width: number; readonly height: number } {
  // Count leaf slots per subtree (min 1) to allocate horizontal width.
  const leafCount = new Map<string, number>();
  const computeLeaves = (a: SubAgent): number => {
    const kids = childrenOf.get(a.id) ?? [];
    if (kids.length === 0) {
      leafCount.set(a.id, 1);
      return 1;
    }
    const n = kids.reduce((acc, k) => acc + computeLeaves(k), 0);
    leafCount.set(a.id, n);
    return n;
  };
  for (const r of roots) computeLeaves(r);

  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  let cursorSlot = 0;
  let maxDepth = 0;

  const place = (agent: SubAgent, depth: number, parent: GraphNode | null): void => {
    const kids = childrenOf.get(agent.id) ?? [];
    const leaves = leafCount.get(agent.id) ?? 1;
    const slotStart = cursorSlot;

    if (kids.length === 0) {
      cursorSlot += 1;
    } else {
      for (const k of kids) place(k, depth + 1, null);
    }

    const slotCenter = (slotStart + leaves / 2) - 0.5;
    const x = GRAPH_PAD_X + slotCenter * (GRAPH_NODE_WIDTH + GRAPH_H_GAP);
    const y = GRAPH_PAD_Y + depth * GRAPH_V_GAP;
    const node: GraphNode = { agent, x, y, depth };
    nodes.push(node);
    nodeById.set(agent.id, node);
    maxDepth = Math.max(maxDepth, depth);

    // Re-link children edges now that we have a node reference.
    for (const k of kids) {
      const childNode = nodeById.get(k.id);
      if (!childNode) continue;
      const handoffMs = agent.endedAt != null ? k.startedAt - agent.endedAt : null;
      edges.push({
        from: node,
        to: childNode,
        status: k.status,
        handoffMs,
      });
    }
    // `parent` is only non-null via the roots loop path which doesn't emit
    // an edge (no parent above a root).
    void parent;
  };

  for (const r of roots) place(r, 0, null);

  const slotsUsed = Math.max(1, cursorSlot);
  const width = GRAPH_PAD_X * 2 + slotsUsed * GRAPH_NODE_WIDTH + (slotsUsed - 1) * GRAPH_H_GAP;
  const height = GRAPH_PAD_Y * 2 + (maxDepth + 1) * GRAPH_V_GAP;
  return { nodes, edges, width, height };
}

/** Build a short narrative of recent hand-offs for screen readers and a log strip. */
function describeHandoffs(edges: ReadonlyArray<GraphEdge>): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const e of edges) {
    const parentDone = e.from.agent.endedAt;
    const childStart = e.to.agent.startedAt;
    if (parentDone == null) {
      lines.push(
        `${e.from.agent.role} still running — ${e.to.agent.role} started at ${formatClock(childStart)} (${e.to.agent.tokenEstimate} tok so far)`,
      );
    } else {
      const gap = e.handoffMs != null && e.handoffMs >= 0 ? `${Math.round(e.handoffMs / 1000)}s later` : 'immediately';
      lines.push(
        `${e.from.agent.role} finished at ${formatClock(parentDone)}, passed ${e.from.agent.tokenEstimate} tok to ${e.to.agent.role} at ${formatClock(childStart)} (${gap})`,
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// FleetGraph — SVG parent→child visualisation
// ---------------------------------------------------------------------------

function FleetGraph({
  roots,
  childrenOf,
  onSelect,
}: {
  roots: ReadonlyArray<SubAgent>;
  childrenOf: Map<string, SubAgent[]>;
  onSelect: (a: SubAgent) => void;
}) {
  const { nodes, edges, width, height } = useMemo(
    () => layoutGraph(roots, childrenOf),
    [roots, childrenOf],
  );
  const handoffLines = useMemo(() => describeHandoffs(edges), [edges]);

  if (nodes.length === 0) {
    return (
      <EmptyState
        title="No agents to graph"
        hint="Roots and children appear once a parent spawns at least one sub-agent."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ overflowX: 'auto', overflowY: 'hidden', border: '1px solid var(--line-soft)' }}>
        <svg
          role="img"
          aria-label={`Agent fleet graph with ${nodes.length} nodes and ${edges.length} hand-offs`}
          width={width}
          height={height}
          style={{ display: 'block', minWidth: '100%' }}
        >
          <defs>
            <marker
              id="fleet-arrow-cyan"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="var(--cyan)" />
            </marker>
            <marker
              id="fleet-arrow-green"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="var(--green)" />
            </marker>
            <marker
              id="fleet-arrow-red"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="var(--red)" />
            </marker>
          </defs>

          {/* Edges (drawn first so nodes sit on top) */}
          {edges.map((e, i) => {
            const x1 = e.from.x + GRAPH_NODE_WIDTH / 2;
            const y1 = e.from.y + GRAPH_NODE_HEIGHT;
            const x2 = e.to.x + GRAPH_NODE_WIDTH / 2;
            const y2 = e.to.y;
            const midY = (y1 + y2) / 2;
            const stroke = edgeStroke(e.status);
            const arrowId =
              e.status === 'running' ? 'fleet-arrow-cyan'
              : e.status === 'error' ? 'fleet-arrow-red'
              : 'fleet-arrow-green';
            const labelX = (x1 + x2) / 2;
            const labelY = midY - 2;
            const handoffLabel =
              e.handoffMs != null && e.handoffMs >= 0
                ? `+${Math.round(e.handoffMs / 1000)}s`
                : e.from.agent.endedAt == null ? 'live' : '0s';
            return (
              <g key={`${e.from.agent.id}-${e.to.agent.id}-${i}`}>
                <path
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={1.5}
                  strokeDasharray={e.status === 'running' ? '4 3' : undefined}
                  markerEnd={`url(#${arrowId})`}
                  opacity={0.85}
                >
                  {e.status === 'running' && (
                    <animate
                      attributeName="stroke-dashoffset"
                      from="0"
                      to="14"
                      dur="1.2s"
                      repeatCount="indefinite"
                    />
                  )}
                </path>
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    fill: stroke,
                    letterSpacing: '0.04em',
                  }}
                >
                  {handoffLabel}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map(n => {
            const tone =
              n.agent.status === 'running' ? 'cyan'
              : n.agent.status === 'error' ? 'red'
              : 'green';
            return (
              <g
                key={n.agent.id}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: 'pointer' }}
                onClick={() => onSelect(n.agent)}
                tabIndex={0}
                role="button"
                aria-label={`${n.agent.status} ${n.agent.role}: ${n.agent.task.slice(0, 80)}`}
              >
                <rect
                  width={GRAPH_NODE_WIDTH}
                  height={GRAPH_NODE_HEIGHT}
                  rx={3}
                  ry={3}
                  fill="rgba(10, 16, 24, 0.72)"
                  stroke={`var(--${tone})`}
                  strokeWidth={n.depth === 0 ? 1.5 : 1}
                />
                <text
                  x={10}
                  y={16}
                  style={{
                    fontFamily: 'var(--display)',
                    fontSize: 10,
                    letterSpacing: '0.18em',
                    fill: `var(--${tone})`,
                    fontWeight: 700,
                  }}
                >
                  {n.agent.role.toUpperCase()}
                  {n.depth === 0 ? ' · ROOT' : ''}
                </text>
                <text
                  x={10}
                  y={32}
                  style={{
                    fontFamily: 'var(--label)',
                    fontSize: 10,
                    fill: 'var(--ink)',
                  }}
                >
                  {n.agent.task.length > 28 ? `${n.agent.task.slice(0, 27)}…` : n.agent.task}
                </text>
                <text
                  x={10}
                  y={48}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    fill: 'var(--ink-dim)',
                  }}
                >
                  {n.agent.status} · {n.agent.tokenEstimate} tok · {n.agent.toolCallCount} tools
                </text>
                <text
                  x={GRAPH_NODE_WIDTH - 10}
                  y={16}
                  textAnchor="end"
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    fill: 'var(--ink-dim)',
                  }}
                >
                  {formatClock(n.agent.startedAt)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Hand-off log — textual narrative of timing */}
      {handoffLines.length > 0 && (
        <div
          aria-label="Hand-off log"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ink-dim)',
            lineHeight: 1.55,
            borderTop: '1px solid var(--line-soft)',
            paddingTop: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={{ color: 'var(--cyan)', letterSpacing: '0.16em' }}>HAND-OFFS</div>
          {handoffLines.map((line, i) => (
            <div key={i}>→ {line}</div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: 14,
          fontFamily: 'var(--mono)',
          fontSize: 9,
          color: 'var(--ink-dim)',
          letterSpacing: '0.08em',
        }}
        aria-label="Edge legend"
      >
        <span><span style={{ color: 'var(--cyan)' }}>━━</span> running</span>
        <span><span style={{ color: 'var(--green)' }}>━━</span> done</span>
        <span><span style={{ color: 'var(--red)' }}>━━</span> error</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBAGENT_TO_ROLE_ID: Record<SubAgentRole, RoleId> = {
  researcher: 'researcher',
  summarizer: 'researcher',
  coder: 'coder',
  browser_driver: 'operator',
  writer: 'scribe',
  planner: 'chair',
  critic: 'chair',
  unknown: 'generalist',
};

function durationMs(a: SubAgent): number {
  const end = a.endedAt ?? Date.now();
  return Math.max(0, end - a.startedAt);
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fleetSummaryText(agents: SubAgent[], running: SubAgent[]): string {
  const lines: string[] = [
    `Sub-agents · ${running.length} running · ${agents.length} listed`,
    '',
  ];
  for (const a of agents) {
    lines.push(
      `[${a.status}] ${a.role}${a.model ? ` · ${a.model}` : ''} · ${formatLatency(durationMs(a))} · ${a.tokenEstimate} tok · ${a.toolCallCount} tools`,
    );
    lines.push(`  ${a.task}`);
    if (a.status === 'error' && a.error) lines.push(`  err: ${a.error}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SocietyPage() {
  const subAgents = useSubAgentsLive(s => s.subAgents);
  const order = useSubAgentsLive(s => s.order);
  const clearOld = useSubAgentsLive(s => s.clear);
  const { message: copyHint, flash } = useFlashMessage();
  const [fleetMode, setFleetMode] = useState<FleetMode>('all');
  const [fleetQuery, setFleetQuery] = useState('');
  const [fleetView, setFleetView] = useState<FleetView>('list');
  const [selectedAgent, setSelectedAgent] = useState<SubAgent | null>(null);
  const dq = useDebounced(fleetQuery, 200);

  // Newest first
  const active = useMemo(
    () => [...order].reverse().map(id => subAgents[id]).filter(Boolean) as SubAgent[],
    [order, subAgents],
  );
  const running = active.filter(s => s.status === 'running');
  const done    = active.filter(s => s.status === 'done');
  const errored = active.filter(s => s.status === 'error');

  const visible = useMemo(
    () => selectVisibleFleet(active, fleetMode, dq),
    [active, fleetMode, dq],
  );
  const runningVisible = visible.filter(s => s.status === 'running');

  const rolesList = Object.values(ROLES);

  // Per-role active count
  const activeCountByRole = useMemo<Record<RoleId, number>>(() => {
    const seed = Object.fromEntries(rolesList.map(r => [r.id, 0])) as Record<RoleId, number>;
    return running.reduce<Record<RoleId, number>>((acc, a) => {
      const rid = SUBAGENT_TO_ROLE_ID[a.role] ?? 'generalist';
      return { ...acc, [rid]: (acc[rid] ?? 0) + 1 };
    }, seed);
  }, [running, rolesList]);

  // Totals
  const totals = useMemo(() => visible.reduce(
    (acc, a) => ({
      tokens: acc.tokens + a.tokenEstimate,
      toolCalls: acc.toolCalls + a.toolCallCount,
      wallMs: acc.wallMs + durationMs(a),
    }),
    { tokens: 0, toolCalls: 0, wallMs: 0 },
  ), [visible]);

  // Tree structure
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set(visible.map(a => a.id));
    const childrenOf = new Map<string, SubAgent[]>();
    const roots: SubAgent[] = [];
    for (const a of visible) {
      if (a.parentId && ids.has(a.parentId)) {
        const existing = childrenOf.get(a.parentId) ?? [];
        childrenOf.set(a.parentId, [...existing, a]);
      } else {
        roots.push(a);
      }
    }
    return { roots, childrenOf };
  }, [visible]);

  // Keep selected agent fresh from store
  const liveSelected = selectedAgent
    ? subAgents[selectedAgent.id] ?? selectedAgent
    : null;

  return (
    <ModuleView title="SOCIETY · AGENTS">
      {/* Transcript panel overlay */}
      {liveSelected && (
        <TranscriptPanel
          agent={liveSelected}
          onClose={() => setSelectedAgent(null)}
        />
      )}

      <PageGrid>
        {/* Row 1: Header + Stats + Actions */}
        <PageCell span={12}>
          <PageLead>
            Dispatcher roles (who Sunny can become) and the live sub-agent fleet spawned for delegated goals.
          </PageLead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <StatBlock label="ROLES" value={String(rolesList.length)} tone="cyan" sub="specialists" />
            <StatBlock
              label="RUNNING"
              value={String(running.length)}
              tone="green"
              sub={running.length > 0 ? 'processing now' : 'idle'}
            />
            <StatBlock label="FINISHED" value={String(done.length)} tone="violet" />
            <StatBlock
              label="ERRORS"
              value={String(errored.length)}
              tone={errored.length > 0 ? 'red' : 'green'}
              sub={errored.length > 0 ? 'need attention' : 'all clear'}
            />
            <StatBlock
              label="TOKENS"
              value={totals.tokens > 1000 ? `${(totals.tokens / 1000).toFixed(1)}k` : String(totals.tokens)}
              tone="amber"
              sub="fleet total"
            />
            <StatBlock label="WALL TIME" value={formatLatency(totals.wallMs)} tone="teal" sub="cumulative" />
          </div>
          <Toolbar style={{ flexWrap: 'wrap', marginTop: 4 }}>
            <ToolbarButton
              tone="cyan"
              title="Ask Sunny to assess the fleet"
              onClick={() => askSunny(
                `Here's my current agent fleet:\n\n${fleetSummaryText(active, running)}\n\nAre the agents working efficiently? Any recommendations?`,
                'society',
              )}
            >
              ✦ ASSESS FLEET
            </ToolbarButton>
            <ToolbarButton
              tone="violet"
              title="Copy the visible fleet (respects filters)"
              onClick={async () => {
                const ok = await copyToClipboard(fleetSummaryText(visible, runningVisible));
                flash(ok ? 'Fleet summary copied' : 'Copy failed');
              }}
            >
              COPY FLEET
            </ToolbarButton>
            <ToolbarButton
              tone="cyan"
              title="Download visible agents as JSON"
              disabled={visible.length === 0}
              onClick={() => {
                downloadTextFile(
                  `sunny-society-fleet-${Date.now()}.json`,
                  societyFleetJson(visible),
                  'application/json',
                );
                flash('JSON download started');
              }}
            >
              DOWNLOAD JSON
            </ToolbarButton>
            {copyHint && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
            )}
          </Toolbar>
        </PageCell>

        {/* Row 2: Roster (7) | Orbit + Distribution (5) */}
        <PageCell span={7}>
          <Section title="ROSTER" right="society::dispatcher">
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
            }}>
              {rolesList.map(r => (
                <RoleCard key={r.id} role={r} active={activeCountByRole[r.id] ?? 0} />
              ))}
            </div>
          </Section>
        </PageCell>

        <PageCell span={5}>
          <Section title="FLEET ORBIT" right="live topology">
            {active.length > 0 ? (
              <FleetOrbit agents={active} />
            ) : (
              <EmptyState
                title="No agents in orbit"
                hint="Agents will appear here as Sunny spawns specialists."
              />
            )}
          </Section>

          <Section title="ROLE DISTRIBUTION" right="fleet breakdown">
            <RoleDistribution agents={active} />
          </Section>
        </PageCell>

        {/* Row 3: Live Fleet Tree (12) */}
        <PageCell span={12}>
          <Section
            title="LIVE FLEET"
            right={
              <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span title="Total in store">{active.length}</span>
                <ToolbarButton
                  tone={fleetView === 'list' ? 'cyan' : 'violet'}
                  title="Show the vertical card list"
                  onClick={() => setFleetView('list')}
                >
                  {fleetView === 'list' ? '◉ LIST' : '○ LIST'}
                </ToolbarButton>
                <ToolbarButton
                  tone={fleetView === 'graph' ? 'cyan' : 'violet'}
                  title="Show the parent→child graph"
                  onClick={() => setFleetView('graph')}
                >
                  {fleetView === 'graph' ? '◉ GRAPH' : '○ GRAPH'}
                </ToolbarButton>
                {done.length + errored.length > 0 && (
                  <ToolbarButton
                    tone="violet"
                    title="Clear finished sub-agents older than five minutes"
                    onClick={() => clearOld()}
                  >
                    PRUNE
                  </ToolbarButton>
                )}
              </span>
            }
          >
            {active.length === 0 ? (
              <EmptyState
                title="No sub-agents active"
                hint="Sunny spawns specialists for delegated goals (researcher, coder, writer, …). They land here the moment they start."
              />
            ) : (
              <>
                <TabBar
                  value={fleetMode}
                  onChange={v => setFleetMode(v as FleetMode)}
                  tabs={[
                    { id: 'all', label: 'ALL', count: active.length },
                    { id: 'running', label: 'RUNNING', count: running.length },
                    { id: 'done', label: 'DONE', count: done.length },
                    { id: 'error', label: 'ERR', count: errored.length },
                  ]}
                />
                <Toolbar style={{ marginBottom: 4 }}>
                  <FilterInput
                    value={fleetQuery}
                    onChange={e => setFleetQuery(e.target.value)}
                    placeholder="Search task, role, id, model, error…"
                    aria-label="Filter fleet"
                    spellCheck={false}
                  />
                </Toolbar>
                {visible.length === 0 ? (
                  <EmptyState
                    title="Nothing matches"
                    hint="Try another status tab or clear the search box."
                  />
                ) : fleetView === 'graph' ? (
                  <FleetGraph
                    roots={roots}
                    childrenOf={childrenOf}
                    onSelect={setSelectedAgent}
                  />
                ) : (
                  <ScrollList maxHeight={500}>
                    {roots.map((a, i) => (
                      <FleetNode
                        key={a.id}
                        agent={a}
                        depth={0}
                        index={i}
                        childrenOf={childrenOf}
                        flash={flash}
                        onSelect={setSelectedAgent}
                      />
                    ))}
                  </ScrollList>
                )}
              </>
            )}
          </Section>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
