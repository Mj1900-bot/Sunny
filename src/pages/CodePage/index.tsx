/**
 * CODE — premium single-repo developer command centre.
 *
 * Points at a configurable repo root and surfaces:
 *   · Animated stat dashboard with branch coloring + last commit age
 *   · Recent repos quick-switch (last 5)
 *   · File tree with dirty indicators and type icons
 *   · File preview with line numbers, diff coloring, blame, search
 *   · Commit timeline with type coloring and expandable details
 *   · Status pane with click-to-preview integration
 *   · Repo insights (language breakdown, activity heatmap)
 *   · AI BRIEF + ⌘P quick file open
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, ScrollList,
  Toolbar, ToolbarButton, usePoll, KeyHint, useDebounced,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { StatusLine, StatusSummary } from './RepoCard';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { CommitLog } from './CommitLog';
import { RepoInsights } from './RepoInsights';
import {
  buildReport, loadRoot, saveRoot, listFiles, commitLog, buildAiBriefPrompt,
  loadRecentRoots,
  type CommitEntry,
} from './api';

/** Color the branch name: green for main/master, violet for feature branches, amber otherwise. */
function branchTone(branch: string): 'green' | 'violet' | 'amber' | 'red' {
  const lower = branch.toLowerCase();
  if (lower === 'main' || lower === 'master') return 'green';
  if (lower.startsWith('feature') || lower.startsWith('feat/')) return 'violet';
  if (lower.includes('detached')) return 'red';
  return 'amber';
}

/** Format last-commit age from relDate string. */
function lastCommitAge(commits: ReadonlyArray<CommitEntry>): string {
  return commits.length > 0 ? commits[0].relDate : '—';
}

export function CodePage() {
  const [root, setRoot] = useState(loadRoot);
  const [draft, setDraft] = useState(root);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [files, setFiles] = useState<ReadonlyArray<string>>([]);
  const [commits, setCommits] = useState<ReadonlyArray<CommitEntry>>([]);
  const [commitCount, setCommitCount] = useState(25);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [showInsights, setShowInsights] = useState(false);
  const debouncedFilter = useDebounced(fileFilter, 180);
  const fileFilterRef = useRef<HTMLInputElement | null>(null);
  const recentRoots = useMemo(() => loadRecentRoots().filter(r => r !== root), [root]);

  const { data: report, loading, error, reload } = usePoll(
    () => buildReport(root),
    15_000,
    [root],
  );

  useEffect(() => { saveRoot(root); }, [root]);

  // Load file tree + commit log whenever root changes or repo is confirmed to exist.
  const repoExists = report?.exists ?? false;
  useEffect(() => {
    if (!repoExists) { setFiles([]); setCommits([]); return; }
    void listFiles(root).then(setFiles);
    setCommitsLoading(true);
    void commitLog(root, commitCount).then(c => {
      setCommits(c);
      setCommitsLoading(false);
    });
  }, [root, repoExists, commitCount]);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== root) { setRoot(v); setSelectedFile(null); }
  };

  const handleAiBrief = useCallback(async () => {
    setBriefBusy(true);
    try {
      const branch = report?.branch ?? '';
      const prompt = await buildAiBriefPrompt(root, branch);
      askSunny(prompt, 'code');
    } finally {
      setBriefBusy(false);
    }
  }, [root, report]);

  const handleLoadMore = useCallback(() => {
    setCommitCount(prev => prev + 25);
  }, []);

  const switchRoot = useCallback((newRoot: string) => {
    setDraft(newRoot);
    setRoot(newRoot);
    setSelectedFile(null);
    setFileFilter('');
  }, []);

  // Click status line → select that file for preview
  const handleStatusSelect = useCallback((path: string) => {
    setSelectedFile(path);
  }, []);

  // ⌘P focuses file filter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'p') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      fileFilterRef.current?.focus();
      fileFilterRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dirty = report?.statusLines.length ?? 0;
  const total = report?.totalCommits ?? 0;
  const stale = !report || !report.exists;
  const branch = report?.branch ?? '—';

  const visibleFiles = useMemo(() => {
    const q = debouncedFilter.trim().toLowerCase();
    if (!q) return files;
    return files.filter(f => f.toLowerCase().includes(q));
  }, [files, debouncedFilter]);

  useEffect(() => {
    if (selectedFile && !visibleFiles.includes(selectedFile)) setSelectedFile(null);
  }, [selectedFile, visibleFiles]);

  const filesRight = debouncedFilter.trim()
    ? `${visibleFiles.length} / ${files.length} match`
    : `${files.length} tracked`;

  return (
    <ModuleView title="CODE · REPOSITORY">
      <PageGrid>
        {/* Stats row */}
        <PageCell span={12}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 10,
            animation: 'fadeSlideIn 200ms ease-out',
          }}>
            <StatBlock label="ROOT" value={root.split('/').pop() || root} sub={root} tone="cyan" />
            <StatBlock label="BRANCH" value={branch} tone={branchTone(branch)} />
            <StatBlock label="DIRTY" value={String(dirty)} tone={stale ? 'red' : dirty > 0 ? 'amber' : 'green'} />
            <StatBlock label="FILES" value={String(files.length)} sub="tracked" tone="teal" />
            <StatBlock label="COMMITS" value={String(total)} sub="HEAD total" tone="gold" />
            <StatBlock label="LAST COMMIT" value={lastCommitAge(commits)} tone="violet" />
          </div>
        </PageCell>

        {/* Status summary chips */}
        {dirty > 0 && report && (
          <PageCell span={12}>
            <StatusSummary statusLines={report.statusLines} />
          </PageCell>
        )}

        {/* Toolbar */}
        <PageCell span={12}>
          <Toolbar>
            <div style={{ flex: 1, minWidth: 160 }}>
              <input
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commit(); }
                  if (e.key === 'Escape') { e.preventDefault(); setDraft(root); }
                }}
                placeholder="/path/to/git/repo"
                aria-label="Git repository root path"
                autoComplete="off"
                spellCheck={false}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <ToolbarButton onClick={() => switchRoot('~/Sunny Ai')}>~/Sunny Ai</ToolbarButton>
            <ToolbarButton onClick={reload} tone="cyan">REFRESH</ToolbarButton>
            <ToolbarButton
              tone="violet"
              disabled={briefBusy || !repoExists}
              onClick={() => { void handleAiBrief(); }}
            >{briefBusy ? 'BRIEFING…' : 'AI BRIEF'}</ToolbarButton>
            <ToolbarButton
              tone="teal"
              active={showInsights}
              onClick={() => setShowInsights(o => !o)}
            >{showInsights ? '✕ INSIGHTS' : '◈ INSIGHTS'}</ToolbarButton>
          </Toolbar>

          {/* Recent repos + key hints */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            marginTop: 8,
            fontFamily: 'var(--mono)', fontSize: 10,
            color: 'var(--ink-dim)',
            letterSpacing: '0.06em',
          }}>
            {recentRoots.length > 0 && (
              <>
                <span style={{
                  fontFamily: 'var(--display)',
                  fontSize: 8,
                  letterSpacing: '0.18em',
                  color: 'var(--ink-dim)',
                  fontWeight: 700,
                }}>RECENT</span>
                {recentRoots.map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => switchRoot(r)}
                    style={{
                      all: 'unset', cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 10,
                      color: 'var(--cyan)',
                      padding: '2px 6px',
                      border: '1px solid var(--line-soft)',
                      background: 'rgba(57, 229, 255, 0.04)',
                      transition: 'background 100ms ease',
                    }}
                    title={r}
                  >
                    {r.split('/').pop() || r}
                  </button>
                ))}
                <span style={{ borderLeft: '1px solid var(--line-soft)', height: 14 }} />
              </>
            )}
            <KeyHint>Enter</KeyHint>
            <span>apply path</span>
            <KeyHint>Esc</KeyHint>
            <span>revert</span>
            <KeyHint>⌘P</KeyHint>
            <span>filter files</span>
          </div>
        </PageCell>

        {(error || (report && report.errors.length > 0)) && (
          <PageCell span={12}>
            <div role="alert" style={{
              border: '1px solid var(--red)', borderLeft: '3px solid var(--red)',
              padding: '10px 12px',
              borderRadius: 2,
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
              background: 'rgba(255, 77, 94, 0.06)', whiteSpace: 'pre-wrap',
              lineHeight: 1.45,
            }}>
              {error ?? report?.errors.join('\n')}
            </div>
          </PageCell>
        )}

        {/* Insights panel (collapsible) */}
        {showInsights && repoExists && (
          <PageCell span={12}>
            <RepoInsights files={files} commits={commits} />
          </PageCell>
        )}

        {/* File tree (left) + Preview pane (right) */}
        <PageCell span={4}>
          <Section title="FILES" right={filesRight}>
            <div style={{ marginBottom: 6 }}>
              <input
                ref={fileFilterRef}
                type="text"
                value={fileFilter}
                onChange={e => setFileFilter(e.target.value)}
                placeholder="Filter paths… (⌘P)"
                aria-label="Filter file tree"
                autoComplete="off"
                spellCheck={false}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            {loading && !report ? (
              <EmptyState title="Loading…" />
            ) : !repoExists ? (
              <EmptyState title="Not a git repo" hint="Point root above at a directory with .git/" />
            ) : files.length === 0 ? (
              <EmptyState title="No files" hint="Empty or untracked repo." />
            ) : visibleFiles.length === 0 ? (
              <EmptyState title="No paths match" hint="Clear the filter or try another substring." />
            ) : (
              <ScrollList maxHeight={380}>
                <FileTree
                  paths={visibleFiles}
                  selected={selectedFile}
                  onSelect={setSelectedFile}
                  statusLines={report?.statusLines}
                />
              </ScrollList>
            )}
          </Section>
        </PageCell>

        <PageCell span={8}>
          <FilePreview root={root} path={selectedFile} />
        </PageCell>

        {/* Status + Commit history */}
        <PageCell span={5}>
          <Section title="STATUS" right={`${dirty} file${dirty === 1 ? '' : 's'}`}>
            {loading && !report ? (
              <EmptyState title="Loading…" />
            ) : !repoExists || !report ? (
              <EmptyState title="Not a git repo" hint="Point the root above at a directory that contains .git/." />
            ) : report.statusLines.length === 0 ? (
              <EmptyState title="Working tree clean" hint="Nothing to commit." />
            ) : (
              <ScrollList maxHeight={280}>
                {report.statusLines.map((line, i) => (
                  <StatusLine
                    key={i}
                    raw={line}
                    index={i}
                    onSelect={handleStatusSelect}
                  />
                ))}
              </ScrollList>
            )}
          </Section>
        </PageCell>

        <PageCell span={7}>
          <CommitLog
            entries={commits}
            loading={commitsLoading}
            root={root}
            onLoadMore={commits.length >= commitCount ? handleLoadMore : undefined}
          />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
