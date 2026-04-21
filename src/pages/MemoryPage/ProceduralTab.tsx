import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import {
  DISPLAY_FONT,
  badgeStyle,
  buttonStyle,
  dangerButtonStyle,
  emptyStyle,
  errorStyle,
  listStyle,
  metaTextStyle,
  rowHeaderStyle,
  rowStyle,
  searchInputStyle,
  searchRowStyle,
} from './styles';
import { TauriRequired } from './TauriRequired';
import type { ProceduralSkill } from './types';
import { formatRelative, safeStringify, useCopyFlash, useDebouncedQuery } from './utils';

// ---------------------------------------------------------------------------
// Procedural tab — list learned skills + inline edit affordance.
//
// Users can edit a skill's name, description, trigger text, and recipe
// JSON directly in the tab (no separate page). Auto-synthesized skills
// are often clumsily named ("morning-brief-a3f7") — this lets the user
// rename them without losing the uses_count or embedding (embed refreshes
// automatically in the background when trigger_text or description
// change).
// ---------------------------------------------------------------------------

export function ProceduralTab({ onChange }: { onChange: () => void }): JSX.Element {
  const [rows, setRows] = useState<ReadonlyArray<ProceduralSkill>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const query = useDebouncedQuery(raw);
  const copyState = useCopyFlash();

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    setErr(null);
    try {
      const items = await invokeSafe<ReadonlyArray<ProceduralSkill>>('memory_skill_list');
      setRows(items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Client-side filter across name / description / trigger_text. There is no
  // memory_skill_search backend command, and skill counts are small enough
  // (typically <100) that in-memory match is instant.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return rows;
    return rows.filter(
      s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.trigger_text.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const del = useCallback(
    async (id: string) => {
      const ok = await invokeSafe<void>('memory_skill_delete', { id });
      if (ok !== null) {
        setRows(rs => rs.filter(r => r.id !== id));
        onChange();
      }
    },
    [onChange],
  );

  const update = useCallback(
    async (id: string, patch: UpdatePatch): Promise<string | null> => {
      const res = await invokeSafe<ProceduralSkill>('memory_skill_update', { id, patch });
      if (res === null) {
        // invokeSafe returns null on any Tauri error; the Rust side returns
        // the fresh row on success. We can't read the error message here,
        // but the UI already surfaces failures via the err state.
        return 'Save failed — backend unavailable';
      }
      // Replace the row in-place; preserve list order.
      setRows(rs => rs.map(r => (r.id === id ? res : r)));
      onChange();
      return null;
    },
    [onChange],
  );

  if (!isTauri) return <TauriRequired />;

  return (
    <>
      {err && <div style={errorStyle}>ERROR · {err}</div>}
      <div style={searchRowStyle}>
        <input
          style={searchInputStyle}
          placeholder="Search skills by name, description, or trigger…"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          aria-label="Filter skills"
        />
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            color: 'var(--ink-dim)',
            alignSelf: 'center',
            minWidth: 90,
            textAlign: 'right',
          }}
        >
          {query.trim() ? `${filtered.length} / ${rows.length}` : `${rows.length} TOTAL`}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={emptyStyle}>
          NO LEARNED SKILLS · the synthesizer auto-creates skills from 5+ matching successful runs
        </div>
      ) : filtered.length === 0 ? (
        <div style={emptyStyle}>NO SKILLS MATCH "{query.trim()}"</div>
      ) : (
        <div style={listStyle} aria-live="polite" aria-relevant="additions removals">
          {filtered.map(s => (
            <ProceduralRow
              key={s.id}
              skill={s}
              copied={copyState.flashedId === s.id}
              onCopy={copyState.copy}
              onDelete={del}
              onUpdate={update}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit patch shape (mirror of Rust UpdateSkillOpts)
// ---------------------------------------------------------------------------

type UpdatePatch = {
  readonly name?: string;
  readonly description?: string;
  readonly trigger_text?: string;
  readonly recipe?: unknown | null;
};

function ProceduralRow({
  skill,
  copied,
  onCopy,
  onDelete,
  onUpdate,
}: {
  skill: ProceduralSkill;
  copied: boolean;
  onCopy: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<string | null>;
}): JSX.Element {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [recipeExpanded, setRecipeExpanded] = useState(false);
  const recipeText = skill.recipe ? safeStringify(skill.recipe) : null;
  const lastUsed =
    skill.last_used_at && skill.last_used_at > 0
      ? formatRelative(skill.last_used_at, Math.floor(Date.now() / 1000))
      : 'never';

  const successCount = skill.success_count ?? 0;
  const hasRatio = skill.uses_count > 0;
  const successRate = hasRatio ? successCount / skill.uses_count : null;
  const successColor =
    successRate === null
      ? 'var(--ink-dim)'
      : successRate >= 0.9
        ? 'var(--green)'
        : successRate >= 0.7
          ? 'var(--cyan)'
          : successRate >= 0.5
            ? 'var(--amber)'
            : 'var(--red)';

  if (mode === 'edit') {
    return (
      <SkillEditForm
        skill={skill}
        onCancel={() => setMode('view')}
        onSaved={async patch => {
          const err = await onUpdate(skill.id, patch);
          if (err === null) setMode('view');
          return err;
        }}
      />
    );
  }

  return (
    <div
      style={{
        ...rowStyle,
        borderColor: copied ? 'var(--green)' : rowStyle.borderColor,
      }}
    >
      <div style={rowHeaderStyle}>
        <span style={badgeStyle('var(--green)')}>SKILL</span>
        <strong style={{ fontFamily: DISPLAY_FONT, fontSize: 11, letterSpacing: '0.12em' }}>
          {skill.name}
        </strong>
        {hasRatio && (
          <span style={badgeStyle(successColor)} title={`${successCount}/${skill.uses_count} ok`}>
            {successCount}/{skill.uses_count}
          </span>
        )}
        <span style={metaTextStyle}>last: {lastUsed}</span>
        {!recipeText && (
          <span style={{ ...metaTextStyle, color: 'var(--amber)' }}>[no recipe — script-backed]</span>
        )}
        {copied && (
          <span style={{ ...metaTextStyle, color: 'var(--green)' }}>COPIED</span>
        )}
        <span style={{ flex: 1 }} />
        {recipeText && (
          <button type="button" aria-expanded={recipeExpanded} style={buttonStyle} onClick={() => setRecipeExpanded(v => !v)}>
            {recipeExpanded ? 'HIDE RECIPE' : 'SHOW RECIPE'}
          </button>
        )}
        <button type="button" style={buttonStyle} onClick={() => setMode('edit')}>
          EDIT
        </button>
        <button type="button" style={dangerButtonStyle} onClick={() => onDelete(skill.id)}>
          DELETE
        </button>
      </div>
      <div
        style={{ color: 'var(--ink)', cursor: 'copy' }}
        title="Click to copy description"
        onClick={() => onCopy(skill.id, skill.description || skill.name)}
      >
        {skill.description || '(no description)'}
      </div>
      {skill.trigger_text && (
        <div style={{ ...metaTextStyle, color: 'var(--cyan)' }}>
          trigger · {skill.trigger_text}
        </div>
      )}
      {recipeExpanded && recipeText && (
        <pre style={preStyle}>{recipeText}</pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit form — replaces the row in-place
// ---------------------------------------------------------------------------

function SkillEditForm({
  skill,
  onCancel,
  onSaved,
}: {
  skill: ProceduralSkill;
  onCancel: () => void;
  onSaved: (patch: UpdatePatch) => Promise<string | null>;
}): JSX.Element {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [triggerText, setTriggerText] = useState(skill.trigger_text);
  const [recipeDraft, setRecipeDraft] = useState(
    skill.recipe ? safeStringify(skill.recipe) : '',
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Live JSON validation on the recipe textarea. Empty string is a valid
  // "no recipe" state; anything else must parse as JSON.
  const recipeParseResult = useMemo((): { ok: true; value: unknown } | { ok: false; err: string } | null => {
    const trimmed = recipeDraft.trim();
    if (trimmed.length === 0) return null;
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  }, [recipeDraft]);

  // Only send fields that actually changed. The Rust side treats absent
  // fields as "keep current" — that's why we patch sparsely here.
  // Intermediate `MutablePatch` shape mirrors `UpdatePatch` without the
  // readonly markers so we can build the diff incrementally.
  type MutablePatch = {
    name?: string;
    description?: string;
    trigger_text?: string;
    recipe?: unknown | null;
  };
  const diff = useMemo((): UpdatePatch => {
    const out: MutablePatch = {};
    if (name !== skill.name) out.name = name;
    if (description !== skill.description) out.description = description;
    if (triggerText !== skill.trigger_text) out.trigger_text = triggerText;
    const currentRecipe = skill.recipe ? safeStringify(skill.recipe) : '';
    const nextTrim = recipeDraft.trim();
    if (nextTrim !== currentRecipe.trim()) {
      if (nextTrim.length === 0) {
        out.recipe = null;
      } else if (recipeParseResult?.ok) {
        out.recipe = recipeParseResult.value;
      }
      // If recipe didn't parse, we leave it out of the diff and let
      // the save button stay disabled (see canSave below).
    }
    return out as UpdatePatch;
  }, [name, description, triggerText, recipeDraft, recipeParseResult, skill]);

  const canSave =
    Object.keys(diff).length > 0 &&
    !(recipeDraft.trim().length > 0 && recipeParseResult?.ok === false) &&
    name.trim().length > 0 &&
    !saving;

  const save = async (): Promise<void> => {
    setSaving(true);
    setErr(null);
    const msg = await onSaved(diff);
    if (msg !== null) setErr(msg);
    setSaving(false);
  };

  return (
    <div style={{ ...rowStyle, borderColor: 'var(--cyan)' }}>
      <div style={rowHeaderStyle}>
        <span style={badgeStyle('var(--cyan)')}>EDIT</span>
        <strong style={{ fontFamily: DISPLAY_FONT, fontSize: 11, letterSpacing: '0.12em' }}>
          {skill.name}
        </strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={saveButtonStyle(canSave)}
          onClick={canSave ? () => void save() : undefined}
          disabled={!canSave}
        >
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
        <button type="button" style={buttonStyle} onClick={onCancel} disabled={saving}>
          CANCEL
        </button>
      </div>

      {err && <div style={{ ...errorStyle, marginTop: 4 }}>SAVE ERROR · {err}</div>}

      <label htmlFor="skill-edit-name" style={fieldLabelStyle}>Name</label>
      <input id="skill-edit-name" style={searchInputStyle} value={name} onChange={e => setName(e.target.value)} />

      <label htmlFor="skill-edit-description" style={{ ...fieldLabelStyle, marginTop: 8 }}>Description</label>
      <textarea
        id="skill-edit-description"
        style={{ ...searchInputStyle, minHeight: 50, resize: 'vertical' }}
        value={description}
        onChange={e => setDescription(e.target.value)}
      />

      <label htmlFor="skill-edit-trigger" style={{ ...fieldLabelStyle, marginTop: 8 }}>Trigger text</label>
      <textarea
        id="skill-edit-trigger"
        style={{ ...searchInputStyle, minHeight: 40, resize: 'vertical' }}
        value={triggerText}
        onChange={e => setTriggerText(e.target.value)}
        placeholder="comma-separated phrases the goal might match"
      />
      <div style={{ ...metaTextStyle, marginTop: 2 }}>
        Embedded for goal-match; edits re-embed in background.
      </div>

      <label htmlFor="skill-edit-recipe" style={{ ...fieldLabelStyle, marginTop: 8 }}>
        Recipe JSON
        {recipeParseResult?.ok === false && (
          <span style={{ color: 'var(--amber)', marginLeft: 8 }}>
            invalid JSON — {recipeParseResult.err}
          </span>
        )}
        {recipeDraft.trim().length === 0 && (
          <span style={{ color: 'var(--ink-dim)', marginLeft: 8 }}>
            (empty = script-backed; will clear recipe)
          </span>
        )}
      </label>
      <textarea
        id="skill-edit-recipe"
        style={{
          ...searchInputStyle,
          minHeight: 140,
          resize: 'vertical',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          borderColor:
            recipeParseResult?.ok === false ? 'var(--amber)' : 'var(--line-soft)',
        }}
        value={recipeDraft}
        onChange={e => setRecipeDraft(e.target.value)}
        placeholder='{ "steps": [ { "kind": "tool", "tool": "fs_list", "input": {...} }, { "kind": "answer", "text": "..." } ] }'
        spellCheck={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local styles
// ---------------------------------------------------------------------------

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.1em',
  color: 'var(--ink-dim)',
  marginBottom: 3,
  textTransform: 'uppercase',
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  fontSize: 10.5,
  background: 'rgba(6, 14, 22, 0.7)',
  color: 'var(--ink-dim)',
  border: '1px solid var(--line-soft)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function saveButtonStyle(enabled: boolean): CSSProperties {
  return {
    ...buttonStyle,
    color: enabled ? 'var(--green)' : 'var(--ink-dim)',
    borderColor: enabled ? 'rgba(30, 200, 80, 0.55)' : 'var(--line-soft)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.6,
  };
}
