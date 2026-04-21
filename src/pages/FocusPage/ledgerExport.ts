/**
 * Export focus sessions + distraction log for backup or analysis.
 */

import type { DistractionEntry, SessionRecord } from './api';
import { focusedSecs } from './api';

export function buildLedgerPlainText(
  sessions: ReadonlyArray<SessionRecord>,
  distractions: ReadonlyArray<DistractionEntry>,
  nowSecs: number,
): string {
  const lines: string[] = ['SUNNY · FOCUS LEDGER', `generated · ${new Date().toISOString()}`, ''];

  lines.push('— SESSIONS —');
  for (const s of sessions.slice(0, 80)) {
    const dur = focusedSecs(s, nowSecs);
    const end = s.end != null ? new Date(s.end * 1000).toISOString() : 'active';
    lines.push(
      `${new Date(s.start * 1000).toISOString()} → ${end} · ${Math.floor(dur / 60)}m focused · ${s.goal || '(no goal)'}`,
    );
  }
  lines.push('');

  lines.push('— DISTRACTIONS (recent) —');
  for (const d of distractions.slice(0, 100)) {
    lines.push(`${new Date(d.ts * 1000).toISOString()} · ${d.appName} · ${d.windowTitle || '—'}`);
  }

  return lines.join('\n');
}

export function buildLedgerJson(
  sessions: ReadonlyArray<SessionRecord>,
  distractions: ReadonlyArray<DistractionEntry>,
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      sessions: [...sessions],
      distractions: [...distractions],
    },
    null,
    2,
  );
}

export function downloadTextFile(filename: string, body: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
