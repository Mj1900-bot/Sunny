/**
 * CONSOLE — developer REPL for Sunny's sandboxes.
 *
 * Two REPL tabs: python (pysandbox) and shell (run_shell).
 * Features: syntax highlighting, Up/Down history navigation, saved snippets,
 * env badge (Python version + zsh path).
 */

import { useCallback, useEffect, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, StatBlock, TabBar, ToolbarButton, usePoll,
  KeyHint,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { ReplPane } from './ReplPane';
import { SnippetsPanel } from './SnippetsPanel';
import { pyRun, pyVersion, shellRun, type PyResult, type ShellResult } from './api';
import { getSnippets, type Snippet } from './snippets';

type Tab = 'py' | 'sh';
type PaneTab = 'repl' | 'snippets';

export type HistoryEntry = {
  lang: Tab;
  code: string;
  out: PyResult | ShellResult;
  at: number;
  duration_ms: number;
  error?: string;
};

function sessionLogText(entries: HistoryEntry[]): string {
  return entries.map((h, idx) => {
    const ms = 'duration_ms' in h.out && h.out.duration_ms ? h.out.duration_ms : h.duration_ms;
    const bits = [
      `## ${idx + 1}. ${h.lang.toUpperCase()} · exit ${h.out.exit_code} · ${ms}ms · ${new Date(h.at).toISOString()}`,
      '',
      '```',
      h.code,
      '```',
    ];
    if (h.out.stdout) bits.push('', 'stdout:', h.out.stdout);
    if (h.out.stderr) bits.push('', 'stderr:', h.out.stderr);
    if (h.error) bits.push('', `invoke: ${h.error}`);
    return bits.join('\n');
  }).join('\n\n---\n\n');
}

export function ConsolePage() {
  const [tab, setTab] = useState<Tab>('py');
  const [pane, setPane] = useState<PaneTab>('repl');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sessionFlash, setSessionFlash] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<ReadonlyArray<Snippet>>(getSnippets);
  const [shellPath, setShellPath] = useState<string | null>(null);
  const { data: version } = usePoll(pyVersion, 120_000);

  // Fetch zsh path once on mount.
  useEffect(() => {
    void shellRun('which zsh').then(r => {
      if (r && r.exit_code === 0) setShellPath(r.stdout.trim());
    });
  }, []);

  const refreshSnippets = useCallback(() => {
    setSnippets(getSnippets());
  }, []);

  const append = useCallback((entry: HistoryEntry) => {
    setHistory(prev => [...prev, entry]);
  }, []);

  const runPy = useCallback(async (code: string) => {
    const t0 = performance.now();
    try {
      const out = await pyRun(code);
      if (out) {
        append({ lang: 'py', code, out, at: Date.now(), duration_ms: Math.round(performance.now() - t0) });
      }
    } catch (e) {
      append({
        lang: 'py', code, at: Date.now(),
        out: { stdout: '', stderr: '', exit_code: -1, duration_ms: 0, truncated: false },
        duration_ms: Math.round(performance.now() - t0),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [append]);

  const runSh = useCallback(async (code: string) => {
    const t0 = performance.now();
    try {
      const out = await shellRun(code);
      if (out) {
        append({ lang: 'sh', code, out, at: Date.now(), duration_ms: Math.round(performance.now() - t0) });
      }
    } catch (e) {
      append({
        lang: 'sh', code, at: Date.now(),
        out: { stdout: '', stderr: '', exit_code: -1 },
        duration_ms: Math.round(performance.now() - t0),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [append]);

  // ⌘K clears history, ⌘/ toggles tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (e.key.toLowerCase() === 'k' && !inField) {
        e.preventDefault(); setHistory([]);
      }
      if (e.key === '/') {
        e.preventDefault(); setTab(p => p === 'py' ? 'sh' : 'py');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const lastOut = history[history.length - 1];
  const tabSnippets = snippets.filter(s => s.lang === tab);

  const copyFullSession = useCallback(async () => {
    if (history.length === 0) return;
    const ok = await copyToClipboard(sessionLogText(history));
    setSessionFlash(ok ? 'Full session copied' : 'Copy failed');
    window.setTimeout(() => setSessionFlash(null), 2200);
  }, [history]);

  return (
    <ModuleView title="CONSOLE · REPL">
      <PageGrid>
        {/* Env stats */}
        <PageCell span={12}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
            gap: 10,
          }}>
            <StatBlock label="PYTHON" value={version ? version.replace(/^Python /, '') : '—'} tone="cyan" />
            <StatBlock label="SHELL" value={shellPath ? shellPath.split('/').pop() ?? '—' : '—'} sub={shellPath ?? undefined} tone="amber" />
            <StatBlock label="RUNS" value={String(history.length)} tone="violet" />
            <StatBlock label="FAILED" value={String(history.filter(h => h.out.exit_code !== 0).length)} tone="red" />
            <StatBlock label="LAST" value={lastOut ? `${lastOut.lang.toUpperCase()} ${lastOut.out.exit_code}` : '—'} tone={lastOut?.out.exit_code === 0 ? 'green' : 'red'} />
          </div>
        </PageCell>

        <PageCell span={12}>
          <div style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <TabBar
                value={tab}
                onChange={t => { setTab(t); setPane('repl'); }}
                tabs={[
                  { id: 'py', label: 'PYTHON', count: history.filter(h => h.lang === 'py').length },
                  { id: 'sh', label: 'SHELL',  count: history.filter(h => h.lang === 'sh').length },
                ]}
              />
            </div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              paddingBottom: 6,
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink-dim)',
              letterSpacing: '0.06em',
            }}>
              <span style={{ fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.2em', color: 'var(--ink-2)' }}>SHORTCUTS</span>
              <KeyHint>⌘/</KeyHint>
              <span>switch tab</span>
              <KeyHint>⌘K</KeyHint>
              <span>clear history</span>
              <ToolbarButton
                tone="gold"
                disabled={history.length === 0}
                onClick={() => { void copyFullSession(); }}
              >COPY SESSION</ToolbarButton>
              {sessionFlash && (
                <span style={{ color: 'var(--cyan)', fontFamily: 'var(--mono)', fontSize: 10 }}>{sessionFlash}</span>
              )}
            </div>
          </div>
        </PageCell>

        <PageCell span={12}>
          <Section
            title={tab === 'py' ? 'PYTHON (pysandbox)' : 'SHELL (run_shell)'}
            right={
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <ToolbarButton
                  active={pane === 'snippets'}
                  tone="amber"
                  onClick={() => setPane(p => p === 'snippets' ? 'repl' : 'snippets')}
                >SNIPPETS{tabSnippets.length > 0 ? ` · ${tabSnippets.length}` : ''}</ToolbarButton>
                <ToolbarButton
                  disabled={history.length === 0}
                  onClick={() => setHistory([])}
                >CLEAR · ⌘K</ToolbarButton>
                <ToolbarButton
                  tone="violet"
                  onClick={() => askSunny(
                    `Write a ${tab === 'py' ? 'Python' : 'zsh'} snippet to help me accomplish what I'm doing right now. Consider my current world state.`,
                    'console',
                  )}
                >ASK SUNNY</ToolbarButton>
              </div>
            }
          >
            {pane === 'snippets' ? (
              <SnippetsPanel
                snippets={snippets}
                lang={tab}
                onRecall={(code) => { setPane('repl'); /* ReplPane will receive via tab */ void (tab === 'py' ? runPy(code) : runSh(code)); }}
                onDeleted={refreshSnippets}
              />
            ) : (
              <ReplPane
                lang={tab}
                onRun={tab === 'py' ? runPy : runSh}
                history={history}
                onSnippetSaved={refreshSnippets}
              />
            )}
          </Section>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
