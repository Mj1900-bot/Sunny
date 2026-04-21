/**
 * CrossTabSearch — fires parallel searches across episodic, semantic, and
 * procedural stores and surfaces the top 3 results from each with a
 * "see all" affordance that switches the active tab.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { SEARCH_LIMIT } from './constants';
import {
  badgeStyle,
  emptyStyle,
  metaTextStyle,
  rowHeaderStyle,
  rowStyle,
  searchInputStyle,
} from './styles';
import type { EpisodicItem, ProceduralSkill, SemanticFact, Tab } from './types';
import { formatRelative, useDebouncedQuery } from './utils';

const TOP_N = 3;

type CrossResults = {
  episodic: ReadonlyArray<EpisodicItem>;
  semantic: ReadonlyArray<SemanticFact>;
  procedural: ReadonlyArray<ProceduralSkill>;
};

type Props = {
  onSeeAll: (tab: Tab) => void;
};

export function CrossTabSearch({ onSeeAll }: Props): JSX.Element {
  const [raw, setRaw] = useState('');
  const query = useDebouncedQuery(raw);
  const [results, setResults] = useState<CrossResults | null>(null);
  const [searching, setSearching] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!query.trim() || !isTauri) {
      setResults(null);
      return;
    }
    const token = ++reqRef.current;
    setSearching(true);
    void (async () => {
      try {
        const [episodic, semantic] = await Promise.all([
          invokeSafe<ReadonlyArray<EpisodicItem>>('memory_episodic_search', {
            query: query.trim(),
            limit: SEARCH_LIMIT,
          }),
          invokeSafe<ReadonlyArray<SemanticFact>>('memory_fact_search', {
            query: query.trim(),
            limit: SEARCH_LIMIT,
          }),
        ]);
        // Procedural has no search command — client-side filter from list
        const allSkills = await invokeSafe<ReadonlyArray<ProceduralSkill>>('memory_skill_list');
        if (token !== reqRef.current) return;
        const q = query.trim().toLowerCase();
        const procedural = (allSkills ?? []).filter(
          s =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.trigger_text.toLowerCase().includes(q),
        );
        setResults({
          episodic: (episodic ?? []).slice(0, TOP_N),
          semantic: (semantic ?? []).slice(0, TOP_N),
          procedural: procedural.slice(0, TOP_N),
        });
      } catch {
        if (token !== reqRef.current) return;
        setResults(null);
      } finally {
        if (token === reqRef.current) setSearching(false);
      }
    })();
  }, [query]);

  const total = results
    ? results.episodic.length + results.semantic.length + results.procedural.length
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          style={{ ...searchInputStyle, flex: 1 }}
          placeholder="Search all memory… (episodic + semantic + procedural)"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          aria-label="Cross-tab memory search"
        />
        {searching && (
          <span style={{ ...metaTextStyle, flexShrink: 0 }}>SEARCHING…</span>
        )}
        {!searching && query.trim() && results && (
          <span style={{ ...metaTextStyle, flexShrink: 0 }}>{total} hits</span>
        )}
        {raw && (
          <button
            type="button"
            style={{ all: 'unset', cursor: 'pointer', ...metaTextStyle, padding: '4px 8px', border: '1px solid var(--line-soft)' }}
            onClick={() => setRaw('')}
            aria-label="Clear search"
          >× CLEAR</button>
        )}
      </div>

      {results && query.trim() && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-live="polite" aria-atomic="false">
          {(['episodic', 'semantic', 'procedural'] as const).map(store => {
            const storeResults = results[store];
            if (storeResults.length === 0) return null;
            return (
              <div key={store} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.2em', color: 'var(--cyan)',
                  borderBottom: '1px solid var(--line-soft)', paddingBottom: 4,
                }}>
                  <span>{store.toUpperCase()}</span>
                  <button
                    type="button"
                    onClick={() => onSeeAll(store as Tab)}
                    style={{ all: 'unset', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--cyan)', letterSpacing: '0.12em' }}
                  >
                    SEE ALL IN {store.toUpperCase()} →
                  </button>
                </div>
                {storeResults.map(item => (
                  <CrossResultRow key={(item as { id: string }).id} store={store} item={item} />
                ))}
              </div>
            );
          })}
          {total === 0 && (
            <div style={emptyStyle}>NO RESULTS FOR "{query.trim()}"</div>
          )}
        </div>
      )}
    </div>
  );
}

function CrossResultRow({
  store,
  item,
}: {
  store: 'episodic' | 'semantic' | 'procedural';
  item: EpisodicItem | SemanticFact | ProceduralSkill;
}): JSX.Element {
  const now = Math.floor(Date.now() / 1000);

  if (store === 'episodic') {
    const ep = item as EpisodicItem;
    return (
      <div style={{ ...rowStyle, padding: '6px 10px' }}>
        <div style={rowHeaderStyle}>
          <span style={badgeStyle('var(--cyan)')}>{ep.kind.toUpperCase().replace('_', ' ')}</span>
          <span style={metaTextStyle}>{formatRelative(ep.created_at, now)}</span>
        </div>
        <div style={{ fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {ep.text}
        </div>
      </div>
    );
  }

  if (store === 'semantic') {
    const sf = item as SemanticFact;
    return (
      <div style={{ ...rowStyle, padding: '6px 10px' }}>
        <div style={rowHeaderStyle}>
          <span style={badgeStyle('var(--amber)')}>{(sf.subject || 'FACT').toUpperCase()}</span>
          <span style={metaTextStyle}>conf {sf.confidence.toFixed(2)}</span>
          <span style={metaTextStyle}>{formatRelative(sf.updated_at, now)}</span>
        </div>
        <div style={{ fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {sf.text}
        </div>
      </div>
    );
  }

  const skill = item as ProceduralSkill;
  return (
    <div style={{ ...rowStyle, padding: '6px 10px' }}>
      <div style={rowHeaderStyle}>
        <span style={badgeStyle('var(--green)')}>SKILL</span>
        <span style={{ fontFamily: 'var(--display)', fontSize: 10, color: 'var(--ink)', letterSpacing: '0.1em' }}>{skill.name}</span>
        <span style={metaTextStyle}>×{skill.uses_count}</span>
      </div>
      <div style={{ fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {skill.description || skill.trigger_text || '—'}
      </div>
    </div>
  );
}
