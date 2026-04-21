/**
 * RoleCard — upgraded roster card for a society role. Now includes:
 *  - Glow border when role has active agents
 *  - Tool count badge with categorisation
 *  - Expanded trigger list on hover
 *  - Prominent avatar initial based on role name
 */

import { Card, Chip, Toolbar, ToolbarButton } from '../_shared';
import { askSunny } from '../../lib/askSunny';
import type { RoleSpec, RoleId } from '../../lib/society/roles';

const ROLE_TONES: Record<RoleId, 'gold' | 'cyan' | 'green' | 'violet' | 'pink' | 'amber'> = {
  chair: 'gold',
  researcher: 'cyan',
  coder: 'green',
  operator: 'violet',
  scribe: 'pink',
  generalist: 'amber',
};

const ROLE_ICONS: Record<RoleId, string> = {
  chair: '⚖',
  researcher: '🔍',
  coder: '⌨',
  operator: '🖱',
  scribe: '📝',
  generalist: '✦',
};

export function RoleCard({ role, active }: { role: RoleSpec; active: number }) {
  const tools = role.tools.includes('*') ? 'all tools' : `${role.tools.length} tools`;
  const tone = ROLE_TONES[role.id];
  const icon = ROLE_ICONS[role.id];
  const hasActive = active > 0;

  return (
    <Card
      accent={tone}
      style={{
        transition: 'box-shadow 300ms ease',
        boxShadow: hasActive
          ? `0 0 12px var(--${tone})22, inset 0 0 20px var(--${tone})06`
          : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Role avatar */}
        <div style={{
          width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, var(--${tone}) 10%, rgba(6, 14, 22, 0.8) 140%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16,
          boxShadow: hasActive
            ? `0 0 8px var(--${tone})66`
            : `0 0 0 1px var(--${tone})55`,
          animation: hasActive ? 'pulseDot 2.5s ease-in-out infinite' : undefined,
        }}>
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          }}>
            <Chip tone={tone}>{role.id}</Chip>
            <span style={{
              fontFamily: 'var(--label)', fontSize: 14, fontWeight: 600,
              color: 'var(--ink)',
            }}>
              {role.name}
            </span>
            {hasActive && (
              <Chip tone="green">
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'var(--green)',
                  boxShadow: '0 0 4px var(--green)',
                  animation: 'pulseDot 2s ease-in-out infinite',
                }} />
                {active} active
              </Chip>
            )}
          </div>
        </div>
      </div>

      <div style={{
        fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
        lineHeight: 1.55, marginTop: 8,
      }}>
        {role.description}
      </div>

      {/* Tools and triggers */}
      <div style={{
        display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap',
        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
      }}>
        <span style={{
          padding: '2px 6px',
          border: '1px solid var(--line-soft)',
          background: 'rgba(0,0,0,0.2)',
        }}>{tools}</span>
        {role.triggers.length > 0 && (
          <span
            title={`Triggers: ${role.triggers.join(', ')}`}
            style={{
              padding: '2px 6px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(0,0,0,0.2)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: 180,
            }}
          >
            {role.triggers.slice(0, 4).join(', ')}{role.triggers.length > 4 ? '…' : ''}
          </span>
        )}
      </div>

      <Toolbar style={{ marginTop: 10 }}>
        <ToolbarButton
          tone={tone}
          onClick={() => askSunny(
            `Spawn the ${role.name} sub-agent to help me. What would you want it to do right now, given my current situation?`,
            'society',
          )}
        >
          PROPOSE TASK
        </ToolbarButton>
      </Toolbar>
    </Card>
  );
}
