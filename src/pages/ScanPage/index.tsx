import { useCallback, useEffect, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { FindingsTab } from './FindingsTab';
import { HistoryTab } from './HistoryTab';
import { ScanTab } from './ScanTab';
import { VaultTab } from './VaultTab';
import { tabBarStyle, tabStyle } from './styles';
import type { VaultItem } from './types';

// ─────────────────────────────────────────────────────────────────
// ScanPage — SCAN module root.
//
// Four tabs that mirror the typical workflow:
//   SCAN      — pick a target, tweak options, kick off a scan
//   FINDINGS  — live + post-scan findings with actions
//   VAULT     — isolated files (view / restore / delete forever)
//   HISTORY   — past scans, reselect any one to inspect findings
//
// Hotkeys inside the page:
//   1-4 → tab, / → focus findings search.
// ─────────────────────────────────────────────────────────────────

type Tab = 'scan' | 'findings' | 'vault' | 'history';

const TABS: ReadonlyArray<{ id: Tab; label: string; hotkey: string }> = [
  { id: 'scan', label: 'SCAN', hotkey: '1' },
  { id: 'findings', label: 'FINDINGS', hotkey: '2' },
  { id: 'vault', label: 'VAULT', hotkey: '3' },
  { id: 'history', label: 'HISTORY', hotkey: '4' },
];

export function ScanPage() {
  const [tab, setTab] = useState<Tab>('scan');
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [vaultRefreshToken, setVaultRefreshToken] = useState<number>(0);
  const [searchFocusToken, setSearchFocusToken] = useState<number>(0);

  const onScanStarted = useCallback((scanId: string) => {
    setActiveScanId(scanId);
    // Stay on the SCAN tab so the user can watch the live progress HUD —
    // they can jump to FINDINGS with the `2` hotkey or the tab chip
    // whenever they want to triage results.
  }, []);

  const onJumpToFindings = useCallback(() => setTab('findings'), []);

  const onQuarantined = useCallback((_item: VaultItem) => {
    // Bump the refresh token so the vault tab re-fetches immediately when
    // the user switches to it. Don't auto-switch — interrupting triage is
    // more annoying than helpful.
    setVaultRefreshToken(t => t + 1);
  }, []);

  const onSelectHistory = useCallback((scanId: string) => {
    setActiveScanId(scanId);
    setTab('findings');
  }, []);

  // Page-scoped hotkeys. Guarded against text inputs so typing "1" into a
  // search box doesn't jump tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      // Cmd/Ctrl combos belong to the global hotkey hook, not us.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (!inEditable) {
        if (e.key === '1') { setTab('scan'); return; }
        if (e.key === '2') { setTab('findings'); return; }
        if (e.key === '3') { setTab('vault'); return; }
        if (e.key === '4') { setTab('history'); return; }
      }
      if (e.key === '/' && !inEditable) {
        e.preventDefault();
        setTab('findings');
        setSearchFocusToken(t => t + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ModuleView title="SCAN" badge={activeScanId ? 'ACTIVE SCAN' : 'IDLE'}>
      <div style={tabBarStyle} role="tablist" aria-label="Scan tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            style={tabStyle(tab === t.id)}
            onClick={() => setTab(t.id)}
            title={`${t.label} · press ${t.hotkey}`}
          >
            {t.label}
            <span style={{ opacity: 0.4, marginLeft: 8, fontSize: 8 }}>{t.hotkey}</span>
          </button>
        ))}
      </div>

      {tab === 'scan' && (
        <ScanTab
          onScanStarted={onScanStarted}
          activeScanId={activeScanId}
          onJumpToFindings={onJumpToFindings}
        />
      )}
      {tab === 'findings' && (
        <FindingsTab
          scanId={activeScanId}
          onQuarantined={onQuarantined}
          searchFocusToken={searchFocusToken}
        />
      )}
      {tab === 'vault' && <VaultTab refreshToken={vaultRefreshToken} />}
      {tab === 'history' && (
        <HistoryTab activeScanId={activeScanId} onSelect={onSelectHistory} />
      )}
    </ModuleView>
  );
}
