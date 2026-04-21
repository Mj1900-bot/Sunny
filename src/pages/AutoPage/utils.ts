// ─────────────────────────────────────────────────────────────────
// Pure helpers: time formatting, draft validation, build helpers
// ─────────────────────────────────────────────────────────────────

import type { AddArgs, Draft, IntervalUnit, JobAction } from './types';

// ─────────────────────────────────────────────────────────────────
// Relative-time formatter ("in 4h", "3m ago", "now")
// ─────────────────────────────────────────────────────────────────

export function formatRelative(targetUnixS: number | null, nowMs: number): string {
  if (targetUnixS === null || targetUnixS === undefined) return '—';
  const targetMs = targetUnixS * 1000;
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const future = diff >= 0;

  const sec = Math.round(abs / 1000);
  const min = Math.round(abs / 60_000);
  const hr = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);

  let unit: string;
  if (sec < 5) return 'now';
  if (sec < 60) unit = `${sec}s`;
  else if (min < 60) unit = `${min}m`;
  else if (hr < 24) unit = `${hr}h`;
  else unit = `${day}d`;

  return future ? `in ${unit}` : `${unit} ago`;
}

export function formatIntervalSec(sec: number): string {
  if (sec <= 0) return '—';
  if (sec % 86400 === 0) return `${sec / 86400}D`;
  if (sec % 3600 === 0) return `${sec / 3600}H`;
  if (sec % 60 === 0) return `${sec / 60}M`;
  return `${sec}S`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

// ─────────────────────────────────────────────────────────────────
// Draft state + build helpers
// ─────────────────────────────────────────────────────────────────

export const UNIT_MULT: Record<IntervalUnit, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export const EMPTY_DRAFT: Draft = {
  title: '',
  kind: 'Once',
  onceLocal: '',
  intervalValue: '5',
  intervalUnit: 'm',
  actionType: 'Shell',
  shellCmd: '',
  notifyTitle: '',
  notifyBody: '',
  speakText: '',
  speakVoice: '',
  speakRate: '',
};

export function draftIsValid(d: Draft): boolean {
  if (d.title.trim().length === 0) return false;
  if (d.kind === 'Once' && d.onceLocal.trim().length === 0) return false;
  if (d.kind === 'Interval') {
    const n = Number(d.intervalValue);
    if (!Number.isFinite(n) || n <= 0) return false;
  }
  switch (d.actionType) {
    case 'Shell':
      return d.shellCmd.trim().length > 0;
    case 'Notify':
      return d.notifyTitle.trim().length > 0 && d.notifyBody.trim().length > 0;
    case 'Speak':
      return d.speakText.trim().length > 0;
  }
}

export function buildAction(d: Draft): JobAction {
  switch (d.actionType) {
    case 'Shell':
      return { type: 'Shell', data: { cmd: d.shellCmd.trim() } };
    case 'Notify':
      return {
        type: 'Notify',
        data: { title: d.notifyTitle.trim(), body: d.notifyBody.trim() },
      };
    case 'Speak': {
      const rate = Number(d.speakRate);
      const data: { text: string; voice?: string; rate?: number } = {
        text: d.speakText.trim(),
      };
      const voice = d.speakVoice.trim();
      if (voice.length > 0) data.voice = voice;
      if (d.speakRate.trim().length > 0 && Number.isFinite(rate)) data.rate = rate;
      return { type: 'Speak', data };
    }
  }
}

export function buildAddArgs(d: Draft): AddArgs {
  const action = buildAction(d);
  if (d.kind === 'Once') {
    // datetime-local produces "YYYY-MM-DDTHH:MM" in local time
    const ms = new Date(d.onceLocal).getTime();
    const at = Math.floor(ms / 1000);
    return { title: d.title.trim(), kind: 'Once', at, action };
  }
  const every = Math.max(1, Math.floor(Number(d.intervalValue) * UNIT_MULT[d.intervalUnit]));
  return { title: d.title.trim(), kind: 'Interval', every_sec: every, action };
}
