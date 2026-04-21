import { useEffect } from 'react';
import { Dashboard } from './components/Dashboard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startMemoryWriter } from './lib/memoryWriter';
import { startLearningLoop } from './lib/learning';
import { startConsolidator } from './lib/consolidator';
import { startSkillSynthesizer } from './lib/skillSynthesis';
import { startProxyEngine, stopProxyEngine } from './lib/proxyEngine';
import { startDaemonRuntime, stopDaemonRuntime } from './lib/daemonRuntime';
import { startSubAgentWorker } from './lib/subAgents';
import { loadBuiltinSkills } from './lib/skills';
import { useAgentStore } from './store/agent';
import { useView } from './store/view';
import { invokeSafe, isTauri, listen } from './lib/tauri';
// Side-effect imports: auto-register extra tools into the global tool registry.
// Every module here adds more callable tools to the ReAct loop in `agentLoop.ts`
// (and therefore to every daemon run). The Rust side already dispatches these
// names; without the import the frontend simply can't see them.
import './lib/tools.visionAction';
import './lib/tools.terminals';
import './lib/tools.sunnyBrowser';
import './lib/tools.macos';
import './lib/tools.weather';
import './lib/tools.compute';
import './lib/tools.web';
import './lib/tools.filesys';
import './lib/tools.browser';
import './lib/tools.claudeCode';
import './lib/tools.ptyAgent';
import './styles/sunny.css';

/**
 * Keep a small set of settings mirrored onto `document.body` as className
 * modifiers so CSS (and :has() queries) can style against them without
 * threading React props through every component. Runs once on mount + on
 * any settings change; the unmount path is a no-op because body classes
 * survive for the whole app lifetime anyway.
 */
function useBodyClassSync(): void {
  const theme = useView(s => s.settings.theme);
  const reducedMotion = useView(s => s.settings.reducedMotion);
  const compactMode = useView(s => s.settings.compactMode);

  useEffect(() => {
    const { body } = document;
    body.classList.remove(
      'theme-cyan', 'theme-amber', 'theme-green', 'theme-violet', 'theme-magenta',
    );
    if (theme !== 'cyan') body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    document.body.classList.toggle('reduced-motion', reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    document.body.classList.toggle('compact-mode', compactMode);
  }, [compactMode]);
}

export default function App() {
  useBodyClassSync();
  useEffect(() => {
    // Global unhandled rejection logger — surfaces background Promise failures
    // as console errors without crashing the app. Fires before any of the
    // background services below so a rejection from one of them is captured.
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      console.error('[sunny/unhandled-rejection]', e.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    void loadBuiltinSkills().catch((err: unknown) => {
      console.error('[sunny/app] loadBuiltinSkills failed', err);
    });

    let stopMemoryWriter: (() => void) | undefined;
    let stopLearning: (() => void) | undefined;
    let stopConsolidator: (() => void) | undefined;
    let stopSynthesizer: (() => void) | undefined;
    let stopSubAgents: (() => void) | undefined;
    let stopDaemons: (() => void) | undefined;

    try { stopMemoryWriter = startMemoryWriter(); }
    catch (err) { console.error('[sunny/app] startMemoryWriter failed', err); }

    try { stopLearning = startLearningLoop(); }
    catch (err) { console.error('[sunny/app] startLearningLoop failed', err); }

    // LLM-driven semantic fact extraction from the episodic log. Runs on a
    // slow timer (15 min default), degrades silently when no provider is
    // reachable. Complements `learning.ts` (stats-based) and `memoryWriter`
    // (raw run summaries) with durable facts.
    try { stopConsolidator = startConsolidator(); }
    catch (err) { console.error('[sunny/app] startConsolidator failed', err); }

    // Skill synthesizer — scans recent successful runs, clusters them by
    // identical tool_sequence, and auto-compiles procedural skills when a
    // pattern appears 5+ times. Runs every 20 minutes, offset from the
    // consolidator's 15-min tick. This is the "SUNNY gets measurably
    // smarter with use" feedback loop, closed end-to-end.
    try { stopSynthesizer = startSkillSynthesizer(); }
    catch (err) { console.error('[sunny/app] startSkillSynthesizer failed', err); }

    // Per-contact proxy engine. No-op until the user enables a proxy on a
    // specific contact via the Contacts page.
    void Promise.resolve().then(() => startProxyEngine()).catch((err: unknown) => {
      console.error('[sunny/app] startProxyEngine failed', err);
    });

    // Sub-agent worker — drains the queued-runs list in `useSubAgents` by
    // invoking the ReAct agent loop for each. Required by the daemon
    // runtime below (daemons spawn sub-agent runs, worker executes them).
    try { stopSubAgents = startSubAgentWorker(); }
    catch (err) { console.error('[sunny/app] startSubAgentWorker failed', err); }

    // Daemon runtime — polls `daemons_ready_to_fire` every 15s, spawns
    // sub-agent runs for any that are due, and reports completion back
    // via `daemons_mark_fired`. This is what turns a daemon row in Auto
    // into a persistent AI agent that actually runs on its schedule.
    try { stopDaemons = startDaemonRuntime(); }
    catch (err) { console.error('[sunny/app] startDaemonRuntime failed', err); }

    // Keep the macOS tray icon + tooltip + menu in sync with the agent
    // store status AND the voice setting (so the Voice submenu's toggle
    // label flips between "Pause" and "Resume" immediately).
    const syncTray = () => {
      if (!isTauri) return;
      const a = useAgentStore.getState();
      const v = useView.getState().settings.voiceEnabled;
      void invokeSafe('tray_set_status', {
        kind: a.status,
        label: a.goal,
        voiceEnabled: v,
      });
    };
    syncTray();
    const unsubAgent = useAgentStore.subscribe(syncTray);
    const unsubView = useView.subscribe(syncTray);

    // Route tray menu clicks to real app actions. `sunny://nav` is already
    // handled by `Dashboard`; we only need to own the SUNNY-specific ones
    // that aren't page navigation.
    const trayUnsubs: Array<Promise<() => void>> = [];
    if (isTauri) {
      trayUnsubs.push(
        listen('sunny://tray/quickask', () => {
          window.dispatchEvent(new CustomEvent('sunny-ql-open'));
        }),
        listen('sunny://tray/toggle-voice', () => {
          const view = useView.getState();
          const next = !view.settings.voiceEnabled;
          view.patchSettings({ voiceEnabled: next });
          if (!next) void invokeSafe('speak_stop');
        }),
        listen('sunny://tray/stop-speak', () => {
          void invokeSafe('speak_stop');
        }),
        listen('sunny://tray/abort', () => {
          useAgentStore.getState().requestAbort();
        }),
        listen('sunny://tray/clear', () => {
          useAgentStore.getState().clearRun();
        }),
        listen('sunny://tray/prefs', () => {
          useView.getState().openSettings();
        }),
        listen('sunny://tray/about', () => {
          useView.getState().setView('overview');
        }),
      );
    }

    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      stopMemoryWriter?.();
      stopLearning?.();
      stopConsolidator?.();
      stopSynthesizer?.();
      stopProxyEngine();
      stopSubAgents?.();
      stopDaemons?.();
      stopDaemonRuntime();
      unsubAgent();
      unsubView();
      trayUnsubs.forEach(p => { void p.then(fn => fn && fn()); });
    };
  }, []);

  return (
    <ErrorBoundary>
      <Dashboard />
    </ErrorBoundary>
  );
}
