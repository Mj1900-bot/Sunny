import { Chip, Toolbar, ToolbarButton } from '../_shared';
import { Waveform } from './Waveform';
import type { RecordStatus } from './api';

export function RecorderCard({
  status, onStart, onStop, busy,
}: {
  status: RecordStatus | null;
  onStart: () => void;
  onStop: () => void;
  busy: boolean;
}) {
  const recording = !!status?.recording;
  const elapsed = status?.seconds ?? 0;
  const mins = Math.floor(elapsed / 60);
  const secs = String(elapsed % 60).padStart(2, '0');

  return (
    <div style={{
      position: 'relative',
      border: '1px solid var(--line-soft)',
      borderLeft: `3px solid ${recording ? 'var(--red)' : 'var(--cyan)'}`,
      background: recording
        ? 'linear-gradient(135deg, rgba(255, 77, 94, 0.14) 0%, rgba(6, 14, 22, 0.7) 60%)'
        : 'rgba(6, 14, 22, 0.55)',
      padding: '16px 18px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
      boxShadow: recording ? '0 0 24px rgba(255, 77, 94, 0.18)' : undefined,
      transition: 'background 200ms ease, box-shadow 200ms ease',
    }}>
      {/* Live REC pulse dot — absolute top-right for unambiguous state */}
      {recording && (
        <div
          aria-hidden
          style={{
            position: 'absolute', top: 12, right: 14,
            width: 10, height: 10, borderRadius: '50%',
            background: 'var(--red)',
            boxShadow: '0 0 10px var(--red), 0 0 20px rgba(255, 77, 94, 0.45)',
            animation: 'pulseDot 1.2s ease-in-out infinite',
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip tone={recording ? 'red' : 'cyan'}>
          {recording ? '● REC' : 'IDLE'}
        </Chip>
        {!recording && status?.path && (
          <Chip tone="dim">last · {status.path.split('/').pop()}</Chip>
        )}
      </div>

      {/* Huge timer — always visible */}
      <div style={{
        fontFamily: 'var(--display)',
        fontSize: 42, fontWeight: 800,
        letterSpacing: '0.06em',
        color: recording ? 'var(--red)' : 'var(--cyan)',
        textShadow: recording
          ? '0 0 18px rgba(255, 77, 94, 0.55)'
          : '0 0 10px rgba(57, 229, 255, 0.35)',
        lineHeight: 1,
      }}>
        {mins}:{secs}
      </div>

      {/* Live waveform — always visible, decays to zero when idle */}
      <Waveform active={recording} height={48} />

      <Toolbar>
        {recording
          ? <ToolbarButton tone="red" onClick={onStop} disabled={busy}>STOP</ToolbarButton>
          : <ToolbarButton tone="cyan" onClick={onStart} disabled={busy}>START RECORDING</ToolbarButton>}
      </Toolbar>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', lineHeight: 1.5,
      }}>
        On-device WAV capture — no audio leaves the machine. Transcripts run
        through local <code style={{ color: 'var(--cyan)' }}>transcribe</code>.
      </div>
    </div>
  );
}
