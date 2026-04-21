/**
 * SkillEditor — authoring UI for brand-new procedural skills.
 *
 * κ v9 friction #5 ("no skill authoring story") gets a minimal but complete
 * form-driven answer: a user can create a skill *inside SUNNY herself* without
 * touching the vault or editing JSON by hand.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ NEW SKILL                                         × ESC  │
 *   │                                                          │
 *   │ NAME            [ morning-brief            ]             │
 *   │ DESCRIPTION     [ Reads today's calendar…  ]             │
 *   │ TRIGGER         [ what's on my plate today ]             │
 *   │                                                          │
 *   │ RECIPE                                                   │
 *   │  ┌──────────────────────────────────────────────────┐    │
 *   │  │ 1. [tool_call ▼]  calendar_list_events           │    │
 *   │  │    key=from   val={{$today_start}}               │    │
 *   │  │    + add arg                                      │    │
 *   │  ├──────────────────────────────────────────────────┤    │
 *   │  │ 2. [answer    ▼]  You have {{events}} on today.  │    │
 *   │  └──────────────────────────────────────────────────┘    │
 *   │ + add step                                                │
 *   │                                                          │
 *   │ CAPABILITIES: calendar_list_events                       │
 *   │                                                          │
 *   │ ● validation: 2 issues                                    │
 *   │   step 1 (calendar_list_events): missing required "to".  │
 *   │                                                          │
 *   │ [VALIDATE]  [SAVE]  [CANCEL]                             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Sprint-11 can layer AI-assisted recipe drafting on top ("let SUNNY
 * turn this conversation into a recipe"). For sprint-10 this is just a
 * form — no drag-and-drop, no wizardry.
 */

import {
  useMemo,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { Section, Toolbar, ToolbarButton } from '../_shared';
import { invokeSafe } from '../../lib/tauri';
import {
  validateRecipe,
  type RecipeStep,
  type SkillRecipe,
  type ValidationIssue,
} from '../../lib/skillExecutor';
import { TOOLS } from '../../lib/tools';
// Sprint-12 η — sign the canonical manifest on SAVE so provenance
// travels with the skill (see `../../lib/skillSignature.ts`).
import { signManifest, buildManifest } from '../../lib/skillSignature';
import type { ProceduralSkill } from './api';

// ---------------------------------------------------------------------------
// Editor-local types — every step carries a stable ID so list keys survive
// reorder, and args are an ordered list (not a Map) so the UI can render the
// user's own ordering. We translate to the canonical SkillRecipe shape only
// at validate/save time.
// ---------------------------------------------------------------------------

type DraftArg = { readonly id: string; readonly key: string; readonly value: string };

type DraftStep =
  | {
      readonly id: string;
      readonly kind: 'tool_call';
      readonly tool: string;
      readonly args: ReadonlyArray<DraftArg>;
      readonly saveAs: string;
    }
  | {
      readonly id: string;
      readonly kind: 'answer';
      readonly text: string;
    };

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

let idCounter = 0;
const nextId = (prefix: string): string => {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
};

const freshStep = (kind: 'tool_call' | 'answer'): DraftStep =>
  kind === 'tool_call'
    ? { id: nextId('step'), kind: 'tool_call', tool: '', args: [], saveAs: '' }
    : { id: nextId('step'), kind: 'answer', text: '' };

const freshArg = (): DraftArg => ({ id: nextId('arg'), key: '', value: '' });

// ---------------------------------------------------------------------------
// Draft → canonical recipe translator. Pure, returns a fresh SkillRecipe.
// ---------------------------------------------------------------------------

function buildRecipe(steps: ReadonlyArray<DraftStep>): SkillRecipe {
  const recipeSteps: RecipeStep[] = steps.map(step => {
    if (step.kind === 'answer') {
      return { kind: 'answer', text: step.text };
    }
    const input: Record<string, unknown> = {};
    for (const arg of step.args) {
      if (arg.key.length === 0) continue;
      input[arg.key] = coerceArgValue(arg.value);
    }
    return step.saveAs.length > 0
      ? { kind: 'tool', tool: step.tool, input, saveAs: step.saveAs }
      : { kind: 'tool', tool: step.tool, input };
  });
  // Capability allowlist = unique tool names used in the recipe.
  const caps = Array.from(
    new Set(
      recipeSteps
        .filter((s): s is Extract<RecipeStep, { kind: 'tool' }> => s.kind === 'tool')
        .map(s => s.tool)
        .filter(t => t.length > 0),
    ),
  );
  return caps.length > 0
    ? { steps: recipeSteps, capabilities: caps }
    : { steps: recipeSteps };
}

/**
 * Value coercion for the key-value editor. Strings that parse cleanly as
 * JSON (number, boolean, null, array, object) become their typed form;
 * everything else stays a string. This keeps the UI simple (one field per
 * arg) without losing the ability to pass numbers or nested objects.
 * Template tokens like `{{$goal}}` always fall through as strings.
 */
function coerceArgValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  // Templated strings never parse as JSON — keep as-is.
  if (/\{\{[^}]+\}\}/.test(trimmed)) return raw;
  if (
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed) ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('"')
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SkillEditor({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: ProceduralSkill) => void;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [trig, setTrig] = useState('');
  const [steps, setSteps] = useState<ReadonlyArray<DraftStep>>(() => [
    freshStep('tool_call'),
  ]);
  const [issues, setIssues] = useState<ReadonlyArray<ValidationIssue>>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toolNames = useMemo(
    () => Array.from(TOOLS.keys()).sort((a, b) => a.localeCompare(b)),
    [],
  );

  // Derived validation state — recomputed on every change so the user can
  // see issues live as they edit. The user-triggered VALIDATE button just
  // makes the list visible; we keep the list fresh regardless.
  const derivedRecipe = useMemo(() => buildRecipe(steps), [steps]);
  const capabilities = derivedRecipe.capabilities ?? [];

  const nameInvalid = name.length > 0 && !NAME_PATTERN.test(name);
  const nameEmpty = name.length === 0;

  // ---- helpers ----------------------------------------------------------

  const updateStep = (id: string, patch: Partial<DraftStep>) => {
    setSteps(prev =>
      prev.map(s => (s.id === id ? ({ ...s, ...patch } as DraftStep) : s)),
    );
  };

  const setStepKind = (id: string, kind: 'tool_call' | 'answer') => {
    setSteps(prev =>
      prev.map(s => {
        if (s.id !== id) return s;
        if (s.kind === kind) return s;
        return kind === 'answer'
          ? { id: s.id, kind: 'answer', text: '' }
          : { id: s.id, kind: 'tool_call', tool: '', args: [], saveAs: '' };
      }),
    );
  };

  const addStep = () => {
    setSteps(prev => [...prev, freshStep('tool_call')]);
  };

  const removeStep = (id: string) => {
    setSteps(prev => prev.filter(s => s.id !== id));
  };

  const addArg = (stepId: string) => {
    setSteps(prev =>
      prev.map(s =>
        s.id === stepId && s.kind === 'tool_call'
          ? { ...s, args: [...s.args, freshArg()] }
          : s,
      ),
    );
  };

  const updateArg = (stepId: string, argId: string, patch: Partial<DraftArg>) => {
    setSteps(prev =>
      prev.map(s =>
        s.id === stepId && s.kind === 'tool_call'
          ? {
              ...s,
              args: s.args.map(a => (a.id === argId ? { ...a, ...patch } : a)),
            }
          : s,
      ),
    );
  };

  const removeArg = (stepId: string, argId: string) => {
    setSteps(prev =>
      prev.map(s =>
        s.id === stepId && s.kind === 'tool_call'
          ? { ...s, args: s.args.filter(a => a.id !== argId) }
          : s,
      ),
    );
  };

  // ---- actions ----------------------------------------------------------

  const runValidation = (): ReadonlyArray<ValidationIssue> => {
    const result = validateRecipe(derivedRecipe);
    setIssues(result.issues);
    return result.issues;
  };

  const onClickValidate = () => {
    runValidation();
  };

  const onClickSave = async () => {
    if (busy) return;
    setSaveError(null);

    // Top-level preconditions.
    if (nameEmpty || nameInvalid) {
      setSaveError('Name is required and must be lowercase with hyphens (e.g. "morning-brief").');
      return;
    }
    if (desc.trim().length === 0) {
      setSaveError('Description is required.');
      return;
    }
    if (trig.trim().length === 0) {
      setSaveError('Trigger phrase is required — it is what SUNNY matches against.');
      return;
    }
    if (steps.length === 0) {
      setSaveError('Recipe needs at least one step.');
      return;
    }

    const found = runValidation();
    if (found.length > 0) {
      setSaveError(`Fix ${found.length} validation issue${found.length === 1 ? '' : 's'} before saving.`);
      return;
    }

    setBusy(true);
    try {
      // Sprint-12 η — sign the manifest before persisting so the row
      // lands in SQLite with its provenance. A missing/failed signer
      // still lets the skill save (we don't want a broken identity
      // subsystem to make authoring impossible), but we surface the
      // reason as a soft error after save so the user knows their
      // skill is unsigned and won't verify on export/import.
      const manifest = buildManifest({
        name,
        description: desc,
        trigger_text: trig,
        recipe: derivedRecipe,
      });
      const signed = await signManifest(manifest);
      const created = await invokeSafe<ProceduralSkill>('memory_skill_add', {
        name,
        description: desc,
        triggerText: trig,
        // Empty path — pure-recipe skill, no file on disk.
        skillPath: '',
        recipe: derivedRecipe,
        signature: signed?.signature ?? null,
        signerFingerprint: signed?.signer_fingerprint ?? null,
      });
      if (!created) {
        setSaveError('Failed to save skill — memory_skill_add returned null.');
        return;
      }
      if (!signed) {
        // Signature failed — surface the drift, but the skill is saved.
        // eslint-disable-next-line no-console
        console.warn('[SkillEditor] skill saved unsigned (sign_skill_manifest returned null)');
      }
      onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(`Save failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  // ---- render -----------------------------------------------------------

  return (
    <Section title="NEW SKILL" right="DRAFT">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field
          label="NAME"
          value={name}
          onChange={setName}
          placeholder="lowercase-with-hyphens"
          maxLen={80}
          invalid={nameInvalid}
          hint={
            nameInvalid
              ? 'Only lowercase letters, digits, and hyphens. Must start with a letter.'
              : 'Used as the stable ID the router matches against.'
          }
        />
        <Field
          label="DESCRIPTION"
          value={desc}
          onChange={setDesc}
          multiline
          placeholder="What does this skill do? Be specific — the embedding learns from this."
          maxLen={500}
        />
        <Field
          label="TRIGGER"
          value={trig}
          onChange={setTrig}
          multiline
          placeholder="What the user would say, e.g. 'what's on my plate today?'"
          maxLen={300}
          hint="Embedded for cosine match — write it the way a user would phrase the request."
        />

        {/* Recipe builder */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>RECIPE</SectionLabel>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 8,
              border: '1px solid var(--line-soft)',
              background: 'rgba(0, 0, 0, 0.2)',
            }}
          >
            {steps.length === 0 && (
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--ink-dim)',
                  fontStyle: 'italic',
                }}
              >
                Empty recipe — add a step to get started.
              </div>
            )}
            {steps.map((step, i) => (
              <StepRow
                key={step.id}
                index={i}
                step={step}
                toolNames={toolNames}
                onKindChange={kind => setStepKind(step.id, kind)}
                onToolChange={tool => updateStep(step.id, { tool })}
                onSaveAsChange={saveAs => updateStep(step.id, { saveAs })}
                onTextChange={text => updateStep(step.id, { text })}
                onAddArg={() => addArg(step.id)}
                onArgChange={(argId, patch) => updateArg(step.id, argId, patch)}
                onRemoveArg={argId => removeArg(step.id, argId)}
                onRemove={() => removeStep(step.id)}
              />
            ))}
            <button onClick={addStep} style={addButtonStyle}>
              + ADD STEP
            </button>
          </div>
        </div>

        {/* Preview: computed capability list */}
        <PreviewBlock capabilities={capabilities} />

        {/* Inline validation output */}
        {issues.length > 0 && <IssueList issues={issues} />}

        {saveError && (
          <div role="alert" style={errorStyle}>
            {saveError}
          </div>
        )}
      </div>

      <Toolbar style={{ marginTop: 12 }}>
        <ToolbarButton tone="cyan" onClick={() => void onClickSave()} disabled={busy}>
          {busy ? 'SAVING…' : 'SAVE'}
        </ToolbarButton>
        <ToolbarButton tone="teal" onClick={onClickValidate} disabled={busy}>
          VALIDATE
        </ToolbarButton>
        <ToolbarButton onClick={onClose} disabled={busy}>
          CANCEL · ESC
        </ToolbarButton>
      </Toolbar>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--display)',
        fontSize: 9,
        letterSpacing: '0.22em',
        color: 'var(--ink-2)',
        fontWeight: 700,
      }}
    >
      {children}
    </div>
  );
}

function StepRow({
  index,
  step,
  toolNames,
  onKindChange,
  onToolChange,
  onSaveAsChange,
  onTextChange,
  onAddArg,
  onArgChange,
  onRemoveArg,
  onRemove,
}: {
  index: number;
  step: DraftStep;
  toolNames: ReadonlyArray<string>;
  onKindChange: (kind: 'tool_call' | 'answer') => void;
  onToolChange: (tool: string) => void;
  onSaveAsChange: (saveAs: string) => void;
  onTextChange: (text: string) => void;
  onAddArg: () => void;
  onArgChange: (argId: string, patch: Partial<DraftArg>) => void;
  onRemoveArg: (argId: string) => void;
  onRemove: () => void;
}) {
  const datalistId = `tools-${step.id}`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        border: '1px solid var(--line-soft)',
        background: 'rgba(6, 14, 22, 0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink-dim)',
            width: 22,
          }}
        >
          {index + 1}.
        </span>
        <select
          value={step.kind}
          onChange={e => onKindChange(e.target.value as 'tool_call' | 'answer')}
          style={selectStyle}
          aria-label={`Step ${index + 1} kind`}
        >
          <option value="tool_call">tool_call</option>
          <option value="answer">answer</option>
        </select>
        {step.kind === 'tool_call' && (
          <>
            <input
              list={datalistId}
              value={step.tool}
              onChange={e => onToolChange(e.target.value)}
              placeholder="tool name"
              aria-label={`Step ${index + 1} tool name`}
              style={{ ...inputStyle, flex: 1 }}
            />
            <datalist id={datalistId}>
              {toolNames.map(t => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <input
              value={step.saveAs}
              onChange={e => onSaveAsChange(e.target.value)}
              placeholder="saveAs (optional)"
              aria-label={`Step ${index + 1} saveAs slot`}
              style={{ ...inputStyle, width: 140 }}
            />
          </>
        )}
        <button onClick={onRemove} style={ghostButtonStyle} aria-label={`Remove step ${index + 1}`}>
          ×
        </button>
      </div>

      {step.kind === 'tool_call' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 30 }}>
          {step.args.length === 0 && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--ink-dim)',
                fontStyle: 'italic',
              }}
            >
              No args — click + add arg to supply input.
            </div>
          )}
          {step.args.map(arg => (
            <div key={arg.id} style={{ display: 'flex', gap: 6 }}>
              <input
                value={arg.key}
                onChange={e => onArgChange(arg.id, { key: e.target.value })}
                placeholder="key"
                aria-label="arg key"
                style={{ ...inputStyle, width: 120 }}
              />
              <input
                value={arg.value}
                onChange={e => onArgChange(arg.id, { value: e.target.value })}
                placeholder="value (use {{$goal}} for templates)"
                aria-label="arg value"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => onRemoveArg(arg.id)}
                style={ghostButtonStyle}
                aria-label="remove arg"
              >
                ×
              </button>
            </div>
          ))}
          <button onClick={onAddArg} style={addButtonStyle}>
            + add arg
          </button>
        </div>
      )}

      {step.kind === 'answer' && (
        <textarea
          value={step.text}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onTextChange(e.target.value)}
          placeholder="Final answer text — use {{savedName}} to interpolate earlier tool results."
          rows={2}
          style={{
            ...inputStyle,
            marginLeft: 30,
            fontFamily: 'var(--mono)',
            resize: 'vertical',
            minHeight: 42,
          }}
        />
      )}
    </div>
  );
}

function PreviewBlock({ capabilities }: { capabilities: ReadonlyArray<string> }) {
  return (
    <div
      style={{
        padding: '6px 10px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(0, 210, 180, 0.04)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--display)',
          fontSize: 8,
          letterSpacing: '0.22em',
          color: 'var(--teal)',
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        CAPABILITIES
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
        {capabilities.length === 0
          ? 'tools used: —'
          : `tools used: ${capabilities.join(', ')}`}
      </div>
    </div>
  );
}

function IssueList({ issues }: { issues: ReadonlyArray<ValidationIssue> }) {
  return (
    <div
      role="status"
      style={{
        padding: '6px 10px',
        border: '1px solid var(--amber)',
        borderLeft: '2px solid var(--amber)',
        background: 'rgba(255, 193, 77, 0.06)',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--display)',
          fontSize: 8,
          letterSpacing: '0.22em',
          color: 'var(--amber)',
          fontWeight: 700,
        }}
      >
        {issues.length} VALIDATION ISSUE{issues.length === 1 ? '' : 'S'}
      </div>
      {issues.map((iss, i) => (
        <div
          key={i}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink-2)',
          }}
        >
          • {iss.message}
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline,
  placeholder,
  maxLen,
  invalid,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  maxLen?: number;
  invalid?: boolean;
  hint?: string;
}) {
  const remaining = maxLen ? maxLen - value.length : null;
  const borderColor = invalid ? 'var(--red)' : 'var(--line-soft)';

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 9,
            letterSpacing: '0.22em',
            color: invalid ? 'var(--red)' : 'var(--ink-2)',
            fontWeight: 700,
          }}
        >
          {label}
        </span>
        {remaining !== null && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: remaining < 20 ? 'var(--amber)' : 'var(--ink-dim)',
            }}
          >
            {remaining}
          </span>
        )}
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            const next = e.target.value;
            if (maxLen && next.length > maxLen) return;
            onChange(next);
          }}
          rows={3}
          placeholder={placeholder}
          style={{
            ...inputStyle,
            borderColor,
            minHeight: 56,
            fontFamily: 'var(--label)',
            fontSize: 12.5,
            resize: 'vertical',
          }}
        />
      ) : (
        <input
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            if (maxLen && next.length > maxLen) return;
            onChange(next);
          }}
          placeholder={placeholder}
          style={{
            ...inputStyle,
            borderColor,
            fontFamily: 'var(--label)',
            fontSize: 12.5,
          }}
        />
      )}
      {hint && (
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: invalid ? 'var(--red)' : 'var(--ink-dim)',
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Shared inline styles (kept here, not in primitives, because the editor is
// a one-off surface — promoting these would be speculative reuse).
// ---------------------------------------------------------------------------

const inputStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  padding: '6px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.3)',
};

const selectStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid var(--line-soft)',
  padding: '4px 8px',
  borderRadius: 2,
  cursor: 'pointer',
  minWidth: 110,
};

const addButtonStyle: CSSProperties = {
  all: 'unset',
  alignSelf: 'flex-start',
  cursor: 'pointer',
  padding: '4px 10px',
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.22em',
  color: 'var(--cyan)',
  fontWeight: 700,
  border: '1px dashed var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.04)',
};

const ghostButtonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '2px 8px',
  fontFamily: 'var(--mono)',
  fontSize: 13,
  color: 'var(--ink-dim)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.3)',
  lineHeight: 1,
};

const errorStyle: CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--red)',
  borderLeft: '2px solid var(--red)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--red)',
  background: 'rgba(255, 77, 94, 0.06)',
};
