import { invokeSafe } from '../../lib/tauri';

export type RecordStatus = {
  recording: boolean;
  path: string | null;
  seconds: number;
};

export type VoiceClip = {
  /** Absolute path to the WAV file on disk. */
  readonly path: string;
  /** Unix seconds when the recording was stopped. */
  readonly ts: number;
  readonly duration_secs: number;
  readonly transcript: string | null;
  /** Optional user-defined tags (e.g. "meeting", "idea"). */
  readonly tags: ReadonlyArray<string>;
  /** Sampled RMS levels captured during recording (0–1 each). */
  readonly rmsHistory: ReadonlyArray<number>;
};

const STORAGE_KEY = 'sunny.voice.clips.v2';

export function loadClips(): VoiceClip[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateLegacy();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return (parsed as VoiceClip[]).map(normalise);
  } catch { /* ignore */ }
  return [];
}

function migrateLegacy(): VoiceClip[] {
  try {
    const raw = localStorage.getItem('sunny.voice.clips.v1');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return (parsed as VoiceClip[]).map(normalise);
  } catch { /* ignore */ }
  return [];
}

function normalise(c: Partial<VoiceClip> & { path: string; ts: number; duration_secs: number }): VoiceClip {
  return {
    path: c.path,
    ts: c.ts,
    duration_secs: c.duration_secs,
    transcript: c.transcript ?? null,
    tags: c.tags ?? [],
    rmsHistory: c.rmsHistory ?? [],
  };
}

export function saveClips(clips: ReadonlyArray<VoiceClip>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clips)); } catch { /* ignore */ }
}

export async function startRecording(): Promise<string | null> {
  return invokeSafe<string>('audio_record_start');
}

export async function stopRecording(): Promise<string | null> {
  return invokeSafe<string>('audio_record_stop');
}

export async function getRecordStatus(): Promise<RecordStatus | null> {
  return invokeSafe<RecordStatus>('audio_record_status');
}

export async function transcribePath(path: string): Promise<string | null> {
  return invokeSafe<string>('transcribe', { path });
}
