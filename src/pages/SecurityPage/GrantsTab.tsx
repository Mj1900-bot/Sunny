/**
 * GRANTS tab — sub-agent capability grant policy + denial audit.
 *
 * Two panes:
 *   1. GRANT POLICY — read-only view of `~/.sunny/grants.json`. The file
 *      is still hand-edited today; the mtime-driven cache in
 *      `capability::load_cached` picks up edits without a restart, so
 *      showing the current state here closes the visibility loop.
 *   2. CAPABILITY DENIALS — tails `~/.sunny/capability_denials.log` so
 *      refusals surface without opening the file by hand.
 */

import { useEffect, useState } from 'react';
import {
  emptyStateStyle,
  hintStyle,
  mutedBtnStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import { fetchCapabilityDenials, fetchCapabilityGrants } from './api';
import { invokeSafe } from '../../lib/tauri';
import type { CapabilityDenialRow } from '../../bindings/CapabilityDenialRow';
import type { GrantsFile } from '../../bindings/GrantsFile';

const POLL_MS = 30_000;
const ROW_LIMIT = 200;

const denialFilterInputId = 'grants-denial-filter';

export function GrantsTab() {
  const [grants, setGrants] = useState<GrantsFile | null>(null);
  const [rows, setRows] = useState<ReadonlyArray<CapabilityDenialRow>>([]);
  const [loading, setLoading] = useState(true);
  const [denialFilter, setDenialFilter] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [policy, denials] = await Promise.all([
        fetchCapabilityGrants(),
        fetchCapabilityDenials(ROW_LIMIT),
      ]);
      if (alive) {
        setGrants(policy);
        setRows(denials);
        setLoading(false);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // Most-recent first for reading ergonomics; backend returns
  // chronological (oldest-first).
  const orderedRows = [...rows].reverse();

  const needle = denialFilter.trim().toLowerCase();
  const filteredRows = needle.length === 0
    ? orderedRows
    : orderedRows.filter(r => r.initiator.toLowerCase().includes(needle));

  return (
    <>
      <section style={sectionStyle}>
        <div style={{ ...sectionTitleStyle, flexWrap: 'wrap', rowGap: 6 }}>
          <span>GRANT POLICY</span>
          <button
            style={{ ...mutedBtnStyle, marginLeft: 'auto', cursor: 'pointer' }}
            title="Open ~/.sunny/grants.json in your default editor"
            onClick={() => void invokeSafe('open_sunny_file', { filename: 'grants.json' })}
          >
            EDIT FILE
          </button>
          <span style={hintStyle}>
            {loading ? 'loading…' : 'source: ~/.sunny/grants.json · reload on mtime'}
          </span>
        </div>

        {!loading && grants ? (
          <GrantsView grants={grants} />
        ) : (
          !loading && (
            <div style={emptyStateStyle}>
              Grants file unreachable (outside Tauri, or read error). Sub-agent
              defaults still apply via compiled-in fallbacks.
            </div>
          )
        )}

        <div style={{ ...hintStyle, marginTop: 8 }}>
          Edit <code>~/.sunny/grants.json</code> directly to scope sub-agents,
          scheduler runs, or ambient daemons. The dispatcher picks up edits on
          the next tool call (mtime-driven cache invalidation). <code>agent:main</code>{' '}
          is always full-access unless you add an explicit entry.
        </div>
      </section>

      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>CAPABILITY DENIALS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {loading
              ? 'loading…'
              : `${rows.length} row${rows.length === 1 ? '' : 's'} · polled every ${POLL_MS / 1000}s`}
          </span>
        </div>

        {!loading && orderedRows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <label htmlFor={denialFilterInputId} style={filterLabelStyle}>
              FILTER INITIATOR
            </label>
            <input
              id={denialFilterInputId}
              type="text"
              value={denialFilter}
              onChange={e => setDenialFilter(e.target.value)}
              placeholder="e.g. agent:sub"
              style={filterInputStyle}
            />
            {needle.length > 0 && (
              <span style={{ ...hintStyle, flexShrink: 0 }}>
                {filteredRows.length} / {orderedRows.length}
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ ...emptyStateStyle, border: 'none', padding: '20px 0' }}>
            loading denials…
          </div>
        ) : orderedRows.length === 0 ? (
          <div style={emptyStateStyle}>
            No capability denials recorded. When a sub-agent is blocked, the
            refusal appends to <code>~/.sunny/capability_denials.log</code> and
            appears here automatically.
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={emptyStateStyle}>
            No denials match initiator "{denialFilter.trim()}".
          </div>
        ) : (
          <div
            role="log"
            aria-live="polite"
            aria-atomic="false"
            style={{ display: 'grid', gap: 3, maxHeight: 520, overflowY: 'auto' }}
          >
            {filteredRows.map((row, i) => (
              <DenialRow key={`${row.at}-${i}`} row={row} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function GrantsView({ grants }: { grants: GrantsFile }) {
  const initiatorEntries = Object.entries(grants.initiators)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    .sort(([a], [b]) => {
      // agent:main is the primary initiator — always show it first.
      if (a === 'agent:main') return -1;
      if (b === 'agent:main') return 1;
      return a.localeCompare(b);
    });

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {initiatorEntries.length === 0 ? (
        <div style={{ ...hintStyle, fontStyle: 'italic' }}>
          No explicit initiator entries — every sub-agent uses the default list
          below.
        </div>
      ) : (
        initiatorEntries.map(([initiator, caps]) => (
          <GrantRow
            key={initiator}
            label={initiator}
            caps={caps}
            labelColor="var(--cyan)"
          />
        ))
      )}
      <GrantRow
        label="default (sub-agents, daemons, scheduler)"
        caps={grants.default_for_sub_agents}
        labelColor="var(--amber)"
      />
    </div>
  );
}

function GrantRow({
  label,
  caps,
  labelColor,
}: {
  label: string;
  caps: ReadonlyArray<string>;
  labelColor: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
        gap: 10,
        alignItems: 'baseline',
        padding: '5px 10px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.45)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <span style={{ color: labelColor }}>{label}</span>
      <span style={{ color: 'var(--ink)' }}>
        {caps.length === 0 ? (
          <em style={{ color: 'var(--ink-dim)' }}>(no caps — fully denied)</em>
        ) : (
          caps.join(', ')
        )}
      </span>
    </div>
  );
}

function DenialRow({ row }: { row: CapabilityDenialRow }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 200px 160px 1fr',
        gap: 10,
        alignItems: 'baseline',
        padding: '5px 10px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.45)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <span style={{ color: 'var(--ink-dim)' }} title={row.at}>
        {formatTime(row.at)}
      </span>
      <span style={{ color: 'var(--amber)' }}>{row.initiator}</span>
      <span style={{ color: 'var(--ink)' }}>{row.tool}</span>
      <span style={{ color: 'var(--ink-dim)' }}>
        missing: {row.missing.length > 0 ? row.missing.join(', ') : '(none)'}
        {row.reason ? ` · ${row.reason}` : ''}
      </span>
    </div>
  );
}

/** Shorten an RFC3339 timestamp to `MM-DD HH:MM` — keeps date context across
 *  midnight while staying compact. Full RFC3339 value remains in `title`
 *  for hover. */
function formatTime(iso: string): string {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}):\d{2}/);
  return m ? `${m[2]}-${m[3]} ${m[4]}` : iso;
}

// ─────────────────────────────────────────────────────────────────
// Denial filter styles — scoped here, not in styles.ts (single use)
// ─────────────────────────────────────────────────────────────────

import type { CSSProperties } from 'react';

const filterLabelStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
  flexShrink: 0,
};

const filterInputStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  background: 'rgba(4, 10, 16, 0.6)',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink)',
  padding: '3px 8px',
  outline: 'none',
  width: 200,
  letterSpacing: '0.04em',
};
