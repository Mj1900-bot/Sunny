import type { ReactElement } from 'react';
import { useState, type CSSProperties } from 'react';
import { AuditViewer } from './AuditViewer';
import { posture, profileColor } from './profiles';
import { useTabs } from './tabStore';
import type { SecurityLevel } from './types';

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 8px',
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.14em',
  borderBottom: '1px dashed var(--line-soft)',
  color: 'var(--ink-dim)',
  flexShrink: 0,
};

export function PostureBar(): ReactElement {
  const profiles = useTabs(s => s.profiles);
  const tabs = useTabs(s => s.tabs);
  const activeTabId = useTabs(s => s.activeTabId);
  const killSwitch = useTabs(s => s.killSwitch);
  const upsertProfile = useTabs(s => s.upsertProfile);
  const [auditOpen, setAuditOpen] = useState(false);

  const tab = tabs.find(t => t.id === activeTabId);
  const policy = profiles.find(p => p.id === tab?.profileId) ?? profiles[0];
  if (!policy) return <div style={bar}>NO PROFILE</div>;
  const color = profileColor(policy);

  const pickLevel = (level: SecurityLevel) => {
    if (policy.security_level === level) return;
    void upsertProfile({ ...policy, security_level: level });
  };

  const levelBtn = (level: SecurityLevel, label: string, tip: string) => (
    <button
      type="button"
      onClick={() => pickLevel(level)}
      title={tip}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '1px 6px',
        border: '1px solid var(--line-soft)',
        color: policy.security_level === level ? color : 'var(--ink-dim)',
        borderColor: policy.security_level === level ? color : 'var(--line-soft)',
        fontFamily: 'var(--mono)',
        fontSize: 9,
        letterSpacing: '0.14em',
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div style={bar}>
        <span style={{ color, fontWeight: 600 }}>{posture(policy)}</span>
        {killSwitch ? (
          <span style={{ color: '#ff6b6b', marginLeft: 'auto' }}>
            {'// KILL SWITCH ARMED — no traffic leaves'}
          </span>
        ) : (
          <span style={{ marginLeft: 'auto' }}>
            {'// '}
            {tab?.renderMode === 'sandbox'
              ? 'SANDBOX TAB · WebView isolated'
              : 'READER MODE · no JS executes'}
          </span>
        )}
        <span style={{ display: 'flex', gap: 4, marginLeft: 10 }}>
          {levelBtn('standard', 'STD', 'Standard: no extra hardening beyond profile defaults')}
          {levelBtn('safer', 'SAFER', 'Safer: WebAssembly off, audio/canvas perturbed, timing rounded to 1ms')}
          {levelBtn('safest', 'SAFEST', 'Safest: everything above + JS eval blocked, timing rounded to 100ms')}
        </span>
        <button
          type="button"
          onClick={() => setAuditOpen(true)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            marginLeft: 10,
            padding: '2px 8px',
            border: '1px solid var(--line-soft)',
            color: 'var(--cyan)',
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.14em',
          }}
          title="Open the audit log — every outbound request we've observed"
        >
          AUDIT
        </button>
      </div>
      {auditOpen && <AuditViewer onClose={() => setAuditOpen(false)} />}
    </>
  );
}
