import { useRef, useState } from 'react';

type Props = {
  lists: ReadonlyArray<string>;
  onCreate: (title: string, list: string | undefined) => Promise<void> | void;
};

export function NewTaskRow({ lists, onCreate }: Props) {
  const [title, setTitle] = useState('');
  const [list, setList] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    if (busy) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed, list || undefined);
      setTitle('');
      inputRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const borderColor = focused ? 'var(--cyan)' : 'var(--line-soft)';
  const hasBang = /^!{1,3}/.test(title.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        display: 'flex', gap: 6, alignItems: 'stretch',
        border: `1px solid ${borderColor}`,
        borderLeft: `2px solid ${focused ? 'var(--cyan)' : hasBang ? 'var(--amber)' : 'var(--cyan)'}`,
        background: focused ? 'rgba(57, 229, 255, 0.04)' : 'rgba(0, 0, 0, 0.35)',
        padding: 4,
        opacity: busy ? 0.7 : 1,
        transition: 'border-color 140ms ease, background 140ms ease',
      }}>
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, color: focused ? 'var(--cyan)' : 'var(--ink-dim)',
          fontFamily: 'var(--display)', fontSize: 16, lineHeight: 1,
          transition: 'color 140ms ease',
        }}>+</div>
        <input
          ref={inputRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            else if (e.key === 'Escape') { setTitle(''); }
          }}
          disabled={busy}
          placeholder="add a task…  (prefix with !/!!/!!! for priority · ↵ to save)"
          aria-label="new task title"
          style={{
            all: 'unset', flex: 1,
            padding: '6px 4px',
            fontFamily: 'var(--label)', fontSize: 13,
            color: 'var(--ink)',
          }}
        />
        <select
          value={list}
          onChange={e => setList(e.target.value)}
          disabled={busy}
          aria-label="reminders list"
          style={{
            all: 'unset', cursor: busy ? 'not-allowed' : 'pointer',
            padding: '0 10px',
            fontFamily: 'var(--mono)', fontSize: 10.5,
            color: 'var(--ink-2)',
            borderLeft: '1px solid var(--line-soft)',
          }}
        >
          <option value="">default list</option>
          {lists.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <button
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
          style={{
            all: 'unset',
            cursor: (busy || !title.trim()) ? 'not-allowed' : 'pointer',
            padding: '0 14px',
            fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
            fontWeight: 700,
            color: (busy || !title.trim()) ? 'var(--ink-dim)' : 'var(--cyan)',
            borderLeft: '1px solid var(--line-soft)',
            background: 'rgba(57, 229, 255, 0.08)',
            opacity: (busy || !title.trim()) ? 0.5 : 1,
          }}
        >{busy ? '…' : 'ADD'}</button>
      </div>
      {error && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)',
          padding: '2px 4px',
        }}>{error}</div>
      )}
    </div>
  );
}
