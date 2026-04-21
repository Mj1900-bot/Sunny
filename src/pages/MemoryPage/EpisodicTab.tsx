import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { KIND_BADGE, LIST_LIMIT, SEARCH_LIMIT } from './constants';
import { NewMemoryForm } from './NewMemoryForm';
import { RowMenu, type RowAction } from './RowMenu';
import {
  badgeStyle,
  buttonStyle,
  emptyStyle,
  errorStyle,
  listStyle,
  metaTextStyle,
  primaryButtonStyle,
  rowHeaderStyle,
  rowStyle,
  searchInputStyle,
  searchRowStyle,
  stripeStyle,
  tabStyle,
} from './styles';
import { TauriRequired } from './TauriRequired';
import type { EpisodicItem, EpisodicKind } from './types';
import {
  formatRelative,
  safeStringify,
  truncateToTwoLines,
  useCopyFlash,
  useDebouncedQuery,
} from './utils';

const EPISODIC_KIND_FILTERS: ReadonlyArray<{ id: 'all' | EpisodicKind; label: string }> = [
  { id: 'all', label: 'ALL' },
  { id: 'user', label: 'USER' },
  { id: 'agent_step', label: 'RUN' },
  { id: 'perception', label: 'PERCEPT' },
  { id: 'reflection', label: 'REFLECT' },
  { id: 'note', label: 'NOTE' },
];

export function EpisodicTab({ onChange }: { onChange: () => void }): JSX.Element {
  const [raw, setRaw] = useState('');
  const query = useDebouncedQuery(raw);
  const [kindFilter, setKindFilter] = useState<'all' | EpisodicKind>('all');
  const [rows, setRows] = useState<ReadonlyArray<EpisodicItem>>([]);
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
          ? await invokeSafe<ReadonlyArray<EpisodicItem>>('memory_episodic_search', {
              query: query.trim(),
              limit: SEARCH_LIMIT,
            })
          : await invokeSafe<ReadonlyArray<EpisodicItem>>('memory_episodic_list', {
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

  const filtered = useMemo(
    () => (kindFilter === 'all' ? rows : rows.filter(r => r.kind === kindFilter)),
    [rows, kindFilter],
  );

  const del = useCallback(
    async (id: string) => {
      const ok = await invokeSafe<void>('memory_delete', { id });
      if (ok !== null) {
        setRows(rs => rs.filter(r => r.id !== id));
        onChange();
      }
    },
    [onChange],
  );

  const handleCreated = useCallback(
    (item: EpisodicItem) => {
      setRows(rs => [item, ...rs.filter(r => r.id !== item.id)]);
      setFlashId(item.id);
      window.setTimeout(() => setFlashId(curr => (curr === item.id ? null : curr)), 2000);
      onChange();
    },
    [onChange],
  );

  const handleAction = useCallback(
    (id: string, action: RowAction, item: EpisodicItem) => {
      if (action === 'delete') { void del(id); }
      else if (action === 'copy') { copyState.copy(id, item.text); }
      else if (action === 'pin') {
        setPinnedIds(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      }
      // 'edit' not yet supported for episodic rows — falls through silently
    },
    [del, copyState],
  );

  if (!isTauri) return <TauriRequired />;

  return (
    <>
      {err && <div style={errorStyle}>ERROR · {err}</div>}
      <div style={searchRowStyle}>
        <input
          style={searchInputStyle}
          aria-label="Search episodic memory"
          placeholder="Search episodic memory… (FTS + embedding)"
          value={raw}
          onChange={e => setRaw(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {EPISODIC_KIND_FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              aria-pressed={kindFilter === f.id}
              style={tabStyle(kindFilter === f.id)}
              onClick={() => setKindFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={adding}
          style={primaryButtonStyle}
          onClick={() => setAdding(v => !v)}
          title="Add a new memory by hand"
        >
          {adding ? '× CLOSE' : '+ NEW'}
        </button>
      </div>
      {adding && (
        <NewMemoryForm
          kind="episodic"
          onClose={() => setAdding(false)}
          onCreated={handleCreated}
        />
      )}
      {filtered.length === 0 ? (
        <div style={emptyStyle}>
          {rows.length === 0
            ? 'NO EPISODIC ROWS · press + NEW to add one, or agent runs and perception snapshots will appear here'
            : `NO ${kindFilter.toUpperCase()} ROWS MATCH`}
        </div>
      ) : (
        <div style={listStyle} aria-live="polite" aria-relevant="additions removals">
          {filtered.map(r => (
            <EpisodicRow
              key={r.id}
              item={r}
              flash={flashId === r.id}
              copied={copyState.flashedId === r.id}
              pinned={pinnedIds.has(r.id)}
              onAction={action => handleAction(r.id, action, r)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function EpisodicRow({
  item,
  flash,
  copied,
  pinned,
  onAction,
}: {
  item: EpisodicItem;
  flash: boolean;
  copied: boolean;
  pinned: boolean;
  onAction: (action: RowAction) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const badge = KIND_BADGE[item.kind];
  return (
    <div
      className={flash ? 'mem-row mem-row-enter' : 'mem-row'}
      style={{
        ...rowStyle,
        paddingLeft: 14,
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
      <span style={stripeStyle(badge.color)} aria-hidden="true" />
      <div style={rowHeaderStyle}>
        <span style={badgeStyle(badge.color)}>{badge.label}</span>
        <span style={metaTextStyle}>{formatRelative(item.created_at, Math.floor(Date.now() / 1000))}</span>
        {item.tags.length > 0 && (
          <span style={{ ...metaTextStyle, color: 'var(--cyan)' }}>
            {item.tags.slice(0, 4).map(t => `#${t}`).join(' ')}
          </span>
        )}
        {copied && (
          <span style={{ ...metaTextStyle, color: 'var(--green)' }}>COPIED</span>
        )}
        {pinned && (
          <span style={{ ...metaTextStyle, color: 'var(--gold)' }}>PINNED</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" aria-expanded={expanded} style={buttonStyle} onClick={() => setExpanded(v => !v)}>
          {expanded ? 'COLLAPSE' : 'DETAILS'}
        </button>
        <RowMenu
          onAction={onAction}
          canEdit={false}
          isPinned={pinned}
        />
      </div>
      <div
        style={{ whiteSpace: 'pre-wrap', color: 'var(--ink)', cursor: 'copy' }}
        title="Click to copy"
        onClick={() => onAction('copy')}
      >
        {expanded ? item.text : truncateToTwoLines(item.text)}
      </div>
      {expanded && item.meta !== null && item.meta !== undefined && (
        <pre
          style={{
            margin: 0,
            padding: '6px 8px',
            fontSize: 10.5,
            background: 'rgba(6, 14, 22, 0.7)',
            color: 'var(--ink-dim)',
            border: '1px solid var(--line-soft)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {safeStringify(item.meta)}
        </pre>
      )}
    </div>
  );
}
