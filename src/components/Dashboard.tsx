import { Suspense, lazy, useEffect, type ComponentType } from 'react';
import { useStageScale } from '../hooks/useStageScale';
import { useMetrics } from '../hooks/useMetrics';
import { useAgentStepBridge } from '../hooks/useAgentStepBridge';
import { useSubAgentsBridge } from '../hooks/useSubAgentsBridge';
import { usePlanExecuteBridge } from '../hooks/usePlanExecuteBridge';
import { useNavBridge } from '../hooks/useNavBridge';
import { useMicPrime } from '../hooks/useMicPrime';
import { useView, type ViewKey } from '../store/view';
import { onMenuEvent, onNavEvent } from '../hooks/useSunny';
import { PageErrorBoundary } from './ErrorBoundary';
import { SkipLink } from './SkipLink';
import { TopBar } from './TopBar';
import { NavPanel } from './NavPanel';
import { AutoTaskPanel } from './AutoTaskPanel';
import { AppsPanel } from './AppsPanel';
import { OrbCore } from './OrbCore';
import { SystemPanel } from './SystemPanel';
import { NetworkPanel } from './NetworkPanel';
import { AgentsPanel } from './AgentsPanel';
import { ProcessesPanel } from './ProcessesPanel';
import { PtyTerminal } from './PtyTerminal';
import { AgentActivity } from './AgentActivity';
import { ChatPanel } from './ChatPanel';
import { SettingsDropdown } from './SettingsDropdown';
import { StatusBanner } from './StatusBanner';
import { ToastStack } from './ToastStack';
import { AmbientToasts } from './AmbientToasts';
import { ConfirmGate } from './ConfirmGate';
import { ConfirmGateModal } from './ConfirmGateModal';
import { useGlobalHotkeys } from '../hooks/useGlobalHotkeys';
// The separate useVoiceAgent hook has been removed. The old design fanned
// every voice transcript out to BOTH useVoiceChat (chat path → openclaw →
// alfred) AND useVoiceAgent (runAgent → Sunny's own tool registry), which
// meant every "hey SUNNY" ran two brains on one mic and the two paths
// routinely disagreed. With openclaw's MCP-native tools (read/write/exec/
// browser/sessions/...) alfred already covers the tool surface, so we keep
// a single pipeline: voice → useVoiceChat → alfred. The agent loop is
// still reachable from the Auto page for long-running scripted runs; it
// just no longer races the conversational turn.
import { PAGES } from '../pages/pages';
import {
  useTerminals,
  TERMINALS_OPEN_EVENT,
  type TerminalsOpenDetail,
} from '../store/terminals';

// ---------------------------------------------------------------------------
// Lazy-loaded overlays.
//
// These five components are **conditionally rendered** (opened via hotkey
// or user action) but were previously bundled into the first-paint JS —
// roughly 200 KB of React + styles the user doesn't need at launch.
// Wrapping them in React.lazy moves each into its own chunk, cutting the
// critical-path bundle without changing their public API. A shared
// noscript-ish `<Suspense fallback={null}>` avoids any flash-of-empty
// UI — the overlays are invisible until their store state activates
// them anyway, so a null fallback matches closed-overlay behaviour.
// ---------------------------------------------------------------------------

const lazyNamed = <K extends string, M extends Record<K, ComponentType>>(
  loader: () => Promise<M>,
  exportName: K,
): ComponentType =>
  lazy(async () => {
    const mod = await loader();
    return { default: mod[exportName] };
  }) as unknown as ComponentType;

const CommandBar = lazyNamed(() => import('./CommandBar'), 'CommandBar');
const HelpOverlay = lazyNamed(() => import('./HelpOverlay'), 'HelpOverlay');
const PlanPanel = lazyNamed(() => import('./PlanPanel'), 'PlanPanel');
const QuickLauncher = lazyNamed(() => import('./QuickLauncher'), 'QuickLauncher');
const AgentOverlay = lazyNamed(() => import('./AgentOverlay'), 'AgentOverlay');
const TerminalsOverlay = lazyNamed(() => import('./TerminalsOverlay'), 'TerminalsOverlay');

// Dashboard terminals are registered in the shared terminals store at
// module load so the AI's tool registry can see and drive them the
// moment the app starts — even before the Dashboard component mounts.
// Each id matches the `id` prop passed to the matching `<PtyTerminal>`.
function ensureDashboardTerminalsRegistered(): void {
  const state = useTerminals.getState();
  const existing = new Set(state.sessions.map(s => s.id));
  const seeds: Array<{ id: string; title: string }> = [
    { id: 'dash:shell', title: 'shell' },
    { id: 'dash:agent', title: 'agent' },
    { id: 'dash:logs', title: 'logs' },
  ];
  for (const seed of seeds) {
    if (!existing.has(seed.id)) {
      state.add({ origin: 'dashboard', id: seed.id, title: seed.title, titlePinned: true });
    }
  }
}
ensureDashboardTerminalsRegistered();

function openTerminalsOverlay(detail?: TerminalsOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent<TerminalsOpenDetail>(TERMINALS_OPEN_EVENT, { detail: detail ?? {} }),
  );
}

export function Dashboard() {
  useStageScale();
  useGlobalHotkeys();
  // Bridge Rust `sunny://agent.step` events into useAgentStore so PlanPanel,
  // AgentOverlay, and AgentActivity reflect every tool call from the
  // Rust-side agent loop. Unconditional mount — rules of hooks compliant.
  useAgentStepBridge();
  // Mirror Rust-side sub-agent lifecycle events into useSubAgentsLive so the
  // new AgentsPanel lights up the moment a sub-agent spawns. Unconditional
  // mount — the bridge is inert until events start flowing.
  useSubAgentsBridge();
  // Mirror `sunny://plan-execute.step` events from the Rust plan_execute
  // composite into usePlanExecuteLive. No UI consumer yet — stub bridge so
  // a future panel can render progress without another refactor.
  usePlanExecuteBridge();
  // Wire the agent-side navigate_to_page / page_action / current_page_state
  // tools into the HUD. Listens for `sunny://nav.goto`, rebroadcasts
  // `sunny://nav.action` as a window CustomEvent, and mirrors the active
  // view into Tauri-managed state so the backend can read it back.
  useNavBridge();
  // ConfirmGateModal owns the `sunny://agent.confirm.request` listener now —
  // see ./ConfirmGateModal.tsx. No auto-confirm hook is mounted, so every
  // dangerous tool call surfaces a real Allow / Deny prompt.
  // Request mic permission at boot (triggers TCC prompt once) so the very
  // first voice turn doesn't block on a surprise permission dialog.
  useMicPrime();
  const { metrics, net, procs, battery } = useMetrics();
  // Granular selectors — each fires only when its own slice changes (fix sprint-14/item-5).
  const view = useView(s => s.view);
  const dockHidden = useView(s => s.dockHidden);
  // settings fields used directly in JSX
  const orbIntensity = useView(s => s.settings.orbIntensity);
  const gridOpacity = useView(s => s.settings.gridOpacity);
  // settings fields used in menu-event effect
  const settingsVoiceEnabled = useView(s => s.settings.voiceEnabled);
  const settingsTheme = useView(s => s.settings.theme);
  // Stable action refs — call getState() inside callbacks so closures never go stale.
  const setView = useView(s => s.setView);
  const toggleSettings = useView(s => s.toggleSettings);
  const openSettings = useView(s => s.openSettings);
  const patchSettings = useView(s => s.patchSettings);

  const ping = net?.ping_ms ?? 0;

  // Hook up native menu events: View→module, Assistant→toggle, SUNNY→preferences
  useEffect(() => {
    const unmenu = onMenuEvent(id => {
      if (id === 'preferences') openSettings();
      if (id === 'toggle-voice') patchSettings({ voiceEnabled: !settingsVoiceEnabled });
      if (id === 'cycle-theme') {
        const order = ['cyan', 'amber', 'green', 'violet', 'magenta'] as const;
        const i = order.indexOf(settingsTheme);
        patchSettings({ theme: order[(i + 1) % order.length] });
      }
    });
    const unnav = onNavEvent(v => setView(v as ViewKey));
    return () => { unmenu.then(fn => fn && fn()); unnav.then(fn => fn && fn()); };
  }, [openSettings, patchSettings, settingsVoiceEnabled, settingsTheme, setView]);

  // Cmd+, opens settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); toggleSettings(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSettings]);

  // Apply grid opacity from settings
  useEffect(() => {
    document.documentElement.style.setProperty('--grid-opacity', String(gridOpacity / 100));
  }, [gridOpacity]);

  const ActivePage = PAGES[view];
  const showPage = view !== 'overview' && ActivePage;

  return (
    <div className="viewport">
      {/* Skip navigation — WCAG 2.4.1. SkipLink is visually hidden until
          focused, then reveals itself at the top-left of the viewport.
          See src/components/SkipLink.tsx for the implementation. */}
      <SkipLink target="sunny-main-content" />
      {/* Thin drag strip covering the area ABOVE the visual topbar (the gap
          between the window's top edge and the topbar, which shifts with
          stage scale). Starts after the traffic lights and intentionally
          stays short so it never overlaps the clickable chips on the right
          side of the topbar. The topbar itself is also a drag region — see
          TopBar.tsx — so the full header feels draggable without swallowing
          chip clicks at the top pixel row. */}
      <div className="drag-region" data-tauri-drag-region aria-hidden="true" />
      <div className={`stage${view === 'overview' ? '' : ' not-overview'}${dockHidden ? ' dock-hidden' : ''}`}>
        <div className="grid" style={{ opacity: gridOpacity / 100 }} aria-hidden="true" />
        <div className="scan" aria-hidden="true" />

        <TopBar
          host={metrics?.host ?? 'macbook-pro.local'}
          ping={ping}
          metrics={metrics}
          net={net}
          procs={procs}
          battery={battery}
        />

        <NavPanel />
        {/* AUTO TASKS + APPS are Overview-only. They share the orb column
            with the Sunny core; on module pages the active page takes the
            full stage, so rendering them here would double up the UI.
            AutoTaskPanel polls the scheduler / reads agent stores; AppsPanel
            derives state from the shared `procs` list, so both are cheap to
            remount when the user returns to Overview. */}
        {view === 'overview' && (
          <>
            <AutoTaskPanel />
            <AppsPanel procs={procs} />
          </>
        )}

        <main id="sunny-main-content" tabIndex={-1} style={{ outline: 'none' }}>
          {showPage
            ? (
              <PageErrorBoundary label={view.toUpperCase()}>
                <ActivePage />
              </PageErrorBoundary>
            )
            : <OrbCore metrics={metrics} intensity={orbIntensity / 100} latencyMs={ping} />}
        </main>

        <SystemPanel metrics={metrics} battery={battery} />
        <NetworkPanel net={net} ping={ping} />
        <AgentsPanel />
        <ProcessesPanel procs={procs} />

        <PtyTerminal
          id="dash:shell"
          panelId="p-term1"
          title="TERMINAL · SHELL"
          small="zsh"
          onExpand={() => openTerminalsOverlay()}
        />
        <PtyTerminal
          id="dash:agent"
          panelId="p-term2"
          title="TERMINAL · AGENT"
          small="sunny-cli"
          initialCommand={`clear; echo "\\033[36m◆ sunny agent terminal — openclaw at ~/.nvm/.../bin/openclaw\\033[0m"`}
          statusLine={<AgentActivity />}
          onExpand={() => openTerminalsOverlay()}
        />
        <PtyTerminal
          id="dash:logs"
          panelId="p-term3"
          title="TERMINAL · LOGS"
          small="zsh"
          initialCommand={`clear; echo "\\033[36m◆ sunny logs — type 'log show --last 30s' or 'tail -f /var/log/system.log' to tail\\033[0m"`}
          onExpand={() => openTerminalsOverlay()}
        />

        <ChatPanel />

        <div className="vignette" aria-hidden="true" />
      </div>

      <SettingsDropdown />
      <StatusBanner />
      <ToastStack />
      <AmbientToasts />
      {/* Lazy-loaded overlays — `null` fallback matches the invisible
          closed state, so the user never sees a flash while a chunk loads.
          Wrapped in its own PageErrorBoundary so a crash in one overlay
          (e.g. CommandBar) doesn't cascade into the main HUD panels. */}
      <PageErrorBoundary label="OVERLAY">
        <Suspense fallback={null}>
          <CommandBar />
          <HelpOverlay />
          <QuickLauncher />
          <PlanPanel />
          <AgentOverlay />
          <TerminalsOverlay />
        </Suspense>
      </PageErrorBoundary>
      <ConfirmGate />
      <ConfirmGateModal />
    </div>
  );
}
