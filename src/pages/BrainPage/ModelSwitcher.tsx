/**
 * ModelSwitcher — Ollama model list with filter, size parsing,
 * active animation, and click-to-switch.
 *
 * Upgraded with:
 *  - Model name parsing (family, size tag, quantisation)
 *  - Active model pulsing indicator
 *  - Model count stats
 *  - Better visual hierarchy
 */

import { useMemo, useState } from 'react';
import {
  Section, EmptyState, Chip, ScrollList,
  Toolbar, FilterInput, useDebounced,
} from '../_shared';

/** Parse model name like "qwen3:30b-a3b-q4_K_M" into parts. */
function parseModelName(name: string): { family: string; tag: string } {
  const idx = name.indexOf(':');
  if (idx < 0) return { family: name, tag: '' };
  return { family: name.slice(0, idx), tag: name.slice(idx + 1) };
}

/** Guess a category from the model family name. */
function modelCategory(family: string): { label: string; tone: 'cyan' | 'violet' | 'green' | 'amber' | 'gold' } {
  const f = family.toLowerCase();
  if (f.includes('qwen'))    return { label: 'QWEN',    tone: 'cyan'   };
  if (f.includes('llama'))   return { label: 'LLAMA',   tone: 'violet' };
  if (f.includes('mistral')) return { label: 'MISTRAL', tone: 'amber'  };
  if (f.includes('gemma'))   return { label: 'GEMMA',   tone: 'green'  };
  if (f.includes('phi'))     return { label: 'PHI',     tone: 'gold'   };
  if (f.includes('nomic') || f.includes('embed')) return { label: 'EMBED', tone: 'green' };
  return { label: 'MODEL', tone: 'cyan' };
}

export function ModelSwitcher({
  ollamaModels,
  ollamaLoading,
  activeModel,
  onSwitch,
}: {
  ollamaModels: ReadonlyArray<string> | null;
  ollamaLoading: boolean;
  activeModel: string;
  onSwitch: (model: string) => void;
}) {
  const [modelQuery, setModelQuery] = useState('');
  const mq = useDebounced(modelQuery, 200);

  const filteredModels = useMemo(() => {
    const q = mq.trim().toLowerCase();
    const all = ollamaModels ?? [];
    if (!q) return all;
    return all.filter(m => m.toLowerCase().includes(q));
  }, [ollamaModels, mq]);

  // Count unique families
  const familyCount = useMemo(() => {
    const families = new Set((ollamaModels ?? []).map(m => parseModelName(m).family.toLowerCase()));
    return families.size;
  }, [ollamaModels]);

  return (
    <Section
      title="MODELS · OLLAMA"
      right={
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
            {filteredModels.length}{filteredModels.length !== (ollamaModels ?? []).length ? ` / ${(ollamaModels ?? []).length}` : ''} models
          </span>
          {familyCount > 0 && (
            <Chip tone="cyan">{familyCount} families</Chip>
          )}
        </span>
      }
    >
      {ollamaLoading && (ollamaModels ?? []).length === 0 ? (
        <EmptyState title="Scanning Ollama…" />
      ) : (ollamaModels ?? []).length === 0 ? (
        <EmptyState title="No Ollama models" hint="Ollama isn't running, or no models are pulled." />
      ) : (
        <>
          <Toolbar style={{ marginBottom: 6 }}>
            <FilterInput
              value={modelQuery}
              onChange={e => setModelQuery(e.target.value)}
              placeholder="Filter models…"
              aria-label="Filter Ollama models"
              spellCheck={false}
            />
          </Toolbar>
          {filteredModels.length === 0 ? (
            <EmptyState title="No matches" hint="Clear the filter." />
          ) : (
            <ScrollList maxHeight={250}>
              {filteredModels.map((m, i) => {
                const active = m === activeModel;
                const { family, tag } = parseModelName(m);
                const cat = modelCategory(family);
                return (
                  <div
                    key={m}
                    role={active ? 'none' : 'button'}
                    tabIndex={active ? undefined : 0}
                    aria-pressed={active ? true : undefined}
                    aria-label={active ? `${m} (active model)` : `Switch to ${m}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 10px',
                      border: `1px solid ${active ? `var(--green)44` : 'var(--line-soft)'}`,
                      borderLeft: `3px solid ${active ? 'var(--green)' : 'var(--line-soft)'}`,
                      background: active
                        ? 'linear-gradient(90deg, rgba(125, 255, 154, 0.06), transparent 40%)'
                        : 'transparent',
                      cursor: active ? 'default' : 'pointer',
                      transition: 'all 150ms ease',
                      animation: `fadeSlideIn 150ms ease ${i * 25}ms both`,
                    }}
                    onKeyDown={e => { if (!active && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSwitch(m); } }}
                    onClick={() => { if (!active) onSwitch(m); }}
                    onMouseEnter={e => {
                      if (!active) {
                        e.currentTarget.style.background = 'rgba(57,229,255,0.04)';
                        e.currentTarget.style.borderLeftColor = `var(--${cat.tone})`;
                      }
                    }}
                    onMouseLeave={e => {
                      if (!active) {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.borderLeftColor = 'var(--line-soft)';
                      }
                    }}
                    title={active ? 'Currently active model' : `Switch to ${m}`}
                  >
                    {/* Active pulse dot */}
                    {active && (
                      <span aria-hidden="true" style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: 'var(--green)',
                        boxShadow: '0 0 6px var(--green)',
                        animation: 'pulseDot 2s ease-in-out infinite',
                      }} />
                    )}
                    {/* Family chip */}
                    <Chip tone={cat.tone} style={{ flexShrink: 0 }}>{cat.label}</Chip>
                    {/* Model name */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontWeight: active ? 700 : 400,
                      }}>
                        {family}
                      </div>
                      {tag && (
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
                          marginTop: 1,
                        }}>
                          {tag}
                        </div>
                      )}
                    </div>
                    {active
                      ? <Chip tone="green">● ACTIVE</Chip>
                      : (
                        <span style={{
                          fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.18em',
                          color: 'var(--ink-dim)', opacity: 0.6,
                        }}>switch</span>
                      )}
                  </div>
                );
              })}
            </ScrollList>
          )}
        </>
      )}
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(3px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.5; transform: scale(0.8); }
        }
      `}</style>
    </Section>
  );
}
