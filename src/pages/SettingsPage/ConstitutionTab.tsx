/**
 * ConstitutionTab — formerly the standalone CONSTITUTION module.
 * Moved under SETTINGS because values / prohibitions / identity are
 * configuration, and the user thinks of them alongside voice, theme,
 * and the rest of SUNNY's knobs.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import {
  invalidateConstitutionCache,
  renderConstitutionBlock,
  type Constitution,
  type Prohibition,
} from '../../lib/constitution';

const EMPTY_CONSTITUTION: Constitution = {
  schema_version: 1,
  identity: {
    name: 'SUNNY',
    voice: 'British male, calm, dry wit when appropriate',
    operator: 'Sunny',
  },
  values: [],
  prohibitions: [],
};

const DISPLAY_FONT = "'Orbitron', var(--mono)";

const sectionStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.35)',
  padding: '14px 16px',
  marginBottom: 14,
};

const sectionTitleStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontSize: 10,
  letterSpacing: '0.22em',
  color: 'var(--cyan)',
  textTransform: 'uppercase',
  marginBottom: 10,
};

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.1em',
  color: 'var(--ink-dim)',
  marginBottom: 4,
  textTransform: 'uppercase',
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  background: 'rgba(4, 18, 28, 0.6)',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink)',
  letterSpacing: '0.04em',
  outline: 'none',
  boxSizing: 'border-box',
};

const buttonStyle: CSSProperties = {
  all: 'unset',
  padding: '4px 10px',
  fontFamily: DISPLAY_FONT,
  fontSize: 9,
  letterSpacing: '0.18em',
  color: 'var(--cyan)',
  border: '1px solid var(--line-soft)',
  cursor: 'pointer',
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: 'var(--green)',
  borderColor: 'rgba(30, 200, 80, 0.55)',
  padding: '6px 14px',
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: 'var(--amber)',
  borderColor: 'rgba(255, 179, 71, 0.45)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
};

const hintStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.06em',
  marginTop: 4,
};

const previewStyle: CSSProperties = {
  background: 'rgba(6, 14, 22, 0.7)',
  border: '1px solid var(--line-soft)',
  padding: '10px 12px',
  fontSize: 11,
  color: 'var(--ink-dim)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--mono)',
  maxHeight: 260,
  overflow: 'auto',
};

const errorStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--amber)',
  padding: '8px 12px',
  border: '1px solid rgba(255, 179, 71, 0.4)',
  background: 'rgba(255, 179, 71, 0.06)',
  marginBottom: 12,
  letterSpacing: '0.1em',
};

const savedBannerStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--green)',
  padding: '8px 12px',
  border: '1px solid rgba(30, 200, 80, 0.4)',
  background: 'rgba(30, 200, 80, 0.08)',
  marginBottom: 12,
  letterSpacing: '0.1em',
};

type Props = {
  readonly onCountsChange?: (values: number, prohibitions: number) => void;
};

export function ConstitutionTab({ onCountsChange }: Props): JSX.Element {
  const [state, setState] = useState<Constitution>(EMPTY_CONSTITUTION);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [availableTools, setAvailableTools] = useState<ReadonlyArray<string>>([]);

  const load = useCallback(async () => {
    if (!isTauri) {
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const c = await invokeSafe<Constitution>('constitution_get');
      if (c) setState(c);
      setLoaded(true);

      const skills = await invokeSafe<ReadonlyArray<{ name: string }>>('memory_skill_list');
      const skillNames = skills?.map(s => s.name) ?? [];
      const baked = [
        'run_shell', 'applescript', 'open_app', 'open_path',
        'messaging_send_imessage', 'messaging_send_sms',
        'file_write', 'file_append', 'file_edit', 'file_delete', 'file_rename', 'file_mkdir',
        'mouse_click', 'mouse_click_at', 'keyboard_type', 'keyboard_tap', 'keyboard_combo',
        'py_run', 'web_fetch_readable', 'web_search',
      ];
      setAvailableTools(Array.from(new Set([...baked, ...skillNames])).sort());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onCountsChange?.(state.values.length, state.prohibitions.length);
  }, [state.values.length, state.prohibitions.length, onCountsChange]);

  const save = useCallback(async () => {
    if (!isTauri) return;
    setSaving(true);
    setErr(null);
    try {
      const result = await invokeSafe<null>('constitution_save', { value: state });
      if (result !== null || isTauri) {
        invalidateConstitutionCache();
        setSavedAt(Date.now());
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [state]);

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 2000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const preview = useMemo(() => renderConstitutionBlock(state), [state]);

  return (
    <>
      {!loaded && (
        <div style={{ ...hintStyle, fontSize: 11 }}>LOADING…</div>
      )}
      {err && <div style={errorStyle}>ERROR · {err}</div>}
      {savedAt !== null && (
        <div style={savedBannerStyle}>SAVED · next agent run picks up the new policy</div>
      )}

      <IdentitySection state={state} setState={setState} />
      <ValuesSection state={state} setState={setState} />
      <ProhibitionsSection
        state={state}
        setState={setState}
        availableTools={availableTools}
      />

      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>Prompt preview</div>
        <div style={hintStyle}>
          This is the exact text that gets injected into every agent turn's
          system prompt. Tool-call gate uses the same policy at runtime.
        </div>
        <pre style={previewStyle}>{preview}</pre>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <button
          style={primaryButtonStyle}
          onClick={() => void save()}
          disabled={saving || !isTauri}
        >
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
        <button style={buttonStyle} onClick={() => void load()} disabled={saving}>
          REVERT
        </button>
        <span style={{ flex: 1 }} />
        <span style={hintStyle}>
          File: ~/.sunny/constitution.json · 0600
        </span>
      </div>
    </>
  );
}

function IdentitySection({
  state,
  setState,
}: {
  state: Constitution;
  setState: (c: Constitution) => void;
}): JSX.Element {
  const update = (patch: Partial<Constitution['identity']>): void => {
    setState({
      ...state,
      identity: { ...state.identity, ...patch },
    });
  };
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>Identity</div>

      <label htmlFor="constitution-name" style={fieldLabelStyle}>Name</label>
      <input
        id="constitution-name"
        style={inputStyle}
        value={state.identity.name}
        onChange={e => update({ name: e.target.value })}
      />

      <label htmlFor="constitution-voice" style={{ ...fieldLabelStyle, marginTop: 10 }}>Voice</label>
      <input
        id="constitution-voice"
        style={inputStyle}
        value={state.identity.voice}
        onChange={e => update({ voice: e.target.value })}
      />
      <div style={hintStyle}>Describe the agent's tone — the LLM sees this in every system prompt.</div>

      <label htmlFor="constitution-operator" style={{ ...fieldLabelStyle, marginTop: 10 }}>Operator</label>
      <input
        id="constitution-operator"
        style={inputStyle}
        value={state.identity.operator}
        onChange={e => update({ operator: e.target.value })}
      />
      <div style={hintStyle}>The name the agent uses to refer to you.</div>
    </div>
  );
}

function ValuesSection({
  state,
  setState,
}: {
  state: Constitution;
  setState: (c: Constitution) => void;
}): JSX.Element {
  const add = (): void => {
    setState({ ...state, values: [...state.values, ''] });
  };
  const update = (idx: number, value: string): void => {
    const next = state.values.slice();
    next[idx] = value;
    setState({ ...state, values: next });
  };
  const remove = (idx: number): void => {
    setState({
      ...state,
      values: state.values.filter((_, i) => i !== idx),
    });
  };
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>Values ({state.values.length})</div>
      <div style={hintStyle}>
        Plain-English principles the LLM honors in its reasoning. No runtime
        enforcement — for hard rules, add Prohibitions below.
      </div>

      {state.values.map((v, i) => (
        <div key={i} style={{ ...rowStyle, marginTop: 8 }}>
          <input
            style={inputStyle}
            value={v}
            placeholder="e.g. Prefer concise over verbose"
            onChange={e => update(i, e.target.value)}
          />
          <button style={dangerButtonStyle} onClick={() => remove(i)}>
            REMOVE
          </button>
        </div>
      ))}

      <button
        style={{ ...buttonStyle, marginTop: 8 }}
        onClick={add}
      >
        + ADD VALUE
      </button>
    </div>
  );
}

function ProhibitionsSection({
  state,
  setState,
  availableTools,
}: {
  state: Constitution;
  setState: (c: Constitution) => void;
  availableTools: ReadonlyArray<string>;
}): JSX.Element {
  const add = (): void => {
    const newP: Prohibition = {
      description: 'New prohibition',
      tools: [],
      after_local_hour: null,
      before_local_hour: null,
      match_input_contains: [],
    };
    setState({ ...state, prohibitions: [...state.prohibitions, newP] });
  };
  const update = (idx: number, patch: Partial<Prohibition>): void => {
    const next = state.prohibitions.slice();
    const merged = { ...next[idx], ...patch } as Prohibition;
    next[idx] = merged;
    setState({ ...state, prohibitions: next });
  };
  const remove = (idx: number): void => {
    setState({
      ...state,
      prohibitions: state.prohibitions.filter((_, i) => i !== idx),
    });
  };

  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>
        Prohibitions ({state.prohibitions.length})
      </div>
      <div style={hintStyle}>
        Hard rules enforced at every tool-call gate. First match wins; the
        description is what the user sees in the constitution_block insight.
      </div>

      {state.prohibitions.map((p, i) => (
        <ProhibitionRow
          key={i}
          p={p}
          index={i}
          availableTools={availableTools}
          onChange={patch => update(i, patch)}
          onRemove={() => remove(i)}
        />
      ))}

      <button style={{ ...buttonStyle, marginTop: 8 }} onClick={add}>
        + ADD PROHIBITION
      </button>
    </div>
  );
}

function ProhibitionRow({
  p,
  index,
  availableTools,
  onChange,
  onRemove,
}: {
  p: Prohibition;
  index: number;
  availableTools: ReadonlyArray<string>;
  onChange: (patch: Partial<Prohibition>) => void;
  onRemove: () => void;
}): JSX.Element {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [patternDraft, setPatternDraft] = useState('');

  const toolSet = useMemo(() => new Set(p.tools), [p.tools]);
  const toggleTool = (name: string): void => {
    const next = new Set(toolSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange({ tools: Array.from(next) });
  };

  const addPattern = (): void => {
    const v = patternDraft.trim();
    if (!v) return;
    onChange({
      match_input_contains: [...p.match_input_contains, v],
    });
    setPatternDraft('');
  };
  const removePattern = (idx: number): void => {
    onChange({
      match_input_contains: p.match_input_contains.filter((_, i) => i !== idx),
    });
  };

  const hourInputStyle: CSSProperties = {
    ...inputStyle,
    width: 80,
    textAlign: 'center',
  };

  return (
    <div
      style={{
        ...sectionStyle,
        marginBottom: 10,
        background: 'rgba(4, 14, 22, 0.5)',
        borderColor: 'var(--line-soft)',
      }}
    >
      <div style={rowStyle}>
        <span
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 10,
            color: 'var(--amber)',
            letterSpacing: '0.18em',
          }}
        >
          #{index + 1}
        </span>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="Description (shown in blocks)"
          value={p.description}
          onChange={e => onChange({ description: e.target.value })}
        />
        <button style={dangerButtonStyle} onClick={onRemove}>
          REMOVE
        </button>
      </div>

      <label style={{ ...fieldLabelStyle, marginTop: 10 }}>
        Tools ({p.tools.length === 0 ? 'all tools' : `${p.tools.length} selected`})
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {p.tools.map(t => (
          <span
            key={t}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              padding: '3px 8px',
              border: '1px solid var(--cyan)',
              color: 'var(--cyan)',
              cursor: 'pointer',
            }}
            onClick={() => toggleTool(t)}
            title="Click to remove"
          >
            {t} ×
          </span>
        ))}
        <button style={buttonStyle} onClick={() => setToolsExpanded(v => !v)}>
          {toolsExpanded ? 'HIDE PICKER' : 'PICK TOOLS'}
        </button>
      </div>
      {toolsExpanded && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 4,
            marginTop: 8,
            padding: 8,
            border: '1px solid var(--line-soft)',
            maxHeight: 160,
            overflow: 'auto',
          }}
        >
          {availableTools.map(t => (
            <label
              key={t}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: toolSet.has(t) ? 'var(--cyan)' : 'var(--ink-dim)',
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              <input
                type="checkbox"
                checked={toolSet.has(t)}
                onChange={() => toggleTool(t)}
              />
              {t}
            </label>
          ))}
        </div>
      )}
      <div style={hintStyle}>
        Empty → applies to ALL tools (universal ban in the time window).
      </div>

      <label style={{ ...fieldLabelStyle, marginTop: 10 }}>
        Hour window (local, 24h)
      </label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          style={hourInputStyle}
          type="number"
          min={0}
          max={23}
          value={p.after_local_hour ?? ''}
          placeholder="after"
          onChange={e =>
            onChange({
              after_local_hour: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        />
        <span style={hintStyle}>to</span>
        <input
          style={hourInputStyle}
          type="number"
          min={0}
          max={23}
          value={p.before_local_hour ?? ''}
          placeholder="before"
          onChange={e =>
            onChange({
              before_local_hour: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        />
        <span style={hintStyle}>
          Leave both blank for "always". 22 → 7 wraps midnight.
        </span>
      </div>

      <label style={{ ...fieldLabelStyle, marginTop: 10 }}>
        Input substring patterns ({p.match_input_contains.length})
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        {p.match_input_contains.map((pat, i) => (
          <span
            key={`${pat}-${i}`}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              padding: '3px 8px',
              border: '1px solid var(--amber)',
              color: 'var(--amber)',
              cursor: 'pointer',
            }}
            onClick={() => removePattern(i)}
            title="Click to remove"
          >
            "{pat}" ×
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={inputStyle}
          placeholder='e.g. "rm -rf /"'
          value={patternDraft}
          onChange={e => setPatternDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addPattern();
            }
          }}
        />
        <button style={buttonStyle} onClick={addPattern}>
          ADD
        </button>
      </div>
      <div style={hintStyle}>
        Blocks only when the tool's input (serialized JSON) contains any
        of these strings. Case-sensitive.
      </div>
    </div>
  );
}
