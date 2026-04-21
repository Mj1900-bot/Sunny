import { useState, useMemo } from 'react';
import type { SignatureCatalog, SignatureCategory, SignatureEntry } from '../../types';
import { CATEGORY_META, VERDICT_META } from '../../types';
import { ThreatSearchHint } from '../../ThreatSearchHint';
import {
  DISPLAY_FONT,
  chipBaseStyle,
  emptyStateStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  mutedBtnStyle,
  sectionStyle,
  sectionTitleStyle,
} from '../../styles';

const CATEGORY_ORDER: ReadonlyArray<SignatureCategory> = [
  'malware_family',
  'malicious_script',
  'prompt_injection',
  'agent_exfil',
];

type DbSort = 'severity' | 'year' | 'name' | 'platform';

const DB_SORTS: ReadonlyArray<{ id: DbSort; label: string }> = [
  { id: 'severity', label: 'SEVERITY' },
  { id: 'year', label: 'YEAR' },
  { id: 'name', label: 'NAME' },
  { id: 'platform', label: 'PLATFORM' },
];

const VERDICT_RANK: Record<string, number> = {
  malicious: 0,
  suspicious: 1,
  info: 2,
  unknown: 3,
  clean: 4,
};

export function ThreatDatabasePanel({ catalog }: { catalog: SignatureCatalog }) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [filter, setFilter] = useState<SignatureCategory | 'all'>('all');
  const [platformFilter, setPlatformFilter] = useState<string | 'all'>('all');
  const [sort, setSort] = useState<DbSort>('severity');
  const [query, setQuery] = useState('');
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const countsByCategory = useMemo<Record<SignatureCategory, number>>(() => {
    const out: Record<SignatureCategory, number> = {
      malware_family: 0, malicious_script: 0, prompt_injection: 0, agent_exfil: 0,
    };
    for (const row of catalog.byCategory) out[row.category] = row.count;
    return out;
  }, [catalog]);

  const allPlatforms = useMemo<ReadonlyArray<string>>(() => {
    const set = new Set<string>();
    for (const e of catalog.entries) for (const p of e.platforms) set.add(p);
    return Array.from(set).sort();
  }, [catalog]);

  const entries = useMemo<ReadonlyArray<SignatureEntry>>(() => {
    // Support field-qualified queries: `year:2026`, `cat:agent_exfil`,
    // `platform:MCP`, `cve:2025-54135`. Unprefixed terms are AND-matched
    // against name / description / id / platforms.
    const raw = query.trim();
    const tokens = raw.length === 0 ? [] : raw.toLowerCase().split(/\s+/);
    const filtered = catalog.entries.filter(e => {
      if (filter !== 'all' && e.category !== filter) return false;
      if (platformFilter !== 'all' && !e.platforms.includes(platformFilter)) return false;
      if (tokens.length === 0) return true;
      for (const tok of tokens) {
        const [k, v] = tok.includes(':') ? tok.split(':', 2) as [string, string] : ['', tok];
        if (k === 'year') {
          if (String(e.yearSeen) !== v) return false;
          continue;
        }
        if (k === 'cat' || k === 'category') {
          if (e.category !== v) return false;
          continue;
        }
        if (k === 'platform' || k === 'plat') {
          if (!e.platforms.some(p => p.toLowerCase() === v)) return false;
          continue;
        }
        if (k === 'cve') {
          const needle = v.startsWith('cve-') ? v : `cve-${v}`;
          if (!e.description.toLowerCase().includes(needle) && !e.name.toLowerCase().includes(needle)) return false;
          continue;
        }
        // Unprefixed — fuzzy contains across common fields.
        const hay =
          e.name.toLowerCase() +
          ' ' +
          e.description.toLowerCase() +
          ' ' +
          e.id.toLowerCase() +
          ' ' +
          e.platforms.join(' ').toLowerCase();
        if (!hay.includes(tok)) return false;
      }
      return true;
    });
    const sorted = [...filtered];
    switch (sort) {
      case 'severity':
        sorted.sort(
          (a, b) =>
            (VERDICT_RANK[a.weight] ?? 9) - (VERDICT_RANK[b.weight] ?? 9) ||
            b.yearSeen - a.yearSeen,
        );
        break;
      case 'year':
        sorted.sort((a, b) => b.yearSeen - a.yearSeen || a.name.localeCompare(b.name));
        break;
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'platform':
        sorted.sort(
          (a, b) =>
            a.platforms.join(',').localeCompare(b.platforms.join(',')) ||
            a.name.localeCompare(b.name),
        );
        break;
    }
    return sorted;
  }, [catalog, filter, platformFilter, query, sort]);

  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>THREAT DATABASE</span>
        <span
          style={{
            ...hintStyle,
            color: 'var(--cyan)',
            border: '1px solid var(--line-soft)',
            padding: '1px 8px',
            fontSize: 9.5,
            letterSpacing: '0.22em',
          }}
        >
          v{catalog.version} · {catalog.updated}
        </span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          <strong style={{ color: 'var(--cyan)' }}>{catalog.total}</strong> patterns ·{' '}
          <strong style={{ color: 'var(--cyan)' }}>{catalog.offlineHashPrefixes}</strong>{' '}
          offline hash prefixes · IoC checks run alongside MalwareBazaar +
          VirusTotal hash lookups
        </span>
      </div>

      {/* Category summary cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 8,
          marginBottom: 10,
        }}
      >
        {CATEGORY_ORDER.map(cat => {
          const meta = CATEGORY_META[cat];
          const count = countsByCategory[cat] ?? 0;
          return (
            <button
              key={cat}
              onClick={() => {
                setFilter(prev => (prev === cat ? 'all' : cat));
                setExpanded(true);
              }}
              style={{
                all: 'unset',
                cursor: 'pointer',
                border: `1px solid ${filter === cat ? meta.color : 'var(--line-soft)'}`,
                background:
                  filter === cat ? 'rgba(57, 229, 255, 0.06)' : 'rgba(4, 10, 16, 0.55)',
                padding: '8px 10px',
                display: 'grid',
                gap: 3,
              }}
              title={meta.blurb}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'space-between',
                }}
              >
                <span
                  style={{
                    fontFamily: DISPLAY_FONT,
                    fontSize: 10,
                    letterSpacing: '0.22em',
                    color: meta.color,
                    fontWeight: 700,
                  }}
                >
                  {meta.label}
                </span>
                <span
                  style={{
                    fontFamily: DISPLAY_FONT,
                    fontSize: 16,
                    color: meta.color,
                    fontWeight: 700,
                  }}
                >
                  {count}
                </span>
              </div>
              <div
                style={{
                  ...hintStyle,
                  fontSize: 10,
                  color: 'var(--ink-2)',
                  lineHeight: 1.45,
                }}
              >
                {meta.blurb}
              </div>
            </button>
          );
        })}
      </div>

      {/* Expand toggle + search */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ ...mutedBtnStyle, borderColor: expanded ? 'var(--cyan)' : 'var(--line-soft)', color: expanded ? 'var(--cyan)' : 'var(--ink-dim)' }}
        >
          {expanded ? '▾ HIDE DATABASE' : '▸ VIEW FULL DATABASE'}
        </button>
        {expanded && (
          <>
            <input
              type="text"
              placeholder="Filter — try 'year:2026', 'cat:agent_exfil', 'platform:MCP', 'cve:2025-54135', 'cursor', 'amos'…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 200, fontSize: 11 }}
            />
            <ThreatSearchHint onInsert={tok => setQuery(prev => (prev ? `${prev} ${tok}` : tok))} />
            <span style={{ ...hintStyle, fontSize: 10 }}>
              {entries.length} / {catalog.total} shown
            </span>
          </>
        )}
      </div>

      {/* Quick-filter shortcut chips — land common 2026 slices in one click. */}
      {expanded && (
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span style={{ ...hintStyle, fontSize: 10 }}>QUICK</span>
          {[
            { q: 'year:2026', label: '2026' },
            { q: 'year:2025', label: '2025' },
            { q: 'cat:agent_exfil', label: 'AGENT EXFIL' },
            { q: 'cat:prompt_injection', label: 'JAILBREAKS' },
            { q: 'platform:MCP', label: 'MCP' },
            { q: 'cve', label: 'CVE-LINKED' },
            { q: 'clickfix', label: 'CLICKFIX' },
            { q: 'stealer', label: 'STEALERS' },
          ].map(p => (
            <button
              key={p.q}
              onClick={() => setQuery(p.q)}
              style={{
                ...chipBaseStyle,
                fontSize: 9.5,
                padding: '3px 8px',
                color: query === p.q ? 'var(--cyan)' : 'var(--ink-dim)',
                borderColor: query === p.q ? 'var(--cyan)' : 'var(--line-soft)',
                background:
                  query === p.q ? 'rgba(57, 229, 255, 0.10)' : 'rgba(6, 14, 22, 0.4)',
              }}
            >
              {p.label}
            </button>
          ))}
          {query.length > 0 && (
            <button
              onClick={() => setQuery('')}
              style={{
                ...chipBaseStyle,
                fontSize: 9.5,
                padding: '3px 8px',
                color: 'var(--amber)',
                borderColor: 'rgba(255, 179, 71, 0.55)',
              }}
            >
              ✕ CLEAR
            </button>
          )}
        </div>
      )}

      {expanded && (
        <>
          {/* Sort + platform filter row */}
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <span style={{ ...labelStyle, marginBottom: 0 }}>SORT</span>
            {DB_SORTS.map(s => (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                style={{
                  ...chipBaseStyle,
                  color: sort === s.id ? 'var(--cyan)' : 'var(--ink-dim)',
                  borderColor: sort === s.id ? 'var(--cyan)' : 'var(--line-soft)',
                  background:
                    sort === s.id ? 'rgba(57, 229, 255, 0.10)' : 'rgba(6, 14, 22, 0.4)',
                  fontSize: 10,
                  padding: '4px 10px',
                }}
              >
                {s.label}
              </button>
            ))}
            <span
              style={{
                ...labelStyle,
                marginBottom: 0,
                marginLeft: 8,
                borderLeft: '1px solid var(--line-soft)',
                paddingLeft: 10,
              }}
            >
              PLATFORM
            </span>
            <button
              onClick={() => setPlatformFilter('all')}
              style={{
                ...chipBaseStyle,
                color: platformFilter === 'all' ? 'var(--cyan)' : 'var(--ink-dim)',
                borderColor: platformFilter === 'all' ? 'var(--cyan)' : 'var(--line-soft)',
                fontSize: 10,
                padding: '4px 10px',
              }}
            >
              ALL
            </button>
            {allPlatforms.map(p => (
              <button
                key={p}
                onClick={() => setPlatformFilter(prev => (prev === p ? 'all' : p))}
                style={{
                  ...chipBaseStyle,
                  color: platformFilter === p ? 'var(--cyan)' : 'var(--ink-dim)',
                  borderColor: platformFilter === p ? 'var(--cyan)' : 'var(--line-soft)',
                  background:
                    platformFilter === p ? 'rgba(57, 229, 255, 0.10)' : 'rgba(6, 14, 22, 0.4)',
                  fontSize: 10,
                  padding: '4px 10px',
                }}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Entry list */}
          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            {entries.map(entry => (
              <ThreatEntryRow
                key={entry.id}
                entry={entry}
                open={openEntry === entry.id}
                copied={copiedId === entry.id}
                onToggle={() => setOpenEntry(p => (p === entry.id ? null : entry.id))}
                onCopyId={() => {
                  void navigator.clipboard?.writeText(entry.id);
                  setCopiedId(entry.id);
                  window.setTimeout(
                    () => setCopiedId(prev => (prev === entry.id ? null : prev)),
                    1200,
                  );
                }}
              />
            ))}
            {entries.length === 0 && (
              <div style={emptyStateStyle}>NO ENTRIES MATCH THIS FILTER</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ThreatEntryRow({
  entry,
  open,
  copied,
  onToggle,
  onCopyId,
}: {
  entry: SignatureEntry;
  open: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopyId: () => void;
}) {
  const catMeta = CATEGORY_META[entry.category];
  const verdictMeta = VERDICT_META[entry.weight];
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.55)',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: 'auto 120px 1fr auto auto',
          gap: 10,
          alignItems: 'center',
          padding: '8px 10px',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.18em',
            color: catMeta.color,
            border: `1px solid ${catMeta.color}55`,
            background: `${catMeta.color}11`,
            padding: '1px 6px',
          }}
        >
          {catMeta.label}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.18em',
            color: 'var(--ink-dim)',
          }}
        >
          {entry.yearSeen}+ · {entry.platforms.join('/')}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            color: 'var(--ink)',
            fontWeight: 600,
          }}
        >
          {entry.name}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.18em',
            color: verdictMeta.color,
            border: `1px solid ${verdictMeta.border}`,
            background: verdictMeta.bg,
            padding: '1px 6px',
          }}
        >
          {verdictMeta.label}
        </span>
        <span
          style={{
            ...hintStyle,
            fontSize: 10,
            color: 'var(--ink-dim)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        >
          ▸
        </span>
      </button>

      {open && (
        <div
          style={{
            borderTop: '1px dashed var(--line-soft)',
            padding: '10px 12px 12px 12px',
            display: 'grid',
            gap: 8,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-2)',
              lineHeight: 1.55,
            }}
          >
            {entry.description}
          </div>
          {entry.references.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div
                style={{
                  fontFamily: DISPLAY_FONT,
                  fontSize: 9.5,
                  letterSpacing: '0.22em',
                  color: 'var(--ink-dim)',
                }}
              >
                REFERENCES
              </div>
              {entry.references.map(url => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10.5,
                    color: 'var(--cyan)',
                    wordBreak: 'break-all',
                    textDecoration: 'none',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                >
                  ↗ {url}
                </a>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                letterSpacing: '0.18em',
                color: 'var(--ink-dim)',
              }}
            >
              ID · {entry.id}
            </span>
            <button
              onClick={e => {
                e.stopPropagation();
                onCopyId();
              }}
              style={{
                ...chipBaseStyle,
                padding: '2px 8px',
                fontSize: 9,
                letterSpacing: '0.18em',
                color: copied ? 'rgb(120, 255, 170)' : 'var(--ink-dim)',
                borderColor: copied ? 'rgba(120, 255, 170, 0.6)' : 'var(--line-soft)',
              }}
            >
              {copied ? '✓ COPIED' : 'COPY ID'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
