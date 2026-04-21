import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { isTauri } from '../../lib/tauri';
import { useSubAgents } from '../../store/subAgents';
import { runDaemonNow, inFlightDaemonIds } from '../../lib/daemonRuntime';
import {
  daemonsAdd,
  daemonsDelete,
  daemonsSetEnabled,
  describeSchedule,
  humanizeSecs,
  lastRunRelative,
  nextRunRelative,
  useDaemons,
  type Daemon,
  type DaemonKind,
  type DaemonSpec,
} from '../../store/daemons';
import {
  chipOutline,
  ghostBtn,
  inputStyle,
  labelStyle,
  primaryBtn,
  staticChip,
} from './styles';
import { SectionHeader } from './SectionHeader';
import { CATEGORY_ORDER, TEMPLATES, specFromTemplate, type Template } from './templates';

// Polling cadence for the cached daemons list. Quick enough to feel live,
// slow enough that a dozen daemons don't generate constant requests. The
// runtime also nudges the store after fires, so most updates are push-y.
const POLL_MS = 3000;
// Same cadence for the "running-right-now" highlight.
const INFLIGHT_POLL_MS = 1500;

const INTERVAL_PRESETS: ReadonlyArray<{ label: string; secs: number }> = [
  { label: '15m', secs: 900 },
  { label: '30m', secs: 1800 },
  { label: '1h',  secs: 3600 },
  { label: '4h',  secs: 14_400 },
  { label: '12h', secs: 43_200 },
  { label: '1d',  secs: 86_400 },
];

const CATEGORY_COLOR: Record<Template['category'], string> = {
  MORNING:  'var(--amber)',
  FOCUS:    'var(--cyan)',
  INBOX:    'var(--violet)',
  CODING:   'var(--teal)',
  RESEARCH: 'var(--pink)',
  WRITING:  'var(--gold)',
  CLEANUP:  'var(--green)',
  WATCHERS: 'var(--red)',
  LEARN:    'var(--cyan-2)',
  LIFE:     'var(--lime)',
  MONEY:    'var(--blue)',
  HOME:     'var(--coral)',
};

// ---------------------------------------------------------------------------

export function AgentsTab() {
  const daemons = useDaemons(s => s.list);
  const loaded = useDaemons(s => s.loaded);
  const refresh = useDaemons(s => s.refresh);
  const runs = useSubAgents(s => s.runs);
  const [inflight, setInflight] = useState<ReadonlySet<string>>(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCats, setCollapsedCats] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const tick = () => setInflight(inFlightDaemonIds());
    tick();
    const id = window.setInterval(tick, INFLIGHT_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  // -------- actions --------

  const handleInstallTemplate = useCallback(
    async (tpl: Template) => {
      setActionErr(null);
      try {
        await daemonsAdd(specFromTemplate(tpl));
        await refresh();
      } catch (err) {
        setActionErr(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const handleToggle = useCallback(
    async (d: Daemon) => {
      setActionErr(null);
      try {
        await daemonsSetEnabled(d.id, !d.enabled);
        await refresh();
      } catch (err) {
        setActionErr(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (d: Daemon) => {
      setActionErr(null);
      try {
        await daemonsDelete(d.id);
        await refresh();
      } catch (err) {
        setActionErr(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const handleRunNow = useCallback((d: Daemon) => {
    runDaemonNow(d);
    // Nudge the inflight set immediately so the UI flips "(running)".
    setInflight(inFlightDaemonIds());
  }, []);

  const handleCreate = useCallback(
    async (spec: DaemonSpec) => {
      setActionErr(null);
      try {
        await daemonsAdd(spec);
        setCreateOpen(false);
        await refresh();
      } catch (err) {
        setActionErr(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [refresh],
  );

  // -------- derived --------

  const installedTemplateIds = useMemo(() => {
    const set = new Set<string>();
    for (const d of daemons) {
      for (const t of TEMPLATES) {
        if (t.title === d.title) set.add(t.id);
      }
    }
    return set;
  }, [daemons]);

  const agentCount = daemons.length;
  const enabledCount = daemons.filter(d => d.enabled).length;

  // Filter daemons by search query
  const filteredDaemons = useMemo(() => {
    if (!searchQuery.trim()) return daemons;
    const q = searchQuery.trim().toLowerCase();
    return daemons.filter(d =>
      d.title.toLowerCase().includes(q) || d.goal.toLowerCase().includes(q),
    );
  }, [daemons, searchQuery]);

  // Quick stats
  const errorsThisWeek = useMemo(() => {
    const weekAgo = Math.floor(Date.now() / 1000) - 604800;
    return runs.filter(r => r.status === 'error' && (r.endedAt ?? 0) / 1000 > weekAgo).length;
  }, [runs]);
  const firesToday = useMemo(() => {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    return daemons.reduce((n, d) => n + (d.last_run !== null && d.last_run > dayAgo ? 1 : 0), 0);
  }, [daemons]);

  const toggleCat = useCallback((cat: string) => {
    setCollapsedCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  if (!isTauri) {
    return (
      <div
        style={{
          border: '1px dashed var(--line-soft)',
          padding: 24,
          fontFamily: 'var(--mono)',
          fontSize: 12,
          color: 'var(--ink-dim)',
          lineHeight: 1.6,
        }}
      >
        <div style={{ color: 'var(--cyan)', fontFamily: 'var(--display)', letterSpacing: '0.28em', marginBottom: 10, fontWeight: 700 }}>
          BACKEND REQUIRED
        </div>
        Persistent AI agents need the Tauri backend. Launch SUNNY via <code>pnpm tauri dev</code>.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'fadeSlideIn 200ms ease-out' }}>
      {/* Quick stats banner */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
        gap: 8,
      }}>
        <div style={quickStatStyle}>
          <span style={quickStatLabel}>ENABLED</span>
          <span style={{ ...quickStatValue, color: 'var(--green)' }}>{enabledCount}/{agentCount}</span>
        </div>
        <div style={quickStatStyle}>
          <span style={quickStatLabel}>FIRES TODAY</span>
          <span style={{ ...quickStatValue, color: 'var(--amber)' }}>{firesToday}</span>
        </div>
        <div style={quickStatStyle}>
          <span style={quickStatLabel}>ERRORS (7D)</span>
          <span style={{ ...quickStatValue, color: errorsThisWeek > 0 ? 'var(--red)' : 'var(--green)' }}>
            {errorsThisWeek}
          </span>
        </div>
        <div style={quickStatStyle}>
          <span style={quickStatLabel}>TEMPLATES</span>
          <span style={{ ...quickStatValue, color: 'var(--violet)' }}>{TEMPLATES.length}</span>
        </div>
      </div>

      {/* Installed daemons */}
      <div>
        <SectionHeader
          label="INSTALLED AGENTS"
          count={enabledCount}
          tone="green"
          right={
            <button
              onClick={() => setCreateOpen(o => !o)}
              style={{ ...ghostBtn, fontSize: 10, padding: '4px 10px' }}
            >
              {createOpen ? '− HIDE CUSTOM' : '+ CUSTOM AGENT'}
            </button>
          }
        />

        {/* Search filter */}
        {agentCount > 0 && (
          <div style={{ marginBottom: 10 }}>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Filter agents by name or goal…"
              aria-label="Filter agents"
              autoComplete="off"
              spellCheck={false}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'rgba(4, 10, 16, 0.85)',
                color: 'var(--ink)',
                border: '1px solid var(--line-soft)',
                padding: '7px 12px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.04em',
              }}
            />
          </div>
        )}

        {createOpen && (
          <CustomAgentForm onCreate={handleCreate} onCancel={() => setCreateOpen(false)} />
        )}

        {!loaded ? (
          <div style={dimHintStyle}>LOADING…</div>
        ) : agentCount === 0 ? (
          <div style={dimHintStyle}>
            No agents installed yet. Pick a template below or use <b>+ CUSTOM AGENT</b>.
          </div>
        ) : filteredDaemons.length === 0 ? (
          <div style={dimHintStyle}>
            No agents match &quot;{searchQuery}&quot;. Try a different search.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {filteredDaemons.map(d => (
              <AgentRow
                key={d.id}
                daemon={d}
                isRunning={inflight.has(d.id)}
                onToggle={() => void handleToggle(d)}
                onDelete={() => void handleDelete(d)}
                onRunNow={() => handleRunNow(d)}
              />
            ))}
          </div>
        )}
        {actionErr && (
          <div style={{ ...dimHintStyle, color: 'var(--red)', marginTop: 8 }}>{actionErr}</div>
        )}
      </div>

      {/* Starter templates — grouped by category with collapsible sections */}
      <div>
        <SectionHeader label="STARTER TEMPLATES" count={TEMPLATES.length} tone="violet" />
        <p style={{ ...dimHintStyle, margin: '6px 0 10px' }}>
          One-tap recipes — tweak or duplicate after installing.
        </p>
        {CATEGORY_ORDER.map(cat => {
          const catTemplates = TEMPLATES.filter(t => t.category === cat);
          if (catTemplates.length === 0) return null;
          const collapsed = collapsedCats.has(cat);
          const color = CATEGORY_COLOR[cat] ?? 'var(--cyan)';
          return (
            <div key={cat} style={{ marginBottom: 12 }}>
              <button
                onClick={() => toggleCat(cat)}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 0',
                  borderBottom: `1px solid ${color}33`,
                  marginBottom: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color,
                    transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                    transition: 'transform 150ms ease',
                  }}
                >▸</span>
                <span style={{
                  fontFamily: 'var(--display)',
                  fontSize: 9,
                  letterSpacing: '0.28em',
                  color,
                  fontWeight: 700,
                }}>
                  {cat}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: 'var(--ink-dim)',
                  marginLeft: 'auto',
                }}>
                  {catTemplates.length} template{catTemplates.length > 1 ? 's' : ''}
                </span>
              </button>
              {!collapsed && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 10,
                    animation: 'fadeSlideIn 200ms ease-out',
                  }}
                >
                  {catTemplates.map(t => (
                    <TemplateCard
                      key={t.id}
                      template={t}
                      installed={installedTemplateIds.has(t.id)}
                      onInstall={() => void handleInstallTemplate(t)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Installed-agent row
// ---------------------------------------------------------------------------

function AgentRow({
  daemon,
  isRunning,
  onToggle,
  onDelete,
  onRunNow,
}: {
  daemon: Daemon;
  isRunning: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const armTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    },
    [],
  );

  const armOrDelete = () => {
    if (armedDelete) {
      if (armTimer.current !== null) {
        window.clearTimeout(armTimer.current);
        armTimer.current = null;
      }
      setArmedDelete(false);
      onDelete();
      return;
    }
    setArmedDelete(true);
    armTimer.current = window.setTimeout(() => setArmedDelete(false), 3000);
  };

  const statusColor = isRunning
    ? 'var(--cyan)'
    : daemon.enabled
      ? 'var(--green)'
      : 'var(--ink-dim)';

  const statusLabel = isRunning
    ? 'RUNNING'
    : daemon.enabled
      ? 'ARMED'
      : 'PAUSED';

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: isRunning
          ? 'linear-gradient(90deg, rgba(57, 229, 255, 0.10), transparent 60%)'
          : 'rgba(6, 14, 22, 0.4)',
        padding: 0,
        borderLeft: `3px solid ${statusColor}`,
        transition: 'background 180ms ease, border-color 180ms ease',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(x => !x)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(x => !x);
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: '90px 1fr auto auto auto',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9.5,
            letterSpacing: '0.2em',
            color: statusColor,
            border: `1px solid ${statusColor}`,
            background: 'rgba(6, 14, 22, 0.5)',
            padding: '2px 8px',
            justifySelf: 'start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {isRunning && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--cyan)',
                boxShadow: '0 0 8px var(--cyan)',
                animation: 'pulseDot 1.4s infinite',
              }}
            />
          )}
          {statusLabel}
        </span>
        <div style={{ overflow: 'hidden' }}>
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 12.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              color: 'var(--ink)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={daemon.title}
          >
            {daemon.title}
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
              color: 'var(--ink-dim)',
              letterSpacing: '0.08em',
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {describeSchedule(daemon)} · {daemon.runs_count} run{daemon.runs_count === 1 ? '' : 's'}
          </div>
        </div>
        <MetaPill label="NEXT" value={daemon.enabled ? nextRunRelative(daemon.next_run) : '—'} />
        <MetaPill label="LAST" value={lastRunRelative(daemon.last_run)} />
        <span
          style={{
            color: 'var(--ink-dim)',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
            fontFamily: 'var(--mono)',
            fontSize: 10,
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
            background: 'rgba(4, 10, 16, 0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div>
            <div style={smallHeaderStyle}>GOAL</div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11.5,
                lineHeight: 1.5,
                color: 'var(--ink)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                padding: '8px 10px',
                border: '1px solid var(--line-soft)',
                background: 'rgba(2, 6, 10, 0.6)',
              }}
            >
              {daemon.goal}
            </div>
          </div>

          {daemon.last_output && (
            <div>
              <div style={smallHeaderStyle}>
                LAST OUTPUT · {daemon.last_status?.toUpperCase() ?? '—'}
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--ink-2)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: '8px 10px',
                  border: `1px solid ${daemon.last_status === 'done' ? 'rgba(125, 255, 154, 0.25)' : 'rgba(255, 179, 71, 0.35)'}`,
                  background: 'rgba(2, 6, 10, 0.5)',
                  maxHeight: 180,
                  overflow: 'auto',
                }}
              >
                {daemon.last_output}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={primaryBtn} onClick={onRunNow} disabled={isRunning}>
              {isRunning ? 'RUNNING…' : 'RUN NOW'}
            </button>
            <button style={ghostBtn} onClick={onToggle}>
              {daemon.enabled ? 'PAUSE' : 'RESUME'}
            </button>
            <span style={{ flex: 1 }} />
            <button
              onClick={armOrDelete}
              style={{
                ...ghostBtn,
                color: armedDelete ? '#fff' : 'var(--red)',
                borderColor: 'var(--red)',
                background: armedDelete ? 'rgba(255, 77, 94, 0.25)' : 'rgba(255, 77, 94, 0.06)',
              }}
            >
              {armedDelete ? 'CONFIRM · DELETE' : 'DELETE'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-dim)',
        letterSpacing: '0.12em',
        textAlign: 'right',
      }}
    >
      <div style={{ fontSize: 8, letterSpacing: '0.22em' }}>{label}</div>
      <div style={{ color: 'var(--cyan)', marginTop: 2, fontSize: 11 }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template card
// ---------------------------------------------------------------------------

function TemplateCard({
  template,
  installed,
  onInstall,
}: {
  template: Template;
  installed: boolean;
  onInstall: () => void;
}) {
  const color = CATEGORY_COLOR[template.category];
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(6, 14, 22, 0.45)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 20,
            lineHeight: 1,
            color,
            filter: `drop-shadow(0 0 6px ${color}aa)`,
            width: 28,
            textAlign: 'center',
          }}
        >
          {template.icon}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ ...staticChip(color), padding: '1px 6px', fontSize: 8, letterSpacing: '0.24em' }}>
            {template.category}
          </span>
          <div style={{ fontFamily: 'var(--display)', fontSize: 12, letterSpacing: '0.1em', color: 'var(--ink)', fontWeight: 700 }}>
            {template.title}
          </div>
        </div>
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--ink-2)',
          minHeight: 36,
        }}
      >
        {template.summary}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.18em',
          color: 'var(--ink-dim)',
          textTransform: 'uppercase',
          marginTop: 'auto',
        }}
      >
        {template.kind === 'interval' && template.everySec
          ? `every ${humanizeSecs(template.everySec)}`
          : template.kind}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onInstall}
          style={{
            ...primaryBtn,
            flex: 1,
            opacity: installed ? 0.55 : 1,
            background: installed ? 'rgba(125, 255, 154, 0.10)' : 'rgba(57, 229, 255, 0.22)',
            borderColor: installed ? 'var(--green)' : 'var(--cyan)',
          }}
        >
          {installed ? '✓ INSTALLED · ADD COPY' : 'INSTALL'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom agent form
// ---------------------------------------------------------------------------

function CustomAgentForm({
  onCreate,
  onCancel,
}: {
  onCreate: (spec: DaemonSpec) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<DaemonKind>('interval');
  const [intervalSec, setIntervalSec] = useState<number>(3600);
  const [eventName, setEventName] = useState('');
  const [onceDate, setOnceDate] = useState<string>(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    return d.toISOString().slice(0, 16); // datetime-local format
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && goal.trim().length >= 8;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const spec: DaemonSpec = {
        title: title.trim(),
        goal: goal.trim(),
        kind,
        every_sec: kind === 'interval' ? intervalSec : null,
        at:
          kind === 'once'
            ? Math.floor(new Date(onceDate).getTime() / 1000)
            : null,
        on_event: kind === 'on_event' ? eventName.trim() : null,
      };
      await onCreate(spec);
      setTitle('');
      setGoal('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(57, 229, 255, 0.03)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginBottom: 10,
      }}
    >
      <div>
        <label style={labelStyle}>TITLE</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="What should SUNNY call this?"
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle}>GOAL (plain English)</label>
        <textarea
          value={goal}
          onChange={e => setGoal(e.target.value)}
          placeholder="Scan my ~/Downloads every 30 minutes and notify me about anything suspicious."
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }}
        />
      </div>

      <div>
        <label style={labelStyle}>KIND</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['interval', 'once', 'on_event'] as const).map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              style={chipOutline('var(--cyan)', kind === k)}
            >
              {k.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {kind === 'interval' && (
        <div>
          <label style={labelStyle}>RUN EVERY</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {INTERVAL_PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => setIntervalSec(p.secs)}
                style={chipOutline('var(--cyan)', intervalSec === p.secs)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {kind === 'once' && (
        <div>
          <label style={labelStyle}>RUN AT</label>
          <input
            type="datetime-local"
            value={onceDate}
            onChange={e => setOnceDate(e.target.value)}
            style={inputStyle}
          />
        </div>
      )}

      {kind === 'on_event' && (
        <div>
          <label style={labelStyle}>EVENT NAME</label>
          <input
            type="text"
            value={eventName}
            onChange={e => setEventName(e.target.value)}
            placeholder="e.g. scan.completed"
            style={inputStyle}
          />
        </div>
      )}

      {error && (
        <div
          style={{
            color: 'var(--red)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            border: '1px solid var(--red)',
            padding: '6px 10px',
            background: 'rgba(255, 77, 94, 0.06)',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} style={ghostBtn}>
          CANCEL
        </button>
        <button
          onClick={() => void submit()}
          disabled={!canSubmit || submitting}
          style={{
            ...primaryBtn,
            opacity: !canSubmit || submitting ? 0.4 : 1,
            cursor: !canSubmit || submitting ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'CREATING…' : 'INSTALL AGENT'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const dimHintStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  letterSpacing: '0.06em',
  lineHeight: 1.6,
  padding: '10px 0',
};

const smallHeaderStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.24em',
  color: 'var(--cyan)',
  fontWeight: 700,
  marginBottom: 4,
};

const quickStatStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 12px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.5)',
};

const quickStatLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
};

const quickStatValue: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '0.04em',
};
