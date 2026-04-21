/**
 * SecurityPage — the live runtime security module.
 *
 * Distinct from SCAN (file / signature malware sweep). SECURITY is the
 * ongoing watchdog: every agent tool call, every egress, every TCC
 * change, every new LaunchAgent / login item, every unsigned binary
 * Sunny launches.  Plus a panic kill-switch that stops the agent +
 * refuses egress + disables daemons in one click.
 *
 * Nine tabs:
 *   OVERVIEW, POLICY, AGENT, NETWORK, PERMS, INTRUSION, SECRETS, SYSTEM, AUDIT
 *   (see TABS below for labels).
 *
 * Hotkeys (page-scoped, guarded against text inputs):
 *   1–9 → tab · ! → panic · P → release panic.
 */

import { useCallback, useEffect, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { tabBarStyle, tabStyle } from './styles';
import { AgentAuditTab } from './AgentAuditTab';
import { AuditLogTab } from './AuditLogTab';
import { GrantsTab } from './GrantsTab';
import { IntrusionTab } from './IntrusionTab';
import { NetworkTab } from './NetworkTab';
import { OverviewTab } from './OverviewTab';
import { PermissionsTab } from './PermissionsTab';
import { PolicyTab } from './PolicyTab';
import { SecretsTab } from './SecretsTab';
import { SystemTab } from './SystemTab';
import { fetchPanicMode, panic, panicReset, subscribeSummary } from './api';
import { isHelpOverlayOpen } from '../../components/HelpOverlay';
import type { Summary } from './types';

type Tab = 'overview' | 'policy' | 'agent' | 'network' | 'perms' | 'intrusion' | 'secrets' | 'system' | 'audit' | 'grants';

const TABS: ReadonlyArray<{ id: Tab; label: string; hotkey: string }> = [
  { id: 'overview',  label: 'OVERVIEW',  hotkey: '1' },
  { id: 'policy',    label: 'POLICY',    hotkey: '2' },
  { id: 'agent',     label: 'AGENT',     hotkey: '3' },
  { id: 'network',   label: 'NETWORK',   hotkey: '4' },
  { id: 'perms',     label: 'PERMS',     hotkey: '5' },
  { id: 'intrusion', label: 'INTRUSION', hotkey: '6' },
  { id: 'secrets',   label: 'SECRETS',   hotkey: '7' },
  { id: 'system',    label: 'SYSTEM',    hotkey: '8' },
  { id: 'audit',     label: 'AUDIT',     hotkey: '9' },
  { id: 'grants',    label: 'GRANTS',    hotkey: '0' },
];

export function SecurityPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [panicMode, setPanicMode] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const initial = await fetchPanicMode();
      if (alive) setPanicMode(initial);
    })();
    const p = subscribeSummary((s: Summary) => {
      setPanicMode(s.panic_mode);
    });
    return () => {
      alive = false;
      void p.then(u => u && u());
    };
  }, []);

  // Page hotkeys — guarded against text inputs so typing a `!` into a
  // search box doesn't panic the app.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (inEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const hit = TABS.find(t => t.hotkey === e.key);
      if (hit) {
        setTab(hit.id);
        return;
      }
      if (e.key === '!') {
        e.preventDefault();
        // Arm panic. We don't trigger a confirm modal here — the user
        // explicitly hit "!" which is an intentional two-finger key
        // combo; the nav-strip button has its own click-again pattern.
        await panic('security page hotkey');
      }
      if (e.key === 'P' || e.key === 'p') {
        if (panicMode) {
          await panicReset('security page hotkey');
        }
      }
      if (e.key === '?' && !isHelpOverlayOpen()) {
        setShowHelp(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panicMode]);

  const onPick = useCallback((t: Tab) => setTab(t), []);

  return (
    <ModuleView title="SECURITY" badge={panicMode ? 'PANIC' : 'LIVE'}>
      <div style={tabBarStyle} role="tablist" aria-label="Security tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            style={tabStyle(tab === t.id)}
            onClick={() => onPick(t.id)}
            title={`${t.label} · press ${t.hotkey}`}
          >
            {t.label}
            <span style={{ opacity: 0.4, marginLeft: 8, fontSize: 8 }}>{t.hotkey}</span>
          </button>
        ))}
        <button
          style={{
            all: 'unset',
            cursor: 'pointer',
            marginLeft: 'auto',
            padding: '6px 10px',
            border: '1px solid var(--line-soft)',
            background: showHelp ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.55)',
            color: showHelp ? 'var(--cyan)' : 'var(--ink-dim)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
          }}
          title="Show keyboard shortcuts (?)"
          aria-label="Show keyboard shortcuts"
          onClick={() => setShowHelp(v => !v)}
        >
          ?
        </button>
      </div>

      {showHelp && (
        <div
          role="region"
          aria-label="Keyboard shortcuts"
          style={{
            border: '1px solid var(--line-soft)',
            background: 'rgba(4, 10, 16, 0.92)',
            padding: '16px 20px',
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 10,
              letterSpacing: '0.26em',
              color: 'var(--cyan)',
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            KEYBOARD SHORTCUTS
          </div>
          <table
            style={{
              borderCollapse: 'collapse',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              width: '100%',
            }}
          >
            <tbody>
              {TABS.map(t => (
                <tr key={t.id}>
                  <td
                    style={{
                      padding: '3px 12px 3px 0',
                      color: 'var(--cyan)',
                      fontWeight: 700,
                      width: 28,
                    }}
                  >
                    {t.hotkey}
                  </td>
                  <td style={{ padding: '3px 0', color: 'var(--ink-2)' }}>
                    {t.label}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ padding: '3px 12px 3px 0', color: 'var(--red)', fontWeight: 700 }}>!</td>
                <td style={{ padding: '3px 0', color: 'var(--ink-2)' }}>PANIC — kill agents + block egress</td>
              </tr>
              <tr>
                <td style={{ padding: '3px 12px 3px 0', color: 'var(--green)', fontWeight: 700 }}>P</td>
                <td style={{ padding: '3px 0', color: 'var(--ink-2)' }}>release panic (only when active)</td>
              </tr>
              <tr>
                <td style={{ padding: '3px 12px 3px 0', color: 'var(--amber)', fontWeight: 700 }}>?</td>
                <td style={{ padding: '3px 0', color: 'var(--ink-2)' }}>toggle this shortcuts panel</td>
              </tr>
            </tbody>
          </table>
          <div
            style={{
              marginTop: 10,
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink-dim)',
            }}
          >
            press ? again or click ? in the tab bar to close
          </div>
        </div>
      )}

      {tab === 'overview'  && <OverviewTab />}
      {tab === 'policy'    && <PolicyTab />}
      {tab === 'agent'     && <AgentAuditTab />}
      {tab === 'network'   && <NetworkTab />}
      {tab === 'perms'     && <PermissionsTab />}
      {tab === 'intrusion' && <IntrusionTab />}
      {tab === 'secrets'   && <SecretsTab />}
      {tab === 'system'    && <SystemTab />}
      {tab === 'audit'     && <AuditLogTab />}
      {tab === 'grants'    && <GrantsTab />}

    </ModuleView>
  );
}
