import { useCallback, useEffect, useRef, useState } from 'react';
import { Chip, Toolbar, ToolbarButton } from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import type { PyResult, ShellResult } from './api';
import { tokenise, TOKEN_COLOR } from './syntaxHighlight';
import { saveSnippet } from './snippets';

type Entry = {
  lang: 'py' | 'sh';
  code: string;
  out: PyResult | ShellResult;
  at: number;
  duration_ms: number;
  error?: string;
};

/** Highlight a code string inline in a <pre>. */
function HighlightedCode({ code, lang }: { code: string; lang: 'py' | 'sh' }) {
  const tokens = tokenise(code, lang);
  return (
    <pre style={{
      margin: 0,
      fontFamily: 'var(--mono)', fontSize: 11,
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      maxHeight: 160, overflow: 'auto',
    }}>
      {tokens.map((tok, i) => (
        <span key={i} style={{ color: TOKEN_COLOR[tok.kind] }}>{tok.text}</span>
      ))}
    </pre>
  );
}

export function ReplPane({
  lang, onRun, history, onSnippetSaved,
}: {
  lang: 'py' | 'sh';
  onRun: (code: string) => Promise<void>;
  history: ReadonlyArray<Entry>;
  onSnippetSaved?: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [histCursor, setHistCursor] = useState<number | null>(null);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const filtered = history.filter(h => h.lang === lang);

  // Focus on mount / tab switch.
  useEffect(() => {
    taRef.current?.focus();
    setHistCursor(null);
  }, [lang]);

  const copyRunBlock = useCallback(async (h: Entry) => {
    const ms = 'duration_ms' in h.out && h.out.duration_ms ? h.out.duration_ms : h.duration_ms;
    const bits = [
      `${h.lang.toUpperCase()} · exit ${h.out.exit_code} · ${ms}ms · ${new Date(h.at).toLocaleString()}`,
      '',
      '── code ──',
      h.code,
    ];
    if (h.out.stdout) bits.push('', '── stdout ──', h.out.stdout);
    if (h.out.stderr) bits.push('', '── stderr ──', h.out.stderr);
    if (h.error) bits.push('', '── invoke error ──', h.error);
    const ok = await copyToClipboard(bits.join('\n'));
    if (ok) {
      setCopiedAt(h.at);
      window.setTimeout(() => setCopiedAt(t => (t === h.at ? null : t)), 2000);
    }
  }, []);

  const submit = async () => {
    const t = code.trim();
    if (!t) return;
    setBusy(true);
    try { await onRun(t); setCode(''); setHistCursor(null); }
    finally { setBusy(false); }
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault(); void submit();
      return;
    }
    // Up arrow — walk back through history
    if (e.key === 'ArrowUp' && filtered.length > 0) {
      e.preventDefault();
      const next = histCursor === null
        ? filtered.length - 1
        : Math.max(0, histCursor - 1);
      setHistCursor(next);
      setCode(filtered[next].code);
      return;
    }
    // Down arrow — walk forward
    if (e.key === 'ArrowDown' && filtered.length > 0) {
      e.preventDefault();
      if (histCursor === null) return;
      if (histCursor >= filtered.length - 1) {
        setHistCursor(null);
        setCode('');
      } else {
        const next = histCursor + 1;
        setHistCursor(next);
        setCode(filtered[next].code);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, histCursor]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(0, 0, 0, 0.45)',
        padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <textarea
          ref={taRef}
          value={code}
          onChange={e => { setCode(e.target.value); setHistCursor(null); }}
          onKeyDown={handleKeyDown}
          rows={5}
          spellCheck={false}
          placeholder={lang === 'py' ? `# python — ⌘⏎ to run · ↑↓ history\n` : `# zsh — ⌘⏎ to run · ↑↓ history\n`}
          aria-label={lang === 'py' ? 'python code' : 'shell command'}
          style={{
            all: 'unset', boxSizing: 'border-box', width: '100%',
            padding: '8px 10px',
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
            background: 'transparent',
          }}
        />
        <Toolbar>
          <ToolbarButton tone="cyan" onClick={submit} disabled={!code.trim() || busy}>RUN · ⌘⏎</ToolbarButton>
          <ToolbarButton onClick={() => { setCode(''); setHistCursor(null); }} disabled={!code}>CLEAR</ToolbarButton>
          {histCursor !== null && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
              history {histCursor + 1}/{filtered.length}
            </span>
          )}
        </Toolbar>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.length === 0 && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            padding: '14px 16px',
            border: '1px dashed var(--line-soft)',
            background: 'rgba(57, 229, 255, 0.02)',
            lineHeight: 1.5,
            letterSpacing: '0.04em',
          }}>
            No runs for this tab yet. Enter code above and press <span style={{ color: 'var(--cyan)' }}>⌘⏎</span> — output and timings appear here, newest first.
          </div>
        )}
        {filtered.slice().reverse().map((h, i) => {
          const ok = h.out.exit_code === 0 && !h.error;
          const ms = 'duration_ms' in h.out && h.out.duration_ms
            ? h.out.duration_ms
            : h.duration_ms;
          return (
            <div key={`${h.at}-${i}`} style={{
              border: '1px solid var(--line-soft)',
              borderLeft: `2px solid var(--${ok ? 'green' : 'red'})`,
              background: 'rgba(6, 14, 22, 0.6)',
              padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Chip tone={ok ? 'green' : 'red'}>EXIT {h.out.exit_code}</Chip>
                <Chip tone="dim">{ms}ms</Chip>
                <ToolbarButton
                  tone="amber"
                  onClick={() => {
                    saveSnippet(h.lang, h.code);
                    onSnippetSaved?.();
                  }}
                >SAVE</ToolbarButton>
                <ToolbarButton tone="gold" onClick={() => { void copyRunBlock(h); }}>
                  {copiedAt === h.at ? 'COPIED' : 'COPY RUN'}
                </ToolbarButton>
                <span style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                }}>{new Date(h.at).toLocaleTimeString()}</span>
              </div>
              <HighlightedCode code={h.code} lang={h.lang} />
              {h.out.stdout && (
                <pre style={{
                  margin: 0, padding: '4px 8px',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: 'rgba(57, 229, 255, 0.04)',
                  borderLeft: '2px solid var(--cyan)',
                  maxHeight: 200, overflow: 'auto',
                }}>{h.out.stdout}</pre>
              )}
              {h.out.stderr && (
                <pre style={{
                  margin: 0, padding: '4px 8px',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: 'rgba(255, 77, 94, 0.06)',
                  borderLeft: '2px solid var(--red)',
                  maxHeight: 200, overflow: 'auto',
                }}>{h.out.stderr}</pre>
              )}
              {h.error && (
                <div style={{
                  padding: '4px 8px',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
                  background: 'rgba(255, 77, 94, 0.06)',
                  borderLeft: '2px solid var(--red)',
                }}>invoke failed: {h.error}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
