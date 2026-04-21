/**
 * VaultSidebar — Layout component managing filter, sort, and session stat readouts.
 */

import type { CSSProperties } from 'react';
import { Section } from '../_shared';
import { FILTER_ORDER, KIND_COLORS, KIND_LABELS } from './constants';
import type { KindFilter, SortKey } from './types';
import { formatMMSS } from './utils';

export function VaultSidebar({
  filter,
  setFilter,
  counts,
  sort,
  setSort,
  itemsLength,
  activeReveals,
  sessionReveals,
  visibleItemsLength,
  pinsSize,
  idleSecondsLeft,
  blurSeal,
  setBlurSeal,
  onSeal,
}: {
  filter: KindFilter;
  setFilter: (v: KindFilter) => void;
  counts: Readonly<Record<KindFilter, number>>;
  sort: SortKey;
  setSort: (v: SortKey) => void;
  itemsLength: number;
  activeReveals: number;
  sessionReveals: number;
  visibleItemsLength: number;
  pinsSize: number;
  idleSecondsLeft: number;
  blurSeal: boolean;
  setBlurSeal: (v: boolean) => void;
  onSeal: () => void;
}) {
  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* FILTER */}
      <Section title="FILTER">
        <div style={{ padding: '8px 12px' }}>
          {FILTER_ORDER.map(key => (
            <button
              key={key}
              type="button"
              style={filterChip(key, filter)}
              onClick={() => setFilter(key)}
            >
              <span>{key === 'all' ? 'ALL' : KIND_LABELS[key]}</span>
              <span style={{ opacity: 0.7 }}>{counts[key]}</span>
            </button>
          ))}
        </div>
      </Section>

      {/* SORT */}
      <Section title="SORT">
        <div style={{ padding: '8px 12px' }}>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            style={{
              width: '100%',
              all: 'unset',
              boxSizing: 'border-box',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink)',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid var(--line-soft)',
              padding: '6px 10px',
              cursor: 'pointer',
            }}
          >
            <option value="recent">Recently touched</option>
            <option value="used">Recently used</option>
            <option value="alpha">A → Z</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </Section>

      {/* SESSION */}
      <Section title="SESSION">
        <div style={{ padding: '8px 12px' }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <StatRow label="TOTAL" value={String(itemsLength)} tone="var(--cyan)" />
            <StatRow
              label="REVEALED"
              value={String(activeReveals)}
              tone={activeReveals > 0 ? 'var(--amber)' : 'var(--ink-dim)'}
            />
            <StatRow
              label="SESSION"
              value={`${sessionReveals}/5`}
              tone={sessionReveals >= 4 ? 'var(--red)' : sessionReveals >= 3 ? 'var(--amber)' : 'var(--ink-2)'}
            />
            <StatRow label="VISIBLE" value={String(visibleItemsLength)} tone="var(--ink)" />
            <StatRow label="PINNED" value={String(pinsSize)} tone="var(--amber)" />
            <StatRow
              label="AUTO-SEAL"
              value={formatMMSS(idleSecondsLeft)}
              tone={idleSecondsLeft < 30 ? 'var(--red)' : 'var(--ink-2)'}
            />
          </div>
         </div>
      </Section>

      {/* HARDENING */}
      <Section title="HARDENING">
        <div style={{ padding: '8px 12px' }}>
          <label style={{
            display: 'flex', gap: 8, alignItems: 'center',
            fontFamily: 'var(--mono)', fontSize: 10,
            color: blurSeal ? 'var(--cyan)' : 'var(--ink-dim)',
            letterSpacing: '0.1em', cursor: 'pointer', padding: '4px 0',
          }}>
            <input
              type="checkbox"
              checked={blurSeal}
              onChange={e => setBlurSeal(e.target.checked)}
            />
            <span>SEAL ON WINDOW BLUR</span>
          </label>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
            letterSpacing: '0.08em', lineHeight: 1.55, marginTop: 4,
          }}>
            When enabled, Cmd-Tab or minimising SUNNY immediately re-seals the vault.
          </div>
        </div>
      </Section>

      {/* KEYBINDS & SEAL ACTION */}
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
        letterSpacing: '0.08em', padding: '6px 8px',
        border: '1px dashed var(--line-soft)',
      }}>
        <b style={{ color: 'var(--cyan)' }}>/</b> search · <b style={{ color: 'var(--cyan)' }}>n</b>{' '}
        new · <b style={{ color: 'var(--cyan)' }}>?</b> help ·{' '}
        <b style={{ color: 'var(--red)' }}>⌘L</b> panic seal
      </div>

      <button
        type="button"
        style={{
          width: '100%', padding: '10px',
          fontFamily: 'var(--display)', fontSize: 11, letterSpacing: '0.18em',
          fontWeight: 700, color: 'var(--bg)', background: 'var(--cyan)',
          border: 'none', cursor: 'pointer',
        }}
        onClick={onSeal}
        title="Cmd/Ctrl+L for panic seal"
      >
        SEAL VAULT
      </button>
    </aside>
  );
}

function filterChip(key: KindFilter, current: KindFilter): CSSProperties {
  const active = current === key;
  const accent = key === 'all' ? 'var(--cyan)' : KIND_COLORS[key as Exclude<KindFilter, 'all'>];
  return {
    all: 'unset',
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '7px 10px',
    border: `1px solid ${active ? accent : 'var(--line-soft)'}`,
    background: active ? 'rgba(57, 229, 255, 0.08)' : 'rgba(6, 14, 22, 0.45)',
    color: active ? accent : 'var(--ink-2)',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    letterSpacing: '0.18em',
    marginBottom: 6,
    transition: 'all 150ms ease',
  };
}

function StatRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{label}</span>
      <b style={{ color: tone }}>{value}</b>
    </div>
  );
}
