/**
 * Right-side detail panel for a selected VoiceClip.
 * Shows: audio player with scrubber, full transcript with click-to-seek,
 * AI summarize button, and playback state.
 *
 * The click-to-seek heuristic splits the transcript by sentences,
 * maps each sentence to a proportional timestamp, and seeks audio
 * to that offset when clicked.
 */

import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Chip, EmptyState, Section, Toolbar, ToolbarButton } from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { copyToClipboard } from '../../lib/clipboard';
import type { VoiceClip } from './api';

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function TranscriptDetail({
  clip,
  newTag,
  setNewTag,
  onAddTag,
  onRemoveTag,
}: {
  clip: VoiceClip | null;
  newTag?: string;
  setNewTag?: (v: string) => void;
  onAddTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [findInTranscript, setFindInTranscript] = useState('');
  const [copyFlash, setCopyFlash] = useState<'tx' | 'path' | null>(null);

  // Reset player whenever the selected clip changes.
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setLoadError(false);
    setFindInTranscript('');
  }, [clip?.path]);

  if (!clip) {
    return (
      <EmptyState
        title="Select a clip"
        hint="Click any transcript row on the left to open the audio player and full text here."
      />
    );
  }

  const sentences = clip.transcript ? splitSentences(clip.transcript) : [];
  const clipDuration = duration > 0 ? duration : clip.duration_secs;

  const seekToSentence = (idx: number) => {
    const el = audioRef.current;
    if (!el || sentences.length === 0) return;
    const offset = (idx / sentences.length) * clipDuration;
    el.currentTime = offset;
    void el.play();
    setPlaying(true);
  };

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { void el.play(); setPlaying(true); }
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el) return;
    const t = Number(e.target.value);
    el.currentTime = t;
    setCurrentTime(t);
  };

  const activeSentenceIdx = sentences.length > 0 && clipDuration > 0
    ? Math.min(
        sentences.length - 1,
        Math.floor((currentTime / clipDuration) * sentences.length),
      )
    : -1;

  return (
    <Section title="CLIP DETAIL" right={`${Math.floor(clip.duration_secs / 60)}m ${clip.duration_secs % 60}s`}>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={(() => { try { return convertFileSrc(clip.path); } catch { return ''; } })()}
        onTimeUpdate={e => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={e => setDuration((e.target as HTMLAudioElement).duration)}
        onEnded={() => setPlaying(false)}
        onError={() => { setLoadError(true); setPlaying(false); }}
        preload="metadata"
        style={{ display: 'none' }}
      />

      {/* Player */}
      <div style={{
        border: '1px solid var(--line-soft)',
        borderLeft: `2px solid ${playing ? 'var(--red)' : 'var(--cyan)'}`,
        background: 'rgba(6,14,22,0.65)',
        padding: '10px 14px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Chip tone={playing ? 'red' : 'cyan'}>{playing ? 'PLAYING' : 'PAUSED'}</Chip>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)' }}>
            {formatTime(currentTime)} / {formatTime(clipDuration)}
          </span>
          {loadError && <Chip tone="red">FILE ERROR</Chip>}
        </div>

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={clipDuration || 1}
          step={0.1}
          value={currentTime}
          onChange={handleScrub}
          disabled={loadError}
          style={{
            width: '100%', accentColor: 'var(--cyan)',
            cursor: loadError ? 'not-allowed' : 'pointer',
          }}
          aria-label="Audio scrubber"
        />

        <Toolbar>
          <ToolbarButton tone={playing ? 'red' : 'cyan'} onClick={togglePlay} disabled={loadError}>
            {playing ? 'PAUSE' : 'PLAY'}
          </ToolbarButton>
          {clip.transcript && (
            <>
              <ToolbarButton
                tone="cyan"
                onClick={async () => {
                  const ok = await copyToClipboard(clip.transcript ?? '');
                  if (ok) { setCopyFlash('tx'); window.setTimeout(() => setCopyFlash(null), 900); }
                }}
              >{copyFlash === 'tx' ? 'COPIED' : 'COPY TRANSCRIPT'}</ToolbarButton>
              <ToolbarButton
                tone="amber"
                onClick={async () => {
                  const ok = await copyToClipboard(clip.path);
                  if (ok) { setCopyFlash('path'); window.setTimeout(() => setCopyFlash(null), 900); }
                }}
              >{copyFlash === 'path' ? 'COPIED' : 'COPY PATH'}</ToolbarButton>
              <ToolbarButton
                tone="violet"
                onClick={() => askSunny(
                  `Summarize this transcript in 5 bullets and call out any action items:\n\n${clip.transcript}`,
                  'voice',
                )}
              >AI SUMMARIZE</ToolbarButton>
            </>
          )}
        </Toolbar>
      </div>

      {/* Transcript with click-to-seek */}
      {clip.transcript ? (
        <div style={{
          border: '1px solid var(--line-soft)',
          background: 'rgba(6,14,22,0.45)',
          padding: '10px 14px',
          maxHeight: 320,
          overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4,
          }}>
            <span style={{
              fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.24em',
              color: 'var(--cyan)', fontWeight: 700,
            }}>FIND</span>
            <input
              value={findInTranscript}
              onChange={e => setFindInTranscript(e.target.value)}
              placeholder="filter sentences…"
              aria-label="Find in transcript"
              style={{
                all: 'unset', flex: 1, minWidth: 120,
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                borderBottom: '1px solid var(--line-soft)',
                padding: '2px 0',
              }}
            />
          </div>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.24em',
            color: 'var(--ink-2)', fontWeight: 700, marginBottom: 6,
          }}>TRANSCRIPT · CLICK SENTENCE TO SEEK</div>
          {(() => {
            const fq = findInTranscript.trim().toLowerCase();
            const rows = sentences
              .map((sentence, idx) => ({ sentence, idx }))
              .filter(({ sentence }) => !fq || sentence.toLowerCase().includes(fq));
            if (rows.length === 0) {
              return (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', padding: 8 }}>
                  No sentences match “{findInTranscript.trim()}”.
                </div>
              );
            }
            return rows.map(({ sentence, idx }) => {
              const isActive = idx === activeSentenceIdx;
              return (
                <button
                  key={idx}
                  onClick={() => seekToSentence(idx)}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    display: 'block', width: '100%',
                    padding: '3px 6px',
                    fontFamily: 'var(--label)', fontSize: 12.5,
                    color: isActive ? '#fff' : 'var(--ink-2)',
                    lineHeight: 1.55,
                    background: isActive ? 'rgba(57,229,255,0.1)' : 'transparent',
                    borderLeft: isActive ? '2px solid var(--cyan)' : '2px solid transparent',
                    transition: 'background 100ms ease',
                    textAlign: 'left',
                  }}
                >
                  {sentence}
                </button>
              );
            });
          })()}
        </div>
      ) : (
        <div style={{
          padding: '10px 14px',
          border: '1px dashed var(--line-soft)',
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
        }}>
          No transcript yet — select the clip and press TRANSCRIBE.
        </div>
      )}

      {/* Tags + add-tag composer */}
      {(clip.tags.length > 0 || onAddTag) && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          padding: '8px 10px',
          border: '1px solid var(--line-soft)',
          background: 'rgba(6, 14, 22, 0.4)',
        }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
            color: 'var(--ink-2)', fontWeight: 700,
          }}>TAGS</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {clip.tags.map(tag => (
              <Chip key={tag} tone="violet">
                {tag}
                {onRemoveTag && (
                  <button
                    onClick={() => onRemoveTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                    style={{
                      all: 'unset', cursor: 'pointer',
                      marginLeft: 4, opacity: 0.65,
                      padding: '0 2px',
                    }}
                  >×</button>
                )}
              </Chip>
            ))}
            {onAddTag && setNewTag && (
              <input
                value={newTag ?? ''}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (newTag ?? '').trim()) {
                    onAddTag((newTag ?? '').trim());
                  }
                }}
                placeholder="+ tag"
                style={{
                  all: 'unset', minWidth: 60,
                  padding: '2px 8px',
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
                  border: '1px dashed var(--line-soft)',
                  background: 'rgba(0, 0, 0, 0.3)',
                }}
              />
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
