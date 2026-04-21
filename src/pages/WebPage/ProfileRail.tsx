import type { CSSProperties, ReactElement } from 'react';
import { profileColor, routeTag } from './profiles';
import { useTabs } from './tabStore';
import type { ProfilePolicy } from './types';

const BUILTIN_IDS = new Set(['default', 'private', 'tor']);

const rail: CSSProperties = {
  width: 108,
  flexShrink: 0,
  borderRight: '1px solid var(--line-soft)',
  padding: '8px 6px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  overflowY: 'auto',
  boxSizing: 'border-box',
};

const heading: CSSProperties = {
  fontFamily: "'Orbitron', var(--display, var(--mono))",
  fontSize: 9,
  letterSpacing: '0.22em',
  color: 'var(--cyan)',
  padding: '2px 2px 6px',
  borderBottom: '1px solid var(--line-soft)',
};

const btnBase: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  textAlign: 'left',
  padding: '8px 8px',
  border: '1px solid var(--line-soft)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  background: 'rgba(4, 10, 16, 0.4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  boxSizing: 'border-box',
};

export function ProfileRail(): ReactElement {
  const profiles = useTabs(s => s.profiles);
  const tabs = useTabs(s => s.tabs);
  const activeTabId = useTabs(s => s.activeTabId);
  const openTab = useTabs(s => s.openTab);
  const upsertProfile = useTabs(s => s.upsertProfile);
  const removeProfile = useTabs(s => s.removeProfile);
  const killSwitch = useTabs(s => s.killSwitch);
  const setKillSwitch = useTabs(s => s.setKillSwitch);
  const torStatus = useTabs(s => s.torStatus);

  const activeProfileId =
    tabs.find(t => t.id === activeTabId)?.profileId ?? profiles[0]?.id ?? 'default';

  const addCustom = async () => {
    const id = window.prompt('Profile id (letters/numbers/underscores):', 'mullvad');
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) return;
    if (BUILTIN_IDS.has(id)) {
      alert('id reserved for a built-in profile');
      return;
    }
    const url = window.prompt(
      'Proxy URL (socks5://, socks5h://, http://, https://):',
      'socks5h://127.0.0.1:1080',
    );
    if (!url) return;
    const policy: ProfilePolicy = {
      id,
      label: id,
      route: { kind: 'custom', url },
      cookies: 'ephemeral',
      js_default: 'off_by_default',
      ua_mode: 'pinned_safari',
      block_third_party_cookies: true,
      block_trackers: true,
      block_webrtc: true,
      deny_sensors: true,
      audit: true,
      kill_switch_bypass: false,
      https_only: true,
      security_level: 'safer',
    };
    try {
      await upsertProfile(policy);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={rail}>
      <div style={heading}>PROFILES</div>
      {profiles.map(p => (
        <ProfileChip
          key={p.id}
          policy={p}
          active={activeProfileId === p.id}
          tabCount={tabs.filter(t => t.profileId === p.id).length}
          onOpen={() => openTab(p.id)}
          onRemove={
            BUILTIN_IDS.has(p.id)
              ? undefined
              : () => {
                  if (window.confirm(`Remove profile "${p.label}"?`)) {
                    void removeProfile(p.id);
                  }
                }
          }
        />
      ))}
      <button
        type="button"
        onClick={() => void addCustom()}
        style={{
          ...btnBase,
          borderStyle: 'dashed',
          color: 'var(--ink-dim)',
          justifyContent: 'center',
        }}
        title="Add a new profile routed through a custom proxy"
      >
        + CUSTOM
      </button>

      <div style={{ ...heading, marginTop: 10 }}>POSTURE</div>
      <button
        type="button"
        onClick={() => void setKillSwitch(!killSwitch)}
        title={
          killSwitch
            ? 'Kill switch ARMED: all tabs halted until disarmed'
            : 'Arm to halt every outbound request'
        }
        style={{
          ...btnBase,
          borderColor: killSwitch ? '#ff6b6b' : 'var(--line-soft)',
          color: killSwitch ? '#ff6b6b' : 'var(--ink)',
        }}
      >
        <span style={{ letterSpacing: '0.14em', fontSize: 10 }}>
          {killSwitch ? 'KILL · ARMED' : 'KILL · SAFE'}
        </span>
        <span style={{ fontSize: 9, color: 'var(--ink-dim)' }}>
          {killSwitch ? 'NO NETWORK' : 'tap to arm'}
        </span>
      </button>

      <div style={{ ...btnBase, cursor: 'default' }} title="System Tor probe">
        <span style={{ letterSpacing: '0.14em', fontSize: 10 }}>TOR</span>
        <span style={{ fontSize: 9, color: torStatus?.bootstrapped ? '#8ae68a' : 'var(--ink-dim)' }}>
          {torStatus?.bootstrapped
            ? `${torStatus.source ?? 'up'} · :${torStatus.socks_port ?? '?'}`
            : 'not running'}
        </span>
      </div>
    </div>
  );
}

function ProfileChip({
  policy,
  active,
  tabCount,
  onOpen,
  onRemove,
}: {
  policy: ProfilePolicy;
  active: boolean;
  tabCount: number;
  onOpen: () => void;
  onRemove?: () => void;
}): ReactElement {
  const color = profileColor(policy);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onOpen}
        title={`Open new ${policy.label} tab`}
        style={{
          ...btnBase,
          borderColor: active ? color : 'var(--line-soft)',
          background: active ? 'rgba(0, 220, 255, 0.06)' : 'rgba(4, 10, 16, 0.4)',
          width: '100%',
        }}
      >
        <span style={{ letterSpacing: '0.18em', color }}>{policy.label.toUpperCase()}</span>
        <span style={{ fontSize: 9, color: 'var(--ink-dim)' }}>
          {routeTag(policy)} · {tabCount} tab{tabCount === 1 ? '' : 's'}
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={`Remove ${policy.label}`}
          style={{
            all: 'unset',
            cursor: 'pointer',
            position: 'absolute',
            top: 2,
            right: 4,
            fontSize: 10,
            color: 'var(--ink-dim)',
          }}
          aria-label="Remove profile"
        >
          {'\u00d7'}
        </button>
      )}
    </div>
  );
}
