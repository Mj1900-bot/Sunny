/**
 * PersonaPreview — read-only summary showing how the current constitution
 * would appear when assembled into Sunny's system prompt. Helps the user
 * understand the impact of their edits at a glance.
 */

import { Section, Chip } from '../_shared';
import type { Constitution } from './api';

export function PersonaPreview({ constitution }: { constitution: Constitution }) {
  const { identity, values, prohibitions } = constitution;
  const hasVoice = identity.voice.trim().length > 0;
  const totalChars =
    identity.name.length +
    identity.operator.length +
    identity.voice.length +
    values.join('').length +
    prohibitions.map(p => p.description).join('').length;

  return (
    <Section title="SYSTEM PROMPT PREVIEW" right={`~${totalChars} chars`}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
        lineHeight: 1.65,
        padding: '12px 14px',
        border: '1px solid var(--line-soft)',
        borderLeft: '3px solid var(--cyan)',
        background: 'rgba(0, 0, 0, 0.3)',
        maxHeight: 260, overflowY: 'auto',
      }}>
        {/* Identity block */}
        <div style={{ marginBottom: 10 }}>
          <Chip tone="cyan" style={{ marginBottom: 4 }}>IDENTITY</Chip>
          <div style={{ paddingLeft: 8 }}>
            <span style={{ color: 'var(--ink-dim)' }}>You are </span>
            <span style={{ color: 'var(--cyan)', fontWeight: 700 }}>{identity.name || '?'}</span>
            <span style={{ color: 'var(--ink-dim)' }}>, operated by </span>
            <span style={{ color: 'var(--violet)' }}>{identity.operator || '?'}</span>
            <span style={{ color: 'var(--ink-dim)' }}>.</span>
          </div>
          {hasVoice && (
            <div style={{
              paddingLeft: 8, marginTop: 4,
              color: 'var(--ink-dim)', fontStyle: 'italic',
            }}>
              Voice: &ldquo;{identity.voice.slice(0, 120)}{identity.voice.length > 120 ? '…' : ''}&rdquo;
            </div>
          )}
        </div>

        {/* Values block */}
        {values.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <Chip tone="gold" style={{ marginBottom: 4 }}>VALUES ({values.length})</Chip>
            <ol style={{
              margin: 0, paddingLeft: 24,
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {values.map((v, i) => (
                <li key={i} style={{
                  color: 'var(--ink-2)',
                  opacity: Math.max(0.6, 1 - i * 0.06),
                }}>
                  {v.length > 80 ? `${v.slice(0, 77)}…` : v}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Prohibitions block */}
        {prohibitions.length > 0 && (
          <div>
            <Chip tone="red" style={{ marginBottom: 4 }}>PROHIBITIONS ({prohibitions.length})</Chip>
            <ul style={{
              margin: 0, paddingLeft: 24,
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {prohibitions.map((p, i) => (
                <li key={i} style={{ color: 'var(--red)' }}>
                  <span style={{ color: 'var(--ink-2)' }}>{p.description}</span>
                  {p.tools.length > 0 && (
                    <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
                      {' '}({p.tools.join(', ')})
                    </span>
                  )}
                  {p.after_local_hour != null && (
                    <span style={{ color: 'var(--amber)', fontSize: 10 }}>
                      {' '}after {p.after_local_hour}:00
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <div style={{
          marginTop: 10, paddingTop: 8,
          borderTop: '1px dashed var(--line-soft)',
          color: 'var(--ink-dim)', fontSize: 9,
        }}>
          This preview approximates how the constitution is injected into every agent turn.
          Schema v{constitution.schema_version}.
        </div>
      </div>
    </Section>
  );
}
