/**
 * NewMemoryForm — inline drawer for manually adding a memory.
 *
 * Used by EpisodicTab and SemanticTab. Each tab configures the fields it
 * needs via the `kind` prop; the form handles state, validation,
 * submission, and the subtle "flash the freshly-added row" handoff to the
 * parent via `onCreated`.
 *
 * Two things to note:
 *   • Tags are entered as a comma / space / `#`-separated string. We split
 *     and trim so "#focus coding, mood" and "focus, coding, mood" both
 *     produce ["focus", "coding", "mood"].
 *   • All backend calls go through `invokeSafe`: a missing Tauri shell
 *     returns `null` (button becomes a no-op) rather than throwing.
 */

import { useCallback, useState, type CSSProperties, type JSX } from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  DISPLAY_FONT,
  buttonStyle,
  errorStyle,
  fieldLabelStyle,
  primaryButtonStyle,
} from './styles';
import type { EpisodicItem, EpisodicKind, SemanticFact } from './types';

const EPISODIC_KINDS: ReadonlyArray<{ id: EpisodicKind; label: string }> = [
  { id: 'note', label: 'NOTE' },
  { id: 'user', label: 'USER' },
  { id: 'reflection', label: 'REFLECT' },
  { id: 'perception', label: 'PERCEPT' },
];

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(s => s.replace(/^#/, '').trim())
    .filter(s => s.length > 0);
}

type EpisodicProps = {
  readonly kind: 'episodic';
  readonly onClose: () => void;
  readonly onCreated: (item: EpisodicItem) => void;
};

type SemanticProps = {
  readonly kind: 'semantic';
  readonly onClose: () => void;
  readonly onCreated: (fact: SemanticFact) => void;
};

type Props = EpisodicProps | SemanticProps;

export function NewMemoryForm(props: Props): JSX.Element {
  if (props.kind === 'episodic') return <EpisodicForm {...props} />;
  return <SemanticForm {...props} />;
}

// ---------------------------------------------------------------------------
// Episodic
// ---------------------------------------------------------------------------

function EpisodicForm({ onClose, onCreated }: EpisodicProps): JSX.Element {
  const [kind, setKind] = useState<EpisodicKind>('note');
  const [text, setText] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setErr('Text is required');
      return;
    }
    setSaving(true);
    setErr(null);
    const item = await invokeSafe<EpisodicItem>('memory_episodic_add', {
      kind,
      text: trimmed,
      tags: parseTags(tagsRaw),
      meta: null,
    });
    setSaving(false);
    if (!item) {
      setErr('Save failed — backend unavailable');
      return;
    }
    onCreated(item);
    onClose();
  }, [kind, text, tagsRaw, onCreated, onClose]);

  return (
    <div className="mem-new-drawer">
      <FormHeader
        title="NEW EPISODIC MEMORY"
        canSave={text.trim().length > 0 && !saving}
        saving={saving}
        onSave={() => void submit()}
        onClose={onClose}
      />

      {err && <div style={errorStyle}>ERROR · {err}</div>}

      <div style={kindRowStyle}>
        <span id="episodic-kind-label" style={fieldLabelStyle}>Kind</span>
        <div role="group" aria-labelledby="episodic-kind-label" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {EPISODIC_KINDS.map(k => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              style={chipStyle(kind === k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="episodic-text" style={fieldLabelStyle}>Text</label>
        <textarea
          id="episodic-text"
          className="mem-input"
          style={{ width: '100%' }}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="What happened, or what you want SUNNY to remember…"
          autoFocus
        />
      </div>

      <div>
        <label htmlFor="episodic-tags" style={fieldLabelStyle}>
          Tags <span style={{ opacity: 0.6 }}>(comma or space separated)</span>
        </label>
        <input
          id="episodic-tags"
          className="mem-input"
          style={{ width: '100%' }}
          value={tagsRaw}
          onChange={e => setTagsRaw(e.target.value)}
          placeholder="#focus #terminal  or  focus, terminal"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Semantic
// ---------------------------------------------------------------------------

function SemanticForm({ onClose, onCreated }: SemanticProps): JSX.Element {
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [confidence, setConfidence] = useState(0.9);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setErr('Text is required');
      return;
    }
    setSaving(true);
    setErr(null);
    const fact = await invokeSafe<SemanticFact>('memory_fact_add', {
      subject: subject.trim(),
      text: trimmed,
      tags: parseTags(tagsRaw),
      confidence,
      source: 'user',
    });
    setSaving(false);
    if (!fact) {
      setErr('Save failed — backend unavailable');
      return;
    }
    onCreated(fact);
    onClose();
  }, [subject, text, tagsRaw, confidence, onCreated, onClose]);

  return (
    <div className="mem-new-drawer">
      <FormHeader
        title="NEW SEMANTIC FACT"
        canSave={text.trim().length > 0 && !saving}
        saving={saving}
        onSave={() => void submit()}
        onClose={onClose}
      />

      {err && <div style={errorStyle}>ERROR · {err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 10 }}>
        <div>
          <label htmlFor="semantic-subject" style={fieldLabelStyle}>Subject</label>
          <input
            id="semantic-subject"
            className="mem-input"
            style={{ width: '100%' }}
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="e.g. user.preferences"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="semantic-confidence" style={fieldLabelStyle}>
            Confidence <span style={{ color: 'var(--cyan)' }}>{(confidence * 100).toFixed(0)}%</span>
          </label>
          <input
            id="semantic-confidence"
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={confidence}
            onChange={e => setConfidence(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--cyan)' }}
          />
        </div>
      </div>

      <div>
        <label htmlFor="semantic-fact" style={fieldLabelStyle}>Fact</label>
        <textarea
          id="semantic-fact"
          className="mem-input"
          style={{ width: '100%' }}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="A durable fact about the user, a project, or the world…"
        />
      </div>

      <div>
        <label htmlFor="semantic-tags" style={fieldLabelStyle}>
          Tags <span style={{ opacity: 0.6 }}>(comma or space separated)</span>
        </label>
        <input
          id="semantic-tags"
          className="mem-input"
          style={{ width: '100%' }}
          value={tagsRaw}
          onChange={e => setTagsRaw(e.target.value)}
          placeholder="preference, workflow"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function FormHeader({
  title,
  canSave,
  saving,
  onSave,
  onClose,
}: {
  title: string;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <strong style={{ fontFamily: DISPLAY_FONT, fontSize: 10.5, letterSpacing: '0.22em', color: 'var(--cyan)' }}>
        {title}
      </strong>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={canSave ? onSave : undefined}
        disabled={!canSave}
        style={{
          ...primaryButtonStyle,
          color: canSave ? 'var(--green)' : 'var(--ink-dim)',
          borderColor: canSave ? 'rgba(125, 255, 154, 0.55)' : 'var(--line-soft)',
          background: canSave ? 'rgba(125, 255, 154, 0.06)' : 'transparent',
          opacity: canSave ? 1 : 0.55,
          cursor: canSave ? 'pointer' : 'not-allowed',
        }}
      >
        {saving ? 'SAVING…' : '+ SAVE'}
      </button>
      <button type="button" onClick={onClose} disabled={saving} style={buttonStyle}>
        CANCEL
      </button>
    </div>
  );
}

const kindRowStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
};

function chipStyle(active: boolean): CSSProperties {
  return {
    all: 'unset',
    padding: '4px 10px',
    fontFamily: DISPLAY_FONT,
    fontSize: 9,
    letterSpacing: '0.18em',
    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    background: active ? 'rgba(57, 229, 255, 0.08)' : 'transparent',
    cursor: 'pointer',
  };
}
