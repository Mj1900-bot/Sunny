import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ReactElement } from 'react';
import { invoke } from '../../lib/tauri';
import { hostOf, useTabs } from './tabStore';
import type { ResearchBrief, ResearchSource } from './types';

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  padding: 10,
  maxHeight: '100%',
  overflowY: 'auto',
};

const input: CSSProperties = {
  all: 'unset',
  flex: 1,
  padding: '0 10px',
  height: 28,
  border: '1px solid var(--line-soft)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
  background: 'rgba(4, 10, 16, 0.5)',
};

const btn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '0 10px',
  height: 28,
  lineHeight: '28px',
  border: '1px solid var(--cyan)',
  color: 'var(--cyan)',
  letterSpacing: '0.14em',
  fontSize: 11,
};

export function ResearchPanel(): ReactElement {
  const profiles = useTabs(s => s.profiles);
  const tabs = useTabs(s => s.tabs);
  const activeTabId = useTabs(s => s.activeTabId);
  const openTab = useTabs(s => s.openTab);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<ResearchBrief | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const profileId = activeTab?.profileId ?? profiles[0]?.id ?? 'default';

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    setBrief(null);
    try {
      const b = await invoke<ResearchBrief>('browser_research_run', {
        profileId,
        query: q,
        maxSources: 8,
      });
      setBrief(b);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  };

  const canRun = q.trim().length > 0 && !busy;

  return (
    <div style={wrap}>
      <style>{`@keyframes sunny-research-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div style={{ letterSpacing: '0.18em', color: 'var(--cyan)' }}>// RESEARCH</div>
      <div style={{ color: 'var(--ink-dim)', fontSize: 10, lineHeight: 1.6 }}>
        Runs a multi-source DuckDuckGo-backed fan-out through the active profile
        <strong style={{ color: 'var(--ink)' }}> ({profileId}) </strong>
        and returns readable text with citations. Feed this into Auto for synthesis.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={q}
          placeholder="a question worth reading 8 pages about…"
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKey}
          style={input}
          autoFocus
          aria-label="Research query"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={!canRun}
          style={{
            ...btn,
            cursor: canRun ? 'pointer' : 'not-allowed',
            opacity: canRun ? 1 : 0.45,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            justifyContent: 'center',
          }}
        >
          {busy ? (
            <>
              <span
                style={{
                  width: 10,
                  height: 10,
                  border: '1.5px solid var(--line-soft)',
                  borderTopColor: 'var(--cyan)',
                  borderRadius: '50%',
                  animation: 'sunny-research-spin 0.9s linear infinite',
                }}
                aria-hidden
              />
              <span>RUN</span>
            </>
          ) : (
            'RUN'
          )}
        </button>
      </div>
      {busy && (
        <div
          role="status"
          aria-live="polite"
          style={{
            color: 'var(--cyan)',
            fontSize: 10,
            letterSpacing: '0.14em',
            padding: '4px 2px',
          }}
        >
          {'// fetching up to 8 sources through '}{profileId}{' …'}
        </div>
      )}
      {err && (
        <div
          role="alert"
          style={{
            border: '1px solid #f5b042',
            background: 'rgba(245, 176, 66, 0.08)',
            color: '#f5b042',
            padding: 8,
            fontSize: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div>// RESEARCH FAILED</div>
          <div style={{ color: '#ffd08a', lineHeight: 1.5 }}>{err}</div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!canRun}
            style={{
              all: 'unset',
              cursor: canRun ? 'pointer' : 'not-allowed',
              padding: '2px 10px',
              border: '1px solid #f5b042',
              color: '#f5b042',
              fontSize: 10,
              letterSpacing: '0.14em',
              alignSelf: 'flex-start',
            }}
          >
            {'\u21BB RETRY'}
          </button>
        </div>
      )}
      {!brief && !busy && !err && (
        <div
          style={{
            color: 'var(--ink-dim)',
            fontSize: 10,
            lineHeight: 1.7,
            padding: '10px 8px',
            border: '1px dashed var(--line-soft)',
            background: 'rgba(0, 220, 255, 0.02)',
          }}
        >
          <div style={{ color: 'var(--cyan)', letterSpacing: '0.18em', marginBottom: 4 }}>
            // IDLE
          </div>
          {'ask a question, get extracted text from up to 8 citations. Open any source in a tab by clicking its title.'}
        </div>
      )}
      {brief && brief.sources.length === 0 && !busy && (
        <div
          style={{
            color: 'var(--ink-dim)',
            fontSize: 10,
            padding: 8,
            border: '1px dashed var(--line-soft)',
          }}
        >
          {'// no sources returned for "'}{brief.query}{'"'}
        </div>
      )}
      {brief && brief.sources.length > 0 && (
        <>
          <div style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
            {brief.sources.length} sources in {brief.elapsed_ms}ms through {brief.profile_id}
          </div>
          {brief.sources.map((s, i) => (
            <SourceRow key={s.url + i} source={s} onOpen={url => openTab(profileId, url)} />
          ))}
        </>
      )}
    </div>
  );
}

function SourceRow({
  source,
  onOpen,
}: {
  source: ResearchSource;
  onOpen: (url: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        padding: 10,
        background: 'rgba(4, 10, 16, 0.5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <button
          type="button"
          onClick={() => onOpen(source.url)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: source.fetched_ok ? 'var(--cyan)' : 'var(--ink-dim)',
            fontSize: 12,
            fontWeight: 600,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          {source.title || hostOf(source.final_url)}
        </button>
        <span style={{ color: 'var(--ink-dim)', fontSize: 9 }}>
          {hostOf(source.final_url)} · {source.ms}ms
        </span>
      </div>
      {source.snippet && (
        <div style={{ color: 'var(--ink-dim)', fontSize: 10, fontStyle: 'italic' }}>
          {source.snippet}
        </div>
      )}
      {source.fetched_ok && source.text && (
        <div
          style={{
            color: 'var(--ink)',
            fontSize: 10,
            lineHeight: 1.6,
            maxHeight: 140,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {source.text}
        </div>
      )}
    </div>
  );
}
