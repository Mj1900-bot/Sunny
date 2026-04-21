import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { TOOLS, runTool, type Tool, type ToolResult } from '../../lib/tools';
import { listSkills, type SkillManifest } from '../../lib/skills';

// ---------------------------------------------------------------------------
// CapabilitiesTab — formerly the standalone CAPABILITIES module. Moved
// under SETTINGS because enabling/browsing tools is a configuration
// concern — users reach for it from the same mental bucket as theme /
// constitution / voice.
// ---------------------------------------------------------------------------

const DISPLAY_FONT = "'Orbitron', var(--mono)";
const REGISTRY_POLL_MS = 5000;

const GROUP_PREFIXES: ReadonlyArray<{ key: string; label: string; prefix: string }> = [
  { key: 'mouse', label: 'MOUSE', prefix: 'mouse_' },
  { key: 'keyboard', label: 'KEYBOARD', prefix: 'keyboard_' },
  { key: 'screen', label: 'SCREEN', prefix: 'screen_' },
  { key: 'window', label: 'WINDOWS', prefix: 'window_' },
  { key: 'memory', label: 'MEMORY', prefix: 'memory_' },
  { key: 'scheduler', label: 'SCHEDULER', prefix: 'scheduler_' },
  { key: 'ocr', label: 'OCR', prefix: 'ocr_' },
  { key: 'notify', label: 'NOTIFY', prefix: 'notify_' },
  { key: 'reminders', label: 'REMINDERS', prefix: 'reminders_' },
  { key: 'notes_app', label: 'NOTES APP', prefix: 'notes_app_' },
  { key: 'calendar', label: 'CALENDAR', prefix: 'calendar_' },
  { key: 'mail', label: 'MAIL', prefix: 'mail_' },
  { key: 'messaging', label: 'MESSAGING', prefix: 'messaging_' },
  { key: 'media', label: 'MEDIA', prefix: 'media_' },
  { key: 'weather', label: 'WEATHER', prefix: 'weather_' },
  { key: 'stock', label: 'STOCKS', prefix: 'stock_' },
  { key: 'py', label: 'PYTHON', prefix: 'py_' },
  { key: 'browser', label: 'BROWSER', prefix: 'browser_' },
];

const MISC_KEY = 'misc';
const MISC_LABEL = 'MISC';

type ToolSnapshot = Readonly<{
  name: string;
  description: string;
  schema: Record<string, unknown>;
  dangerous: boolean;
  groupKey: string;
  groupLabel: string;
  isZeroParam: boolean;
}>;

type GroupBucket = Readonly<{
  key: string;
  label: string;
  tools: ReadonlyArray<ToolSnapshot>;
}>;

type TryState = Readonly<{
  running: boolean;
  result: ToolResult | null;
  error: string | null;
}>;

function deriveGroup(name: string): { key: string; label: string } {
  for (const g of GROUP_PREFIXES) {
    if (name.startsWith(g.prefix)) {
      return { key: g.key, label: g.label };
    }
  }
  return { key: MISC_KEY, label: MISC_LABEL };
}

function isZeroParamSchema(schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  if (props === undefined || props === null) return true;
  if (typeof props !== 'object') return false;
  return Object.keys(props as Record<string, unknown>).length === 0;
}

function snapshotFromTool(tool: Tool): ToolSnapshot {
  const name = tool.schema.name;
  const { key, label } = deriveGroup(name);
  const schema = tool.schema.input_schema ?? {};
  return {
    name,
    description: tool.schema.description,
    schema,
    dangerous: tool.dangerous,
    groupKey: key,
    groupLabel: label,
    isZeroParam: isZeroParamSchema(schema),
  };
}

function snapshotAllTools(): ReadonlyArray<ToolSnapshot> {
  return Array.from(TOOLS.values())
    .map(snapshotFromTool)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildBuckets(tools: ReadonlyArray<ToolSnapshot>): ReadonlyArray<GroupBucket> {
  const byKey = new Map<string, { label: string; tools: ToolSnapshot[] }>();
  for (const t of tools) {
    const bucket = byKey.get(t.groupKey) ?? { label: t.groupLabel, tools: [] };
    bucket.tools.push(t);
    byKey.set(t.groupKey, bucket);
  }
  const ordered: GroupBucket[] = [];
  for (const g of GROUP_PREFIXES) {
    const b = byKey.get(g.key);
    if (b && b.tools.length > 0) {
      ordered.push({ key: g.key, label: g.label, tools: b.tools });
    }
  }
  const miscBucket = byKey.get(MISC_KEY);
  if (miscBucket && miscBucket.tools.length > 0) {
    ordered.push({ key: MISC_KEY, label: MISC_LABEL, tools: miscBucket.tools });
  }
  return ordered;
}

function extractSchemaKeys(schema: Record<string, unknown>): ReadonlyArray<string> {
  const props = schema.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props as Record<string, unknown>);
}

function matchesQuery(t: ToolSnapshot, q: string): boolean {
  if (q.length === 0) return true;
  const needle = q.toLowerCase();
  return t.name.toLowerCase().includes(needle) ||
    t.description.toLowerCase().includes(needle);
}

function snapshotSignature(tools: ReadonlyArray<ToolSnapshot>): string {
  return tools.map(t => `${t.name}:${t.dangerous ? 1 : 0}`).join('|');
}

const sectionHeaderStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.22em',
  color: 'var(--cyan)',
  textTransform: 'uppercase',
  marginBottom: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const searchInputStyle: CSSProperties = {
  width: '100%',
  background: 'rgba(4, 10, 16, 0.7)',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.08em',
  padding: '8px 10px',
  outline: 'none',
};

const skillCardStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  padding: '12px 14px',
  display: 'grid',
  gap: 6,
};

const skillNameStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: '0.14em',
  color: 'var(--cyan)',
  textTransform: 'uppercase',
};

const skillMetaStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  color: 'var(--ink-dim)',
};

const skillDescStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ink)',
};

const groupHeaderStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderBottom: '1px solid var(--line-soft)',
  fontFamily: DISPLAY_FONT,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.22em',
  color: 'var(--cyan)',
  textTransform: 'uppercase',
  width: '100%',
};

const caretStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  width: 12,
};

const toolRowStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  padding: '10px 12px',
  borderBottom: '1px solid rgba(120, 170, 200, 0.08)',
  cursor: 'pointer',
};

const toolNameStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  color: 'var(--cyan)',
  letterSpacing: '0.04em',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const toolDescStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  lineHeight: 1.4,
};

const schemaPreviewStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.06em',
};

const dangerBadgeStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.22em',
  padding: '1px 6px',
  border: '1px solid rgba(255, 89, 89, 0.55)',
  color: '#ff7a7a',
  background: 'rgba(255, 89, 89, 0.08)',
};

const safeBadgeStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.22em',
  padding: '1px 6px',
  border: '1px solid rgba(120, 255, 170, 0.45)',
  color: 'rgb(120, 255, 170)',
  background: 'rgba(120, 255, 170, 0.06)',
};

const tryBtnStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.22em',
  padding: '2px 8px',
  border: '1px solid var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.08)',
};

const detailPanelStyle: CSSProperties = {
  marginTop: 8,
  padding: '10px 12px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.5)',
  display: 'grid',
  gap: 8,
};

const jsonPreStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  background: 'rgba(0, 0, 0, 0.3)',
  border: '1px solid rgba(120, 170, 200, 0.08)',
  padding: '8px 10px',
  margin: 0,
  overflow: 'auto',
  maxHeight: 260,
  whiteSpace: 'pre',
};

const tryResultOkStyle: CSSProperties = {
  border: '1px solid rgba(120, 255, 170, 0.35)',
  background: 'rgba(120, 255, 170, 0.05)',
  padding: '8px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const tryResultErrStyle: CSSProperties = {
  border: '1px solid rgba(255, 179, 71, 0.5)',
  background: 'rgba(255, 179, 71, 0.08)',
  padding: '8px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--amber)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const emptyStateStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  letterSpacing: '0.22em',
  textAlign: 'center',
  padding: '20px 12px',
  border: '1px dashed var(--line-soft)',
};

type ToolRowProps = Readonly<{
  tool: ToolSnapshot;
  expanded: boolean;
  tryState: TryState | undefined;
  onToggle: () => void;
  onTry: () => void;
}>;

function ToolRow({ tool, expanded, tryState, onToggle, onTry }: ToolRowProps): JSX.Element {
  const keys = extractSchemaKeys(tool.schema);
  const keysText = keys.length === 0 ? 'keys: (none)' : `keys: ${keys.join(', ')}`;

  return (
    <div
      style={toolRowStyle}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <div style={toolNameStyle}>
        <span>{tool.name}</span>
        {tool.dangerous ? (
          <span style={dangerBadgeStyle}>DANGEROUS</span>
        ) : (
          <span style={safeBadgeStyle}>SAFE</span>
        )}
        {!tool.dangerous && tool.isZeroParam && (
          <button
            type="button"
            style={tryBtnStyle}
            onClick={(e) => {
              e.stopPropagation();
              onTry();
            }}
            disabled={tryState?.running === true}
          >
            {tryState?.running === true ? 'RUNNING…' : 'TRY'}
          </button>
        )}
      </div>
      <div style={toolDescStyle}>{tool.description}</div>
      <div style={schemaPreviewStyle}>{keysText}</div>

      {expanded && (
        <div style={detailPanelStyle} onClick={(e) => e.stopPropagation()}>
          <div
            style={{
              fontFamily: DISPLAY_FONT,
              fontSize: 9.5,
              letterSpacing: '0.22em',
              color: 'var(--cyan)',
              textTransform: 'uppercase',
            }}
          >
            SCHEMA
          </div>
          <pre style={jsonPreStyle}>{JSON.stringify(tool.schema, null, 2)}</pre>

          {tryState && tryState.error !== null && (
            <div style={tryResultErrStyle}>ERROR: {tryState.error}</div>
          )}
          {tryState && tryState.result && (
            <>
              <div
                style={{
                  fontFamily: DISPLAY_FONT,
                  fontSize: 9.5,
                  letterSpacing: '0.22em',
                  color: tryState.result.ok ? 'rgb(120, 255, 170)' : 'var(--amber)',
                  textTransform: 'uppercase',
                }}
              >
                RESULT · {tryState.result.ok ? 'OK' : 'FAIL'} · {tryState.result.latency_ms}ms
              </div>
              <div style={tryState.result.ok ? tryResultOkStyle : tryResultErrStyle}>
                {tryState.result.content}
              </div>
              {tryState.result.data !== undefined && tryState.result.data !== null && (
                <pre style={jsonPreStyle}>
                  {JSON.stringify(tryState.result.data, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type GroupSectionProps = Readonly<{
  bucket: GroupBucket;
  collapsed: boolean;
  onToggleCollapse: () => void;
  expandedTool: string | null;
  tryStates: ReadonlyMap<string, TryState>;
  onToggleTool: (name: string) => void;
  onTryTool: (tool: ToolSnapshot) => void;
}>;

function GroupSection({
  bucket,
  collapsed,
  onToggleCollapse,
  expandedTool,
  tryStates,
  onToggleTool,
  onTryTool,
}: GroupSectionProps): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--line-soft)', marginBottom: 10 }}>
      <button type="button" style={groupHeaderStyle} onClick={onToggleCollapse}>
        <span style={caretStyle}>{collapsed ? '▸' : '▾'}</span>
        <span>{bucket.label}</span>
        <span style={{ ...skillMetaStyle, marginLeft: 'auto' }}>
          {bucket.tools.length} TOOL{bucket.tools.length === 1 ? '' : 'S'}
        </span>
      </button>
      {!collapsed && (
        <div>
          {bucket.tools.map(t => (
            <ToolRow
              key={t.name}
              tool={t}
              expanded={expandedTool === t.name}
              tryState={tryStates.get(t.name)}
              onToggle={() => onToggleTool(t.name)}
              onTry={() => onTryTool(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type SkillCardProps = Readonly<{ skill: SkillManifest }>;

function SkillCard({ skill }: SkillCardProps): JSX.Element {
  return (
    <div style={skillCardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={skillNameStyle}>{skill.name}</span>
        <span style={skillMetaStyle}>v{skill.version}</span>
        {skill.author && <span style={skillMetaStyle}>· {skill.author}</span>}
        <span style={{ ...skillMetaStyle, marginLeft: 'auto' }}>
          {skill.tools.length} TOOL{skill.tools.length === 1 ? '' : 'S'}
        </span>
      </div>
      <div style={skillDescStyle}>{skill.description}</div>
    </div>
  );
}

type Props = {
  readonly onCountsChange?: (tools: number, skills: number) => void;
};

export function CapabilitiesTab({ onCountsChange }: Props): JSX.Element {
  const [tools, setTools] = useState<ReadonlyArray<ToolSnapshot>>(() => snapshotAllTools());
  const [skills, setSkills] = useState<ReadonlyArray<SkillManifest>>(() => listSkills());
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [tryStates, setTryStates] = useState<ReadonlyMap<string, TryState>>(() => new Map());

  const lastSignatureRef = useRef<string>(snapshotSignature(tools));
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = snapshotAllTools();
      const sig = snapshotSignature(next);
      if (sig !== lastSignatureRef.current) {
        lastSignatureRef.current = sig;
        setTools(next);
        setSkills(listSkills());
      }
    }, REGISTRY_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    onCountsChange?.(tools.length, skills.length);
  }, [tools.length, skills.length, onCountsChange]);

  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      for (const ctrl of controllers.values()) {
        ctrl.abort();
      }
      controllers.clear();
    };
  }, []);

  const filteredTools = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) return tools;
    return tools.filter(t => matchesQuery(t, q));
  }, [tools, query]);

  const buckets = useMemo(() => buildBuckets(filteredTools), [filteredTools]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Map(prev);
      next.set(key, !prev.get(key));
      return next;
    });
  }, []);

  const toggleTool = useCallback((name: string) => {
    setExpandedTool(prev => (prev === name ? null : name));
  }, []);

  const runTry = useCallback(async (tool: ToolSnapshot) => {
    if (tool.dangerous || !tool.isZeroParam) return;
    setExpandedTool(tool.name);

    setTryStates(prev => {
      const next = new Map(prev);
      next.set(tool.name, { running: true, result: null, error: null });
      return next;
    });

    const controller = new AbortController();
    abortControllersRef.current.set(tool.name, controller);

    try {
      const result = await runTool(tool.name, {}, controller.signal);
      setTryStates(prev => {
        const next = new Map(prev);
        next.set(tool.name, { running: false, result, error: null });
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTryStates(prev => {
        const next = new Map(prev);
        next.set(tool.name, { running: false, result: null, error: message });
        return next;
      });
    } finally {
      abortControllersRef.current.delete(tool.name);
    }
  }, []);

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <input
          type="text"
          value={query}
          placeholder="Search tools…"
          onChange={e => setQuery(e.target.value)}
          style={searchInputStyle}
          aria-label="Filter tools by name or description"
        />
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.18em',
            color: 'var(--ink-dim)',
          }}
        >
          {query.trim().length === 0
            ? `ALL ${tools.length} TOOLS`
            : `${filteredTools.length} MATCH${filteredTools.length === 1 ? '' : 'ES'}`}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={sectionHeaderStyle}>
          <span>SKILLS</span>
          <span style={{ ...skillMetaStyle, marginLeft: 'auto' }}>
            {skills.length} LOADED
          </span>
        </div>
        {skills.length === 0 ? (
          <div style={emptyStateStyle}>NO SKILLS LOADED</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {skills.map(s => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={sectionHeaderStyle}>
          <span>TOOLS</span>
          <span style={{ ...skillMetaStyle, marginLeft: 'auto' }}>
            {filteredTools.length} / {tools.length}
          </span>
        </div>
        {buckets.length === 0 ? (
          <div style={emptyStateStyle}>
            NO TOOLS MATCH “{query.trim().toUpperCase()}”
          </div>
        ) : (
          buckets.map(b => (
            <GroupSection
              key={b.key}
              bucket={b}
              collapsed={collapsed.get(b.key) === true}
              onToggleCollapse={() => toggleGroup(b.key)}
              expandedTool={expandedTool}
              tryStates={tryStates}
              onToggleTool={toggleTool}
              onTryTool={runTry}
            />
          ))
        )}
      </div>
    </>
  );
}
