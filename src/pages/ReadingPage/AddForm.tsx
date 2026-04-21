import { useState } from 'react';
import { invokeSafe } from '../../lib/tauri';
import { addReading } from './store';

type FetchResult = {
  ok: boolean;
  status: number;
  title: string;
  body_html: string;
  text: string;
  url: string;
  final_url: string;
};

const WORDS_PER_MINUTE = 238;

function deriveExtras(text: string): { excerpt: string; wordCount: number; minutes: number } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const excerpt = normalized.slice(0, 300);
  const words = normalized.length > 0 ? normalized.split(' ').length : 0;
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return { excerpt, wordCount: words, minutes };
}

export function AddForm({ onAdd }: { onAdd?: (url: string, title?: string) => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setBusy(true);
    // Fetch readable contents BEFORE saving so we can derive excerpt + read
    // time. Failures fall through to a url-only save — the user's click is
    // authoritative; network issues shouldn't eat their input.
    const result = await invokeSafe<FetchResult>('web_fetch_readable', { url: trimmed });
    const effectiveTitle = title.trim() || result?.title?.trim() || undefined;
    if (result && result.ok && result.text) {
      const { excerpt, minutes } = deriveExtras(result.text);
      addReading(trimmed, effectiveTitle, { excerpt, minutes });
    } else {
      addReading(trimmed, effectiveTitle);
    }
    // Keep the legacy prop around for callers that still pass it; pages that
    // want to observe the save can subscribe via the store.
    onAdd?.(trimmed, effectiveTitle);
    setUrl(''); setTitle('');
    setBusy(false);
  };

  return (
    <div style={{
      display: 'flex', gap: 6, alignItems: 'stretch',
      border: '1px solid var(--line-soft)',
      background: 'rgba(0, 0, 0, 0.35)',
      padding: 4,
    }}>
      <input
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
        placeholder="paste URL to save for later…"
        style={{
          all: 'unset', flex: 2,
          padding: '6px 10px',
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
        }}
      />
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
        placeholder="title (optional)"
        style={{
          all: 'unset', flex: 1,
          padding: '6px 10px',
          fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
          borderLeft: '1px solid var(--line-soft)',
        }}
      />
      <button
        onClick={() => void submit()}
        disabled={busy}
        style={{
          all: 'unset', cursor: busy ? 'not-allowed' : 'pointer',
          padding: '0 16px',
          fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
          fontWeight: 700, color: 'var(--violet)',
          background: 'rgba(180, 140, 255, 0.1)',
          borderLeft: '1px solid var(--line-soft)',
          opacity: busy ? 0.5 : 1,
        }}
      >{busy ? 'FETCH…' : 'SAVE'}</button>
    </div>
  );
}
