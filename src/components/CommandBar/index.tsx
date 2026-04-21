import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSunny } from '../../hooks/useSunny';
import { runAgent, type AgentStep } from '../../lib/agentLoop';
import { invokeSafe } from '../../lib/tauri';
import { useAgentStore } from '../../store/agent';
import { useSafety } from '../../store/safety';
import { useView } from '../../store/view';
import { NAV_TARGETS, RECENT_KEY, THEME_ORDER } from './constants';
import { CMDK_CSS } from './styles';
import type { Command } from './types';
import {
  formatElapsed,
  fuzzyMatch,
  loadRecent,
  pushRecent,
  scoreTitle,
  toPlanStep,
} from './utils';

export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [recent, setRecent] = useState<ReadonlyArray<string>>(() => loadRecent());
  const [askMode, setAskMode] = useState(false);
  const [askInput, setAskInput] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askResult, setAskResult] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [agentInput, setAgentInput] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const agentRef = useRef<HTMLInputElement | null>(null);

  const setView = useView(s => s.setView);
  const openSettings = useView(s => s.openSettings);
  const settingsTheme = useView(s => s.settings.theme);
  const settingsVoiceEnabled = useView(s => s.settings.voiceEnabled);
  const patchSettings = useView(s => s.patchSettings);
  const { chat, speak, runShell } = useSunny();

  // Agent store subscriptions — re-render only on the fields we actually show.
  const agentStatus = useAgentStore(s => s.status);
  const agentGoal = useAgentStore(s => s.goal);
  const agentSteps = useAgentStore(s => s.steps);
  const agentFinalAnswer = useAgentStore(s => s.finalAnswer);
  const agentStartedAt = useAgentStore(s => s.startedAt);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
    setAskMode(false);
    setAskInput('');
    setAskBusy(false);
    setAskResult(null);
    // Note: we intentionally do NOT reset agentMode / agentInput here — an
    // in-flight agent run keeps running in the store regardless of palette
    // visibility, and we want the user to see the same state on reopen.
  }, []);

  const recordRecent = useCallback((id: string) => {
    setRecent(prev => {
      const next = pushRecent(prev, id);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch (err) {
        console.error('sunny.cmdk recent persist failed', err);
      }
      return next;
    });
  }, []);

  const submitAsk = useCallback(async () => {
    const text = askInput.trim();
    if (!text) return;
    setAskBusy(true);
    setAskResult(null);
    try {
      const reply = await chat(text);
      setAskResult(reply);
    } catch (err) {
      console.error('sunny.cmdk chat failed', err);
      setAskResult('Request failed. Check provider settings.');
    } finally {
      setAskBusy(false);
    }
  }, [askInput, chat]);

  const speakSelection = useCallback(async () => {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() ?? '' : '';
    const text = sel.trim();
    if (!text) {
      console.error('sunny.cmdk speak selection: no text selected');
      return;
    }
    try {
      await speak(text);
    } catch (err) {
      console.error('sunny.cmdk speak failed', err);
    }
  }, [speak]);

  const cycleTheme = useCallback(() => {
    const i = THEME_ORDER.indexOf(settingsTheme);
    const next = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    patchSettings({ theme: next });
  }, [settingsTheme, patchSettings]);

  const toggleVoice = useCallback(() => {
    patchSettings({ voiceEnabled: !settingsVoiceEnabled });
  }, [settingsVoiceEnabled, patchSettings]);

  const reloadApp = useCallback(() => {
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  const openTerminal = useCallback(async () => {
    try {
      await invokeSafe('open_app', { name: 'Terminal' });
    } catch (err) {
      console.error('sunny.cmdk open terminal failed', err);
    }
  }, []);

  const commands = useMemo<ReadonlyArray<Command>>(() => {
    const nav: ReadonlyArray<Command> = NAV_TARGETS.map(({ view, label }) => ({
      id: `nav.${view}`,
      title: `Go to ${label}`,
      category: 'NAV',
      run: () => setView(view),
    }));
    const ai: ReadonlyArray<Command> = [
      {
        id: 'ai.agent',
        title: 'Run SUNNY agent…',
        category: 'AI',
        run: () => {
          setAgentMode(true);
          setAskMode(false);
        },
      },
      {
        id: 'ai.ask',
        title: 'Ask SUNNY…',
        category: 'AI',
        run: () => {
          setAskMode(true);
          setAskInput('');
          setAskResult(null);
        },
      },
      {
        id: 'ai.toggle-voice',
        title: 'Toggle voice',
        category: 'AI',
        run: toggleVoice,
      },
      {
        id: 'ai.speak-selection',
        title: 'Speak selection',
        category: 'AI',
        run: speakSelection,
      },
    ];
    const system: ReadonlyArray<Command> = [
      { id: 'sys.terminal', title: 'Open Terminal', category: 'SYSTEM', run: openTerminal },
      { id: 'sys.settings', title: 'Open Settings', category: 'SYSTEM', run: openSettings },
      { id: 'sys.cycle-theme', title: 'Cycle Theme', category: 'SYSTEM', run: cycleTheme },
      { id: 'sys.reload', title: 'Reload app', category: 'SYSTEM', run: reloadApp },
    ];
    const power: ReadonlyArray<Command> = [
      {
        id: 'pwr.lock',
        title: 'Lock screen',
        category: 'POWER',
        run: async () => {
          try { await runShell('pmset displaysleepnow'); }
          catch (err) { console.error('sunny.cmdk lock failed', err); }
        },
      },
      {
        id: 'pwr.screenshot',
        title: 'Take screenshot',
        category: 'POWER',
        run: async () => {
          try { await runShell('screencapture -c'); }
          catch (err) { console.error('sunny.cmdk screenshot failed', err); }
        },
      },
    ];
    return [...nav, ...ai, ...system, ...power];
  }, [setView, toggleVoice, speakSelection, openTerminal, openSettings, cycleTheme, reloadApp, runShell]);

  const byId = useMemo(() => {
    const map = new Map<string, Command>();
    for (const c of commands) map.set(c.id, c);
    return map;
  }, [commands]);

  const visible = useMemo<ReadonlyArray<Command>>(() => {
    const q = query.trim();
    if (!q) {
      const recentCmds = recent
        .map(id => byId.get(id))
        .filter((c): c is Command => Boolean(c));
      const seen = new Set(recentCmds.map(c => c.id));
      const rest = commands.filter(c => !seen.has(c.id));
      return [...recentCmds, ...rest];
    }
    const filtered = commands.filter(c => fuzzyMatch(q, c.title));
    return [...filtered].sort((a, b) => scoreTitle(q, b.title) - scoreTitle(q, a.title));
  }, [query, recent, byId, commands]);

  const run = useCallback(
    (cmd: Command) => {
      recordRecent(cmd.id);
      const result = cmd.run();
      if (cmd.id === 'ai.ask' || cmd.id === 'ai.agent') {
        // Keep palette open, focus the secondary input.
        if (result instanceof Promise) void result;
        return;
      }
      if (result instanceof Promise) {
        void result.finally(() => close());
      } else {
        close();
      }
    },
    [recordRecent, close],
  );

  // ---- Agent submission ---------------------------------------------------

  const submitAgent = useCallback(async () => {
    const goal = agentInput.trim();
    if (!goal) return;
    if (agentStatus === 'running') return;

    // Read store methods + signal fresh at invocation time so we capture the
    // controller that `startRun` mints for THIS run (the signal reference on
    // the store flips when startRun is called).
    const store = useAgentStore.getState();
    store.startRun(goal);
    const signal = useAgentStore.getState().abortSignal;

    const confirmDangerous = (name: string, input: unknown): Promise<boolean> =>
      useSafety.getState().request({
        title: `Run tool: ${name}`,
        description: 'SUNNY wants to execute a tool. Approve or cancel.',
        verb: 'EXECUTE',
        preview: JSON.stringify(input, null, 2),
        risk: 'medium',
      });

    try {
      const result = await runAgent({
        goal,
        signal,
        onStep: (step: AgentStep) => {
          useAgentStore.getState().appendStep(toPlanStep(step));
        },
        confirmDangerous,
      });
      // runAgent may return 'max_steps', but the store's AgentRunStatus uses
      // 'error' for non-happy terminal states. Map max_steps → error.
      const terminal = result.status === 'max_steps' ? 'error' : result.status;
      useAgentStore.getState().completeRun(terminal, result.finalAnswer);
    } catch (err) {
      console.error('sunny.cmdk agent run failed', err);
      const message = err instanceof Error ? err.message : String(err);
      useAgentStore.getState().completeRun('error', `Agent run failed: ${message}`);
    }
  }, [agentInput, agentStatus]);

  const onAgentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && agentStatus !== 'running') {
        e.preventDefault();
        void submitAgent();
      }
    },
    [agentStatus, submitAgent],
  );

  const stopAgent = useCallback(() => {
    useAgentStore.getState().requestAbort();
  }, []);

  const clearAgent = useCallback(() => {
    useAgentStore.getState().clearRun();
    setAgentInput('');
  }, []);

  // Tick elapsed time while running.
  useEffect(() => {
    if (agentStatus !== 'running' || agentStartedAt === null) {
      if (agentStartedAt !== null) setElapsed(Date.now() - agentStartedAt);
      else setElapsed(0);
      return;
    }
    setElapsed(Date.now() - agentStartedAt);
    const id = window.setInterval(() => {
      setElapsed(Date.now() - agentStartedAt);
    }, 1000);
    return () => window.clearInterval(id);
  }, [agentStatus, agentStartedAt]);

  // Global Cmd+K / Ctrl+K to open palette; Cmd+Shift+K / Ctrl+Shift+K jumps
  // straight into agent mode (and opens the palette if it was closed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        if (e.shiftKey) {
          setOpen(true);
          setAgentMode(true);
          setAskMode(false);
          return;
        }
        setOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset cursor when list changes
  useEffect(() => {
    setCursor(0);
  }, [query, open]);

  // Auto-focus inputs
  useEffect(() => {
    if (!open) return;
    if (agentMode) {
      agentRef.current?.focus();
    } else if (askMode) {
      askRef.current?.focus();
    } else {
      searchRef.current?.focus();
    }
  }, [open, askMode, agentMode]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (agentMode) {
          // Don't abort a running agent on Escape — that would be too easy
          // to trigger by accident. Just leave agent mode; the run continues
          // in the store and the user can reopen to stop it.
          setAgentMode(false);
          return;
        }
        if (askMode) {
          setAskMode(false);
          setAskResult(null);
          return;
        }
        close();
        return;
      }
      if (askMode || agentMode) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor(c => (visible.length === 0 ? 0 : (c + 1) % visible.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(c => (visible.length === 0 ? 0 : (c - 1 + visible.length) % visible.length));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = visible[cursor];
        if (cmd) run(cmd);
      }
    },
    [askMode, agentMode, close, visible, cursor, run],
  );

  const onAskKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !askBusy) {
        e.preventDefault();
        void submitAsk();
      }
    },
    [askBusy, submitAsk],
  );

  if (!open) return null;

  const showRecentLabel = query.trim() === '' && recent.length > 0;
  const isRunning = agentStatus === 'running';
  const showFinal = agentStatus === 'done' && agentFinalAnswer.length > 0;
  const placeholder = isRunning ? 'Running…' : 'Tell SUNNY what to do…';

  return (
    <div
      className="cmdk-backdrop"
      onClick={close}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="cmdk-panel" onClick={e => e.stopPropagation()}>
        <div className="cmdk-head">
          <h2>{agentMode ? 'AGENT' : askMode ? 'ASK' : 'COMMAND'}</h2>
          <button type="button" onClick={close} aria-label="Close">×</button>
        </div>

        {agentMode ? (
          <div className="cmdk-agent">
            <div className="cmdk-agent-row">
              <input
                ref={agentRef}
                className="cmdk-input cmdk-input-agent"
                type="text"
                placeholder={placeholder}
                value={isRunning ? agentGoal : agentInput}
                onChange={e => setAgentInput(e.target.value)}
                onKeyDown={onAgentKeyDown}
                disabled={isRunning}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="cmdk-agent-meta">
                <span className="cmdk-agent-timer">{formatElapsed(elapsed)}</span>
                {isRunning && (
                  <button
                    type="button"
                    className="cmdk-agent-stop"
                    onClick={stopAgent}
                    aria-label="Stop agent"
                  >
                    STOP
                  </button>
                )}
              </div>
            </div>

            <div className="cmdk-agent-hint">
              {isRunning
                ? `Step ${agentSteps.length} · status: RUNNING`
                : agentStatus === 'aborted'
                  ? 'Aborted. Press Enter to run a new goal.'
                  : agentStatus === 'error'
                    ? 'Error. Press Enter to try again.'
                    : agentStatus === 'done'
                      ? 'Done.'
                      : 'Enter to run · Esc to exit (run continues) · ⌘⇧K toggles agent'}
            </div>

            {agentSteps.length > 0 && (
              <div className="cmdk-agent-steps" role="log" aria-live="polite">
                {agentSteps.map(step => (
                  <div key={step.id} className={`cmdk-agent-step step-${step.kind}`}>
                    <span className="cmdk-agent-step-kind">{step.kind}</span>
                    <span className="cmdk-agent-step-text">
                      {step.toolName ? `[${step.toolName}] ` : ''}
                      {step.text}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {showFinal && (
              <div className="cmdk-agent-final">
                <div className="cmdk-agent-final-body">{agentFinalAnswer}</div>
                <button
                  type="button"
                  className="cmdk-agent-clear"
                  onClick={clearAgent}
                >
                  CLEAR
                </button>
              </div>
            )}
          </div>
        ) : askMode ? (
          <div className="cmdk-ask">
            <input
              ref={askRef}
              className="cmdk-input"
              type="text"
              placeholder="Ask SUNNY anything…"
              value={askInput}
              onChange={e => setAskInput(e.target.value)}
              onKeyDown={onAskKeyDown}
              disabled={askBusy}
            />
            <div className="cmdk-ask-hint">
              {askBusy ? 'Thinking…' : 'Enter to send · Esc to cancel'}
            </div>
            {askResult !== null && (
              <div className="cmdk-ask-result">{askResult}</div>
            )}
          </div>
        ) : (
          <>
            <input
              ref={searchRef}
              className="cmdk-input"
              type="text"
              placeholder="Search commands…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="cmdk-list" role="listbox">
              {showRecentLabel && (
                <div className="cmdk-section">RECENT</div>
              )}
              {visible.length === 0 ? (
                <div className="cmdk-empty">No commands match “{query}”.</div>
              ) : (
                visible.map((cmd, i) => (
                  <button
                    key={cmd.id}
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    className={`cmdk-item${i === cursor ? ' active' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => run(cmd)}
                  >
                    <span className="cmdk-title">{cmd.title}</span>
                    <span className={`cmdk-chip chip-${cmd.category.toLowerCase()}`}>{cmd.category}</span>
                  </button>
                ))
              )}
            </div>
            <div className="cmdk-foot">
              <span>↑↓ navigate</span>
              <span>↵ run</span>
              <span>⌘⇧K agent</span>
              <span>esc close</span>
            </div>
          </>
        )}
      </div>

      <style>{CMDK_CSS}</style>
    </div>
  );
}
