/**
 * VOICE — recording studio, transcript archive, meeting library.
 *
 * Depth additions (R12-F):
 *   • Transcript list: search input, duration filter, tag column, sparkline.
 *   • Click row → right detail panel with audio scrubber + click-to-seek.
 *   • "QUICK VOICE MEMO" toolbar button — starts recording immediately.
 *   • RMS history sampled during recording and persisted per clip.
 *
 * Recovery: if the native recorder is still live when the page mounts
 * (e.g. the app was reloaded mid-capture), the first status poll lights
 * up the REC chip and the elapsed counter resumes from the Rust-side
 * counter — we do not trust React state for "are we recording?", the
 * native side is the single source of truth.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '../../lib/tauri';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, ScrollList, Chip,
  ToolbarButton, usePoll, useDebounced, relTime, KeyHint,
} from '../_shared';
import { useVoiceStateSync } from '../../hooks/usePageStateSync';
import { RecorderCard } from './RecorderCard';
import { Sparkline } from './Sparkline';
import { TranscriptDetail } from './TranscriptDetail';
import {
  getRecordStatus, loadClips, saveClips, startRecording, stopRecording,
  transcribePath, type VoiceClip,
} from './api';

const DURATION_OPTIONS = [
  { label: 'ALL', min: 0, max: Infinity },
  { label: '< 1 MIN', min: 0, max: 60 },
  { label: '1–5 MIN', min: 60, max: 300 },
  { label: '> 5 MIN', min: 300, max: Infinity },
] as const;

type DurationFilter = typeof DURATION_OPTIONS[number]['label'];

export function VoicePage() {
  const { data: status, reload, error: statusError } = usePoll(getRecordStatus, 1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<VoiceClip[]>(() => loadClips());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('ALL');
  const [newTag, setNewTag] = useState('');

  const debQuery = useDebounced(query, 200);

  // Capture RMS samples into a rolling buffer for the current recording.
  const rmsBufferRef = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await listen<number>('sunny://voice.level', (rms) => {
          if (cancelled) return;
          const level = typeof rms === 'number' ? rms : 0;
          rmsBufferRef.current = [...rmsBufferRef.current.slice(-127), Math.min(1, level * 6)];
        });
        if (cancelled) { stop(); return; }
        unlisten = stop;
      } catch { /* outside Tauri */ }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => { saveClips(clips); }, [clips]);

  const nativeRecordingSeen = !!status?.recording;

  // Push the Voice page's visible state to the Rust backend so the
  // agent's `page_state_voice` tool can answer "am I recording".
  const lastTranscript = useMemo(() => {
    for (const c of clips) {
      if (c.transcript) return c.transcript.slice(0, 256);
    }
    return undefined;
  }, [clips]);
  const voiceSnapshot = useMemo(() => ({
    recording: nativeRecordingSeen,
    last_transcript: lastTranscript,
    clip_count: clips.length,
  }), [nativeRecordingSeen, lastTranscript, clips.length]);
  useVoiceStateSync(voiceSnapshot);

  // Reset RMS buffer when a new recording begins.
  const handleStart = async () => {
    setBusy(true); setError(null);
    rmsBufferRef.current = [];
    try { await startRecording(); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const handleStop = async () => {
    setBusy(true); setError(null);
    try {
      const path = await stopRecording();
      reload();
      if (path) {
        const secs = status?.seconds ?? 0;
        const rmsHistory = [...rmsBufferRef.current];
        rmsBufferRef.current = [];
        setClips(prev => [{
          path, ts: Math.floor(Date.now() / 1000),
          duration_secs: secs, transcript: null,
          tags: [], rmsHistory,
        }, ...prev]);
        setSelectedPath(path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  // QUICK VOICE MEMO — one-click start if not recording, stop if recording.
  const handleQuickMemo = () => {
    if (status?.recording) void handleStop();
    else void handleStart();
  };

  const handleTranscribe = async (clip: VoiceClip) => {
    setBusy(true); setError(null);
    try {
      const text = await transcribePath(clip.path);
      setClips(prev => prev.map(c =>
        c.path === clip.path ? { ...c, transcript: text ?? '(transcription failed)' } : c,
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const handleDelete = (clip: VoiceClip) => {
    setClips(prev => prev.filter(c => c.path !== clip.path));
    if (selectedPath === clip.path) setSelectedPath(null);
  };

  const handleAddTag = (clip: VoiceClip, tag: string) => {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed || clip.tags.includes(trimmed)) return;
    setClips(prev => prev.map(c =>
      c.path === clip.path ? { ...c, tags: [...c.tags, trimmed] } : c,
    ));
    setNewTag('');
  };

  const handleRemoveTag = (clip: VoiceClip, tag: string) => {
    setClips(prev => prev.map(c =>
      c.path === clip.path ? { ...c, tags: c.tags.filter(t => t !== tag) } : c,
    ));
  };

  // Filtering
  const dOpt = DURATION_OPTIONS.find(o => o.label === durationFilter) ?? DURATION_OPTIONS[0];
  const filtered = clips.filter(c => {
    const inDuration = c.duration_secs >= dOpt.min && c.duration_secs < dOpt.max;
    if (!inDuration) return false;
    if (!debQuery) return true;
    const q = debQuery.toLowerCase();
    return (
      c.path.toLowerCase().includes(q) ||
      (c.transcript?.toLowerCase().includes(q) ?? false) ||
      c.tags.some(t => t.includes(q))
    );
  });

  const selectedClip = clips.find(c => c.path === selectedPath) ?? null;
  const totalSecs = clips.reduce((n, c) => n + c.duration_secs, 0);
  const transcribedCount = clips.filter(c => c.transcript).length;

  return (
    <ModuleView title="VOICE · RECORDINGS">
      <PageGrid>
        {/* ── Top bar ── */}
        <PageCell span={12}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '6px 10px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(6, 14, 22, 0.55)',
          }}>
            <ToolbarButton
              tone={status?.recording ? 'red' : 'cyan'}
              onClick={handleQuickMemo}
              disabled={busy}
            >
              {status?.recording ? '■ STOP MEMO' : '● QUICK VOICE MEMO'}
            </ToolbarButton>
            <span style={{ width: 1, height: 16, background: 'var(--line-soft)' }} />
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
              letterSpacing: '0.18em',
            }}>SEARCH</span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="transcripts · tags · filenames…"
              style={{
                all: 'unset', flex: 1, minWidth: 160,
                padding: '4px 0',
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
              }}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                style={{
                  all: 'unset', cursor: 'pointer',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: 'var(--ink-dim)', letterSpacing: '0.16em',
                  padding: '2px 6px', border: '1px solid var(--line-soft)',
                }}
              >CLEAR</button>
            )}
            <span style={{ width: 1, height: 16, background: 'var(--line-soft)' }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {DURATION_OPTIONS.map(o => (
                <ToolbarButton
                  key={o.label}
                  tone="cyan"
                  active={durationFilter === o.label}
                  onClick={() => setDurationFilter(o.label)}
                >{o.label}</ToolbarButton>
              ))}
            </div>
          </div>
        </PageCell>

        {/* ── Left: recorder + stats ── */}
        <PageCell span={4}>
          <RecorderCard status={status ?? null} onStart={handleStart} onStop={handleStop} busy={busy} />
          {error && (
            <div style={{
              padding: '8px 12px',
              border: '1px solid var(--red)', borderLeft: '2px solid var(--red)',
              background: 'rgba(255,77,94,0.08)',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
            }}>{error}</div>
          )}
          {statusError && !error && (
            <div style={{
              padding: '6px 10px',
              border: '1px dashed var(--amber)',
              fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)',
            }}>recorder status: {statusError}</div>
          )}
          {nativeRecordingSeen && !busy && (
            <div style={{
              padding: '6px 10px',
              border: '1px dashed var(--red)',
              fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)',
            }}>Native recorder live — press STOP to finalize.</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <StatBlock label="CLIPS" value={String(clips.length)} tone="cyan" />
            <StatBlock label="TOTAL" value={`${Math.floor(totalSecs / 60)}m`} sub={`${totalSecs}s`} tone="violet" />
            <StatBlock label="TRANSCRIBED" value={String(transcribedCount)} sub={`${clips.length - transcribedCount} pending`} tone="amber" />
          </div>
        </PageCell>

        {/* ── Centre: clip list ── */}
        <PageCell span={4}>
          <Section title="CLIPS" right={`${filtered.length} / ${clips.length}`}>
            {filtered.length === 0 ? (
              <EmptyState
                title={clips.length === 0 ? 'No clips yet' : 'No matches'}
                hint={clips.length === 0
                  ? 'Start a recording above — clips land here once you stop.'
                  : 'Adjust search or duration filter.'}
              />
            ) : (
              <ScrollList maxHeight={520}>
                {filtered.map(c => {
                  const isSelected = selectedPath === c.path;
                  const mins = Math.floor(c.duration_secs / 60);
                  const secs = c.duration_secs % 60;
                  const durLabel = mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
                  return (
                    <div
                      key={c.path}
                      onClick={() => setSelectedPath(c.path)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedPath(c.path); }}
                      style={{
                        border: '1px solid var(--line-soft)',
                        borderLeft: isSelected
                          ? '2px solid var(--cyan)'
                          : (c.transcript ? '2px solid var(--green)' : '2px solid var(--amber)'),
                        padding: '9px 11px',
                        background: isSelected
                          ? 'linear-gradient(90deg, rgba(57, 229, 255, 0.14), transparent 85%)'
                          : 'rgba(6,14,22,0.55)',
                        cursor: 'pointer',
                        display: 'flex', flexDirection: 'column', gap: 6,
                        transition: 'background 120ms ease',
                        outline: 'none',
                      }}
                    >
                      {/* Row 1: status + duration + sparkline */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Chip tone={c.transcript ? 'green' : 'amber'}>
                          {c.transcript ? 'TX' : 'AUDIO'}
                        </Chip>
                        <span style={{
                          fontFamily: 'var(--display)', fontSize: 11,
                          color: 'var(--ink)', fontWeight: 700,
                          letterSpacing: '0.05em',
                        }}>{durLabel}</span>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
                          letterSpacing: '0.08em',
                        }}>· {relTime(c.ts)}</span>
                        <div style={{ marginLeft: 'auto' }}>
                          <Sparkline levels={c.rmsHistory} width={56} height={16} tone={c.transcript ? 'cyan' : 'amber'} />
                        </div>
                      </div>

                      {/* Row 2: filename */}
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {c.path.split('/').pop()}
                      </div>

                      {/* Row 3: transcript preview (one line) */}
                      {c.transcript && (
                        <div style={{
                          fontFamily: 'var(--label)', fontSize: 11.5, color: 'var(--ink-2)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontStyle: 'italic', opacity: 0.85,
                        }}>
                          "{c.transcript.slice(0, 100)}"
                        </div>
                      )}

                      {/* Row 4: tags (read-only here; edit from detail pane) */}
                      {c.tags.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {c.tags.map(tag => (
                            <Chip key={tag} tone="violet">{tag}</Chip>
                          ))}
                        </div>
                      )}

                      {/* Row 5: actions */}
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                        {!c.transcript && (
                          <ToolbarButton onClick={() => handleTranscribe(c)} tone="cyan" disabled={busy}>
                            TRANSCRIBE
                          </ToolbarButton>
                        )}
                        <ToolbarButton tone="red" onClick={() => handleDelete(c)}>DELETE</ToolbarButton>
                      </div>
                    </div>
                  );
                })}
              </ScrollList>
            )}
          </Section>
        </PageCell>

        {/* ── Right: detail panel ── */}
        <PageCell span={4}>
          <TranscriptDetail
            clip={selectedClip}
            newTag={newTag}
            setNewTag={setNewTag}
            onAddTag={tag => selectedClip && handleAddTag(selectedClip, tag)}
            onRemoveTag={tag => selectedClip && handleRemoveTag(selectedClip, tag)}
          />
          <div style={{
            marginTop: 8,
            display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
            padding: '5px 10px',
            fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
            letterSpacing: '0.08em',
            border: '1px solid var(--line-soft)',
            background: 'rgba(6, 14, 22, 0.4)',
          }}>
            <KeyHint>ENTER</KeyHint><span>ADD TAG</span>
            <span style={{ width: 1, height: 10, background: 'var(--line-soft)' }} />
            <KeyHint>CLICK</KeyHint><span>SEEK TO SENTENCE</span>
          </div>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
