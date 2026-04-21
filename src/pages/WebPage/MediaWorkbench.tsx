import type { ReactElement } from 'react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { invoke } from '../../lib/tauri';
import type { DownloadJob } from './types';

type ExtractResult = {
  job_id: string;
  audio_path: string;
  frames_dir: string;
  frame_count: number;
  meta: {
    duration_sec: number;
    width: number;
    height: number;
    bitrate: number;
    codec_video: string;
    codec_audio: string;
    container: string;
  };
};

type Tab = 'summary' | 'transcript' | 'ask';

// Provider-neutral stub for downstream AI calls. The browser module
// produces `audio.mp3` + `frame-*.jpg` into `~/.sunny/browser/media/<id>/`.
// Real transcription / vision calls are driven from src/lib/tools.ts or
// AutoPage — this panel just surfaces "analyze" as a button and stores the
// result back on the job so it survives a tab close.
type TranscriptLine = { ts: number; text: string };
type AnalysisResult = {
  transcript: TranscriptLine[];
  summary: string;
  chapters: { ts: number; title: string }[];
};

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(2, 6, 12, 0.72)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'center',
  padding: 20,
};

const panel: CSSProperties = {
  background: 'rgba(4, 12, 20, 0.98)',
  border: '1px solid var(--cyan)',
  maxWidth: 1100,
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
  boxShadow: '0 0 40px rgba(0, 220, 255, 0.2)',
};

const btn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 12px',
  border: '1px solid var(--line-soft)',
  color: 'var(--cyan)',
  fontSize: 11,
  letterSpacing: '0.14em',
  height: 26,
  lineHeight: '26px',
};

export function MediaWorkbench({
  job,
  onClose,
}: {
  job: DownloadJob;
  onClose: () => void;
}): ReactElement {
  const [extract, setExtract] = useState<ExtractResult | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [askInput, setAskInput] = useState('');
  const [askHistory, setAskHistory] = useState<{ role: 'user' | 'assistant'; text: string }[]>(
    [],
  );

  const filePath = job.file_path;

  const runExtract = useCallback(async () => {
    if (!filePath) {
      setError('download has no local file yet');
      return;
    }
    setExtracting(true);
    setError(null);
    try {
      const r = await invoke<ExtractResult>('browser_media_extract', {
        jobId: job.id,
        path: filePath,
      });
      setExtract(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtracting(false);
    }
  }, [filePath, job.id]);

  useEffect(() => {
    if (filePath && !extract && !extracting && !error) {
      void runExtract();
    }
  }, [filePath, extract, extracting, error, runExtract]);

  const durationDisplay = useMemo(() => {
    if (!extract) return '';
    const total = Math.max(0, Math.round(extract.meta.duration_sec));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [extract]);

  const runAnalysis = useCallback(async () => {
    // The browser module produces deterministic inputs (audio + frames).
    // Downstream vision / transcription wiring lives in the configured AI
    // provider via src/lib/tools.ts. Here we surface a single entry point
    // that calls the provider-agnostic `browser_fetch`/`chat` wiring —
    // when none is configured we fall back to a best-effort placeholder so
    // the panel stays responsive rather than throwing.
    if (!extract) return;
    try {
      const existing = await invoke<AnalysisResult | null>('memory_skill_get', {
        id: `video_analysis:${job.id}`,
      }).catch(() => null);
      if (existing && typeof existing === 'object' && 'transcript' in existing) {
        setAnalysis(existing as AnalysisResult);
        return;
      }
    } catch {
      /* ignore — analysis cache is best effort */
    }
    // Provider hook: the frontend `analyzeVideo` helper in AutoPage can be
    // wired here when the user's AI provider exposes vision. We emit a
    // stub result with the extract metadata so the UI renders.
    setAnalysis({
      transcript: [],
      summary: `Audio extracted to ${extract.audio_path}. ${extract.frame_count} keyframes in ${extract.frames_dir}. Hook up a transcription/vision provider to see real output.`,
      chapters: [],
    });
  }, [extract, job.id]);

  const submitAsk = useCallback(async () => {
    const q = askInput.trim();
    if (q.length === 0) return;
    setAskHistory(h => [...h, { role: 'user', text: q }]);
    setAskInput('');
    // The browser module provides the data; the AI plumbing answers. We
    // emit an informative assistant line the user can follow up on.
    setAskHistory(h => [
      ...h,
      {
        role: 'assistant',
        text:
          extract === null
            ? 'waiting for extract…'
            : analysis === null
              ? 'run "Analyze" first to build a transcript the chat can read.'
              : `noted. (Hook up AutoPage\u2019s chat wiring here to answer against ${extract.frame_count} frames and ${analysis.transcript.length} transcript lines.)`,
      },
    ]);
  }, [askInput, extract, analysis]);

  const reveal = useCallback(async () => {
    await invoke('browser_downloads_reveal', { id: job.id });
  }, [job.id]);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <header
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--line-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              flex: 1,
              fontFamily: "'Orbitron', var(--display, var(--mono))",
              letterSpacing: '0.18em',
              color: 'var(--cyan)',
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={job.title ?? job.source_url}
          >
            {job.title ?? job.source_url}
          </div>
          <button type="button" onClick={() => void reveal()} style={btn} title="Reveal in Finder">
            REVEAL
          </button>
          <button type="button" onClick={onClose} style={{ ...btn, color: 'var(--ink-dim)' }}>
            CLOSE
          </button>
        </header>

        <div
          style={{
            padding: '8px 14px',
            borderBottom: '1px dashed var(--line-soft)',
            display: 'flex',
            gap: 14,
            color: 'var(--ink-dim)',
            fontSize: 10,
          }}
        >
          <span>{job.state.toUpperCase()}</span>
          {extract && (
            <>
              <span>{durationDisplay}</span>
              <span>
                {extract.meta.width}&times;{extract.meta.height}
              </span>
              <span>{extract.meta.codec_video || '—'}</span>
              <span>{extract.frame_count} frames</span>
            </>
          )}
          <span style={{ marginLeft: 'auto' }}>{job.profile_id}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '6px 14px' }}>
          {(['summary', 'transcript', 'ask'] as Tab[]).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                ...btn,
                borderColor: tab === t ? 'var(--cyan)' : 'var(--line-soft)',
                color: tab === t ? 'var(--cyan)' : 'var(--ink-dim)',
              }}
            >
              {t.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void runAnalysis()}
            disabled={!extract || extracting}
            style={{ ...btn, marginLeft: 'auto', borderColor: 'var(--cyan)' }}
          >
            ANALYZE
          </button>
        </div>

        <div style={{ padding: 14, overflowY: 'auto', maxHeight: '60vh' }}>
          {error ? (
            <div style={{ color: '#ff9b9b' }}>{error}</div>
          ) : extracting ? (
            <div style={{ color: 'var(--cyan)', letterSpacing: '0.2em' }}>EXTRACTING…</div>
          ) : !extract ? (
            <div style={{ color: 'var(--ink-dim)' }}>
              {'// waiting for the download to finish, then ffmpeg will run'}
            </div>
          ) : tab === 'summary' ? (
            <SummaryTab analysis={analysis} />
          ) : tab === 'transcript' ? (
            <TranscriptTab transcript={analysis?.transcript ?? []} />
          ) : (
            <AskTab
              history={askHistory}
              value={askInput}
              onChange={setAskInput}
              onSubmit={() => void submitAsk()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryTab({ analysis }: { analysis: AnalysisResult | null }): ReactElement {
  if (!analysis) {
    return (
      <div style={{ color: 'var(--ink-dim)', lineHeight: 1.6 }}>
        {'// click ANALYZE to produce a summary + chapter markers from the extracted audio and keyframes.'}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, lineHeight: 1.65 }}>
      <div style={{ color: 'var(--ink)' }}>{analysis.summary}</div>
      {analysis.chapters.length > 0 && (
        <div>
          <div style={{ color: 'var(--cyan)', letterSpacing: '0.18em', fontSize: 10, marginBottom: 6 }}>
            CHAPTERS
          </div>
          {analysis.chapters.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, color: 'var(--ink-dim)' }}>
              <span style={{ color: 'var(--cyan)', minWidth: 48 }}>
                {formatTs(c.ts)}
              </span>
              <span>{c.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptTab({ transcript }: { transcript: TranscriptLine[] }): ReactElement {
  if (transcript.length === 0) {
    return (
      <div style={{ color: 'var(--ink-dim)', lineHeight: 1.6 }}>
        {'// no transcript yet — run ANALYZE.'}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      {transcript.map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <span style={{ color: 'var(--cyan)', minWidth: 48 }}>{formatTs(t.ts)}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function AskTab({
  history,
  value,
  onChange,
  onSubmit,
}: {
  history: { role: 'user' | 'assistant'; text: string }[];
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {history.length === 0 && (
        <div style={{ color: 'var(--ink-dim)' }}>
          {'// ask questions scoped to this video\u2019s transcript + keyframes.'}
        </div>
      )}
      {history.map((m, i) => (
        <div
          key={i}
          style={{
            padding: 8,
            border: '1px solid var(--line-soft)',
            background:
              m.role === 'user' ? 'rgba(0, 220, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ color: 'var(--cyan)', fontSize: 9, letterSpacing: '0.18em', marginBottom: 4 }}>
            {m.role.toUpperCase()}
          </div>
          <div style={{ color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{m.text}</div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onSubmit();
          }}
          placeholder="ask about this video…"
          style={{
            all: 'unset',
            flex: 1,
            height: 28,
            padding: '0 10px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(4, 10, 16, 0.5)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--ink)',
          }}
        />
        <button type="button" onClick={onSubmit} style={btn}>
          ASK
        </button>
      </div>
    </div>
  );
}

function formatTs(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
