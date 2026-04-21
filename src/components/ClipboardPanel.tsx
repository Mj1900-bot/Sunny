import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from './Panel';
import { CLIPBOARD_ITEMS } from '../data/seeds';
import { invokeSafe, isTauri, listen } from '../lib/tauri';
import { toast } from '../hooks/useToast';

type ClipKind = 'TEXT' | 'URL' | 'CODE' | 'IMG';

type ClipboardEntry = {
  kind: ClipKind;
  time: string;
  text: string;
};

const MAX_HISTORY = 20;

const PINS_KEY = 'sunny.clip.pins.v1';
const HIDDEN_KEY = 'sunny.clip.hidden.v1';

const ALLOWED_KINDS: ReadonlyArray<ClipKind> = ['TEXT', 'URL', 'CODE', 'IMG'];

function normalizeEntry(raw: unknown): ClipboardEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kindRaw = typeof r.kind === 'string' ? r.kind.toUpperCase() : '';
  const kind = (ALLOWED_KINDS as ReadonlyArray<string>).includes(kindRaw)
    ? (kindRaw as ClipKind)
    : 'TEXT';
  const time = typeof r.time === 'string' ? r.time : '';
  const text = typeof r.text === 'string' ? r.text : '';
  if (!text) return null;
  return { kind, time, text };
}

function seedEntries(): ReadonlyArray<ClipboardEntry> {
  return CLIPBOARD_ITEMS.map(item => {
    const k = (ALLOWED_KINDS as ReadonlyArray<string>).includes(item.kind)
      ? (item.kind as ClipKind)
      : 'TEXT';
    return { kind: k, time: item.time, text: item.text };
  });
}

function loadStringSet(key: string): Set<string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

function saveStringSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* quota / private mode */
  }
}

export function ClipboardPanel() {
  const [entries, setEntries] = useState<ReadonlyArray<ClipboardEntry>>(
    isTauri ? [] : seedEntries()
  );
  const [pins, setPins] = useState<Set<string>>(() => loadStringSet(PINS_KEY));
  const [hidden, setHidden] = useState<Set<string>>(() => loadStringSet(HIDDEN_KEY));

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      const initial = await invokeSafe<ReadonlyArray<unknown>>('get_clipboard_history');
      if (!cancelled && Array.isArray(initial)) {
        const normalized = initial
          .map(normalizeEntry)
          .filter((e): e is ClipboardEntry => e !== null);
        setEntries(normalized);
      }

      unlisten = await listen<unknown>('sunny://clipboard', payload => {
        const entry = normalizeEntry(payload);
        if (!entry) return;
        setEntries(prev => {
          const filtered = prev.filter(p => p.text !== entry.text);
          const next = [entry, ...filtered];
          return next.slice(0, MAX_HISTORY);
        });
      });
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const handleCopy = useCallback(async (entry: ClipboardEntry): Promise<void> => {
    if (entry.kind === 'IMG') return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(entry.text);
      toast.success('Copied');
    } catch (err) {
      console.error('clipboard write failed', err);
      toast.error('Copy failed');
    }
  }, []);

  const togglePin = useCallback((text: string) => {
    setPins(prev => {
      const next = new Set(prev);
      if (next.has(text)) next.delete(text); else next.add(text);
      saveStringSet(PINS_KEY, next);
      return next;
    });
  }, []);

  const dismiss = useCallback((text: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      next.add(text);
      saveStringSet(HIDDEN_KEY, next);
      return next;
    });
    setPins(prev => {
      if (!prev.has(text)) return prev;
      const next = new Set(prev);
      next.delete(text);
      saveStringSet(PINS_KEY, next);
      return next;
    });
  }, []);

  // Pinned entries first (in pin order), then live entries (excluding hidden + already-pinned).
  const visible = useMemo<ReadonlyArray<ClipboardEntry>>(() => {
    const pinFirst: ClipboardEntry[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (pins.has(e.text) && !hidden.has(e.text)) {
        pinFirst.push(e);
        seen.add(e.text);
      }
    }
    const rest: ClipboardEntry[] = [];
    for (const e of entries) {
      if (seen.has(e.text) || hidden.has(e.text)) continue;
      rest.push(e);
    }
    return [...pinFirst, ...rest];
  }, [entries, pins, hidden]);

  const badge = useMemo(() => {
    if (!isTauri) return '[DEMO]';
    const pinCount = [...pins].filter(p => !hidden.has(p)).length;
    return pinCount > 0 ? `${visible.length} · ${pinCount}📌` : `${visible.length} CAPTURES`;
  }, [pins, hidden, visible.length]);

  return (
    <Panel id="p-clip" title="CLIPBOARD" right={badge}>
      <div className="clip">
        {visible.length === 0 ? (
          <div
            style={{
              margin: 'auto',
              fontFamily: 'var(--display)',
              letterSpacing: '0.25em',
              color: 'var(--ink-dim)',
              fontSize: 11,
              textAlign: 'center',
              padding: '24px 0',
            }}
          >
            NOTHING CAPTURED
          </div>
        ) : (
          visible.map((c, i) => {
            const pinned = pins.has(c.text);
            return (
              <div
                key={`${c.time}-${i}-${c.text.slice(0, 16)}`}
                className={`c${pinned ? ' pinned' : ''}`}
                onClick={() => { void handleCopy(c); }}
                style={{ cursor: c.kind === 'IMG' ? 'default' : 'pointer' }}
              >
                <div className="h">
                  <span>{c.kind}{pinned && ' · 📌'}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span>{c.time}</span>
                    <button
                      type="button"
                      className="clip-btn"
                      onClick={e => { e.stopPropagation(); togglePin(c.text); }}
                      title={pinned ? 'Unpin' : 'Pin'}
                    >
                      {pinned ? '◆' : '◇'}
                    </button>
                    <button
                      type="button"
                      className="clip-btn"
                      onClick={e => { e.stopPropagation(); dismiss(c.text); }}
                      title="Dismiss"
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div className="t">{c.text}</div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
