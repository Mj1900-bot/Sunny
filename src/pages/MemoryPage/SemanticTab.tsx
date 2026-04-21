import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { LIST_LIMIT, SEARCH_LIMIT } from './constants';
import { NewMemoryForm } from './NewMemoryForm';
import { RowMenu, type RowAction } from './RowMenu';
import {
  DISPLAY_FONT,
  badgeStyle,
  emptyStyle,
  errorStyle,
  listStyle,
  metaTextStyle,
  primaryButtonStyle,
  rowHeaderStyle,
  rowStyle,
  searchInputStyle,
  searchRowStyle,
} from './styles';
import { TauriRequired } from './TauriRequired';
import type { SemanticFact } from './types';
import { formatRelative, useCopyFlash, useDebouncedQuery } from './utils';

export function SemanticTab({ onChange }: { onChange: () => void }): JSX.Element {
  const [raw, setRaw] = useState('');
  const query = useDebouncedQuery(raw);
  const [rows, setRows] = useState<ReadonlyArray<SemanticFact>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const reqIdRef = useRef(0);
  const copyState = useCopyFlash();

  useEffect(() => {
    if (!isTauri) return;
    const req = reqIdRef.current + 1;
    reqIdRef.current = req;
    setErr(null);
    (async () => {
      try {
        const items = query.trim()
          ? await invokeSafe<ReadonlyArray<SemanticFact>>('memory_fact_search', {
              query: query.trim(),
              limit: SEARCH_LIMIT,
            })
          : await invokeSafe<ReadonlyArray<SemanticFact>>('memory_fact_list', {
              limit: LIST_LIMIT,
              offset: 0,
            });
        if (reqIdRef.current !== req) return;
        setRows(items ?? []);
      } catch (e) {
        if (reqIdRef.current !== req) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [query]);

  const del = useCallback(
    async (id: string) => {
      const ok = await invokeSafe<void>('memory_fact_delete', { id });
      if (ok !== null) {
        setRows(rs => rs.filter(r => r.id !== id));
        onChange();
      }
    },
    [onChange],
  );

  const handleCreated = useCallback(
    (fact: SemanticFact) => {
      setRows(rs => [fact, ...rs.filter(r => r.id !== fact.id)]);
      setFlashId(fact.id);
      window.setTimeout(() => setFlashId(curr => (curr === fact.id ? null : curr)), 2000);
      onChange();
    },
    [onChange],
  );

  const handleAction = useCallback(
    (id: string, action: RowAction, fact: SemanticFact) => {
      if (action === 'delete') { void del(id); }
      else if (action === 'copy') { copyState.copy(id, fact.text); }
      else if (action === 'pin') {
        setPinnedIds(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      }
    },
    [del, copyState],
  );

  const grouped = useMemo(() => {
    const bySubject = new Map<string, SemanticFact[]>();
    for (const f of rows) {
      const key = f.subject || '(no subject)';
      const bucket = bySubject.get(key);
      if (bucket) bucket.push(f);
      else bySubject.set(key, [f]);
    }
    return Array.from(bySubject.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [rows]);

  if (!isTauri) return <TauriRequired />;

  return (
    <>
      {err && <div style={errorStyle}>ERROR · {err}</div>}
      <div style={searchRowStyle}>
        <input
          style={searchInputStyle}
          aria-label="Search semantic facts"
          placeholder="Search semantic facts…"
          value={raw}
          onChange={e => setRaw(e.target.value)}
        />
        <button
          type="button"
          aria-expanded={adding}
          style={primaryButtonStyle}
          onClick={() => setAdding(v => !v)}
          title="Add a new fact by hand"
        >
          {adding ? '× CLOSE' : '+ NEW FACT'}
        </button>
      </div>
      {adding && (
        <NewMemoryForm
          kind="semantic"
          onClose={() => setAdding(false)}
          onCreated={handleCreated}
        />
      )}
      {rows.length === 0 ? (
        <div style={emptyStyle}>
          NO SEMANTIC FACTS · press + NEW FACT to add one, or the consolidator will extract facts from episodic runs
        </div>
      ) : (
        <div style={listStyle} aria-live="polite" aria-relevant="additions removals">
          {grouped.map(([subject, facts]) => (
            <div key={subject} style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontFamily: DISPLAY_FONT,
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  color: 'var(--cyan)',
                  padding: '4px 0 6px',
                }}
              >
                {subject.toUpperCase()} · {facts.length}
              </div>
              <div style={listStyle}>
                {facts.map(f => (
                  <SemanticRow
                    key={f.id}
                    fact={f}
                    flash={flashId === f.id}
                    copied={copyState.flashedId === f.id}
                    pinned={pinnedIds.has(f.id)}
                    onAction={action => handleAction(f.id, action, f)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SemanticRow({
  fact,
  flash,
  copied,
  pinned,
  onAction,
}: {
  fact: SemanticFact;
  flash: boolean;
  copied: boolean;
  pinned: boolean;
  onAction: (action: RowAction) => void;
}): JSX.Element {
  const confidenceColor =
    fact.confidence >= 0.9
      ? 'var(--green)'
      : fact.confidence >= 0.6
        ? 'var(--cyan)'
        : 'var(--amber)';
  return (
    <div
      className={flash ? 'mem-row mem-row-enter' : 'mem-row'}
      style={{
        ...rowStyle,
        borderColor: pinned
          ? 'var(--gold)'
          : copied
            ? 'var(--green)'
            : flash
              ? 'var(--cyan)'
              : rowStyle.borderColor,
        background: pinned ? 'rgba(255,209,102,0.05)' : rowStyle.background,
      }}
    >
      <div style={rowHeaderStyle}>
        <span
          style={badgeStyle(confidenceColor)}
          title={`confidence ${(fact.confidence * 100).toFixed(0)}%`}
        >
          C {(fact.confidence * 100).toFixed(0)}
        </span>
        <span style={{ ...metaTextStyle, color: 'var(--ink-dim)' }}>
          source={fact.source}
        </span>
        <span style={metaTextStyle}>
          updated {formatRelative(fact.updated_at, Math.floor(Date.now() / 1000))}
        </span>
        {fact.tags.length > 0 && (
          <span style={{ ...metaTextStyle, color: 'var(--cyan)' }}>
            {fact.tags.slice(0, 4).map(t => `#${t}`).join(' ')}
          </span>
        )}
        {copied && (
          <span style={{ ...metaTextStyle, color: 'var(--green)' }}>COPIED</span>
        )}
        {pinned && (
          <span style={{ ...metaTextStyle, color: 'var(--gold)' }}>PINNED</span>
        )}
        <span style={{ flex: 1 }} />
        <RowMenu onAction={onAction} isPinned={pinned} canEdit={false} />
      </div>
      <div
        style={{ whiteSpace: 'pre-wrap', cursor: 'copy' }}
        title="Click to copy"
        onClick={() => onAction('copy')}
      >
        {fact.text}
      </div>
    </div>
  );
}
