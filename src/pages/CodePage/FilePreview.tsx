/**
 * FilePreview — premium file viewer with:
 *  · Line-numbered code preview
 *  · Syntax-aware diff coloring (green +lines, red -lines)
 *  · BLAME mode (git blame)
 *  · In-file search with match count
 *  · File stats bar (lines, bytes)
 *  · COPY PATH / COPY FILE / AI EXPLAIN
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Section, Chip, Toolbar, ToolbarButton, EmptyState } from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import { readFile, fileDiff, blameFile, fileStat } from './api';

type Mode = 'content' | 'diff' | 'blame';

function extBadge(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i + 1).toUpperCase() : 'FILE';
}

function badgeTone(path: string): 'cyan' | 'amber' | 'gold' | 'violet' | 'green' | 'dim' {
  const e = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx'].includes(e)) return 'cyan';
  if (['js', 'jsx', 'py'].includes(e)) return 'amber';
  if (e === 'rs' || e === 'toml') return 'gold';
  if (['json', 'yaml', 'yml'].includes(e)) return 'violet';
  if (['md', 'txt'].includes(e)) return 'dim';
  return 'cyan';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function FilePreview({
  root, path,
}: {
  root: string;
  path: string | null;
}) {
  const [mode, setMode] = useState<Mode>('content');
  const [content, setContent] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [blame, setBlame] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copyFlash, setCopyFlash] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!path) { setContent(null); setDiff(null); setBlame(null); setErr(null); setFileSize(0); return; }
    setLoading(true);
    setErr(null);
    setSearchQuery('');
    const p = path;
    const both = Promise.all([
      readFile(root, p),
      fileDiff(root, p),
      blameFile(root, p),
      fileStat(root, p),
    ]);
    both.then(([c, d, b, s]) => {
      setContent(c);
      setDiff(d);
      setBlame(b);
      setFileSize(s);
    }).catch(e => {
      setErr(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      setLoading(false);
    });
  }, [root, path]);

  // ⌘G toggles in-file search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        setSearchOpen(o => !o);
        window.setTimeout(() => searchRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const flash = useCallback((msg: string) => {
    setCopyFlash(msg);
    window.setTimeout(() => setCopyFlash(null), 2200);
  }, []);

  if (!path) {
    return (
      <EmptyState
        title="SELECT A FILE"
        hint="Choose a path in the file tree to load contents here. Toggle CONTENT / DIFF / BLAME once a file is open."
      />
    );
  }

  const badge = extBadge(path);
  const tone = badgeTone(path);
  const text = mode === 'diff' ? (diff ?? '') : mode === 'blame' ? (blame ?? '') : (content ?? '');
  const filename = path.split('/').pop() ?? path;
  const fullPath = `${root.replace(/\/*$/, '')}/${path.replace(/^\//, '')}`;

  const lineCount = (content ?? '').split('\n').length;

  const copyPath = async () => {
    const ok = await copyToClipboard(fullPath);
    flash(ok ? 'Path copied' : 'Copy failed');
  };

  const copyView = async () => {
    const ok = await copyToClipboard(text || '');
    flash(ok ? `${mode === 'diff' ? 'Diff' : mode === 'blame' ? 'Blame' : 'Content'} copied` : 'Copy failed');
  };

  const handleExplain = () => {
    const snippet = (content ?? '').slice(0, 3000);
    askSunny(
      `Explain this file in 3–4 sentences. What does it do, what's its role in the codebase, ` +
      `and any notable patterns or concerns?\n\nFile: ${path}\n\n${snippet}`,
      'code',
    );
  };

  // Search match count
  const matchCount = useMemo(() => {
    if (!searchQuery.trim() || !text) return 0;
    const q = searchQuery.toLowerCase();
    let count = 0;
    let idx = 0;
    const lower = text.toLowerCase();
    while (true) {
      idx = lower.indexOf(q, idx);
      if (idx === -1) break;
      count++;
      idx += q.length;
    }
    return count;
  }, [searchQuery, text]);

  return (
    <Section
      title={filename}
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Chip tone={tone}>{badge}</Chip>
          {copyFlash && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--cyan)' }}>{copyFlash}</span>
          )}
        </div>
      }
    >
      {/* Mode toolbar */}
      <Toolbar>
        <ToolbarButton active={mode === 'content'} onClick={() => setMode('content')} tone="cyan">CONTENT</ToolbarButton>
        <ToolbarButton active={mode === 'diff'} onClick={() => setMode('diff')} tone="amber">DIFF</ToolbarButton>
        <ToolbarButton active={mode === 'blame'} onClick={() => setMode('blame')} tone="violet">BLAME</ToolbarButton>
        <ToolbarButton tone="gold" onClick={() => { void copyPath(); }}>COPY PATH</ToolbarButton>
        <ToolbarButton tone="teal" onClick={() => { void copyView(); }}>
          COPY {mode === 'diff' ? 'DIFF' : mode === 'blame' ? 'BLAME' : 'FILE'}
        </ToolbarButton>
        <ToolbarButton tone="green" onClick={handleExplain} disabled={!content}>AI EXPLAIN</ToolbarButton>
        <ToolbarButton
          tone="pink"
          onClick={() => { setSearchOpen(o => !o); window.setTimeout(() => searchRef.current?.focus(), 50); }}
          active={searchOpen}
        >⌘G SEARCH</ToolbarButton>
      </Toolbar>

      {/* File stats bar */}
      {!loading && !err && content !== null && (
        <div style={{
          display: 'flex', gap: 14, padding: '4px 10px', marginTop: 4,
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
          letterSpacing: '0.08em',
          borderBottom: '1px solid var(--line-soft)',
        }}>
          <span>{lineCount} lines</span>
          <span>{(content ?? '').length.toLocaleString()} chars</span>
          {fileSize > 0 && <span>{formatBytes(fileSize)}</span>}
          <span style={{ marginLeft: 'auto', color: 'var(--ink-dim)' }}>{path}</span>
        </div>
      )}

      {/* In-file search */}
      {searchOpen && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px',
          borderBottom: '1px solid var(--line-soft)',
          background: 'rgba(57, 229, 255, 0.03)',
          animation: 'fadeSlideIn 120ms ease-out',
        }}>
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search in file…"
            aria-label="Search in file"
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
              background: 'rgba(0, 0, 0, 0.3)',
              border: '1px solid var(--line-soft)',
              padding: '4px 8px',
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); }
            }}
          />
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: matchCount > 0 ? 'var(--cyan)' : 'var(--ink-dim)',
          }}>
            {searchQuery.trim() ? `${matchCount} match${matchCount !== 1 ? 'es' : ''}` : ''}
          </span>
        </div>
      )}

      {loading && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', padding: 8 }}>
          loading…
        </div>
      )}
      {err && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
          padding: '6px 10px', border: '1px solid var(--red)',
          background: 'rgba(255,77,94,0.06)',
        }}>{err}</div>
      )}
      {!loading && !err && (
        <CodeBlock text={text} mode={mode} searchQuery={searchQuery} />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Code block with line numbers and diff coloring
// ---------------------------------------------------------------------------

function CodeBlock({
  text, mode, searchQuery,
}: {
  text: string;
  mode: Mode;
  searchQuery: string;
}) {
  const lines = (text || '(empty)').split('\n');
  const q = searchQuery.trim().toLowerCase();

  return (
    <div style={{
      display: 'flex',
      maxHeight: 440, overflow: 'auto',
      background: 'rgba(0,0,0,0.35)', border: '1px solid var(--line-soft)',
    }}>
      {/* Line numbers gutter */}
      <div
        aria-hidden
        style={{
          display: 'flex', flexDirection: 'column',
          padding: '8px 0',
          borderRight: '1px solid var(--line-soft)',
          userSelect: 'none',
          flexShrink: 0,
          background: 'rgba(0,0,0,0.15)',
        }}
      >
        {lines.map((_, i) => (
          <span
            key={i}
            style={{
              display: 'block',
              fontFamily: 'var(--mono)', fontSize: 10.5,
              color: 'var(--ink-dim)',
              textAlign: 'right',
              padding: '0 8px 0 6px',
              lineHeight: '1.55',
              minWidth: 28,
              opacity: 0.6,
            }}
          >
            {i + 1}
          </span>
        ))}
      </div>

      {/* Code content */}
      <pre style={{
        margin: 0, padding: '8px 10px',
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
        whiteSpace: 'pre', wordBreak: 'break-all',
        lineHeight: 1.55,
        flex: 1, minWidth: 0,
        overflowX: 'auto',
      }}>
        {lines.map((line, i) => {
          const isDiffMode = mode === 'diff';
          const isAdd = isDiffMode && line.startsWith('+') && !line.startsWith('+++');
          const isDel = isDiffMode && line.startsWith('-') && !line.startsWith('---');
          const isHunk = isDiffMode && line.startsWith('@@');

          const hasMatch = q && line.toLowerCase().includes(q);

          let bg = 'transparent';
          let color = 'var(--ink)';
          if (isAdd) { bg = 'rgba(125, 255, 154, 0.08)'; color = 'var(--green)'; }
          else if (isDel) { bg = 'rgba(255, 77, 94, 0.08)'; color = 'var(--red)'; }
          else if (isHunk) { bg = 'rgba(57, 229, 255, 0.06)'; color = 'var(--cyan)'; }
          if (hasMatch) { bg = 'rgba(255, 215, 0, 0.12)'; }

          return (
            <div
              key={i}
              style={{
                background: bg,
                color,
                paddingRight: 8,
                borderLeft: isAdd ? '2px solid var(--green)' : isDel ? '2px solid var(--red)' : '2px solid transparent',
              }}
            >
              {hasMatch ? highlightMatches(line, q) : line || '\u00A0'}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/** Highlight search matches in a line. */
function highlightMatches(line: string, query: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const lower = line.toLowerCase();
  let lastIdx = 0;
  let key = 0;
  let idx = lower.indexOf(query, 0);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(line.slice(lastIdx, idx));
    parts.push(
      <mark key={key++} style={{
        background: 'rgba(255, 215, 0, 0.35)',
        color: '#fff',
        padding: '0 1px',
        borderRadius: 1,
      }}>
        {line.slice(idx, idx + query.length)}
      </mark>,
    );
    lastIdx = idx + query.length;
    idx = lower.indexOf(query, lastIdx);
  }
  if (lastIdx < line.length) parts.push(line.slice(lastIdx));
  return <>{parts}</>;
}
