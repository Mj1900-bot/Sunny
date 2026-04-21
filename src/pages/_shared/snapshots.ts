/**
 * Plain-text / file exports for module pages (clipboard + download).
 */

import type { SubAgent } from '../../store/subAgentsLive';
import type { WorldState } from '../WorldPage/types';
import type { UsageRecord } from '../AuditPage/api';
import type { MemoryStats, ToolStats } from '../BrainPage/api';
import type { FocusedApp, OcrResult, WindowInfo } from '../InspectorPage/api';
import type { Daemon, NetStats, NowPlaying } from '../DevicesPage/api';

export function inspectorSnapshotText(args: {
  focused: FocusedApp | null;
  title: string | null;
  size: { width: number; height: number } | null;
  cursor: { x: number; y: number } | null;
  windowCount: number;
}): string {
  const lines: string[] = ['Inspector · accessibility snapshot'];
  lines.push(`focused: ${args.focused?.name ?? '—'} (pid ${args.focused?.pid ?? '—'})`);
  lines.push(`bundle: ${args.focused?.bundle_id ?? '—'}`);
  lines.push(`title: ${args.title ?? '—'}`);
  if (args.size) lines.push(`screen: ${args.size.width}×${args.size.height}`);
  if (args.cursor) lines.push(`cursor: ${args.cursor.x}, ${args.cursor.y}`);
  lines.push(`windows: ${args.windowCount}`);
  return lines.join('\n');
}

export function downloadTextFile(filename: string, body: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Full JSON export for debugging / bug reports (matches `world_get` shape). */
export function worldSnapshotJson(world: WorldState): string {
  return JSON.stringify(world, null, 2);
}

/** Sub-agent fleet as JSON (mirrors live store records). */
export function societyFleetJson(agents: ReadonlyArray<SubAgent>): string {
  return JSON.stringify(agents, null, 2);
}

export function worldSnapshotText(world: WorldState): string {
  const lines: string[] = [];
  lines.push(`Sunny world snapshot · rev ${world.revision} · schema v${world.schema_version}`);
  lines.push(`time: ${new Date(world.timestamp_ms).toISOString()} · local: ${world.local_iso}`);
  lines.push(`host: ${world.host} · ${world.os_version}`);
  lines.push(`activity: ${world.activity}`);
  if (world.focus) {
    lines.push(`focus_app: ${world.focus.app_name}`);
    lines.push(`bundle: ${world.focus.bundle_id ?? '—'}`);
    if (world.focus.window_title) lines.push(`window: ${world.focus.window_title}`);
    lines.push(`focused_for: ${world.focused_duration_secs}s`);
  } else {
    lines.push('focus: (none)');
  }
  lines.push(`events_today: ${world.events_today}`);
  if (world.next_event) {
    const ev = world.next_event;
    lines.push(`next_event: ${ev.title} @ ${ev.start_iso}`);
    if (ev.location) lines.push(`  location: ${ev.location}`);
    if (ev.calendar_name) lines.push(`  calendar: ${ev.calendar_name}`);
  } else {
    lines.push('next_event: (none in window)');
  }
  lines.push(`mail_unread: ${world.mail_unread == null ? 'n/a' : world.mail_unread}`);
  lines.push(`cpu: ${world.cpu_pct.toFixed(0)}% · mem: ${world.mem_pct.toFixed(0)}% · temp: ${world.temp_c.toFixed(0)}°C`);
  if (world.battery_pct != null) {
    lines.push(`battery: ${Math.round(world.battery_pct)}%${world.battery_charging ? ' charging' : ''}`);
  }
  if (world.recent_switches.length > 0) {
    lines.push('recent_switches:');
    for (const s of world.recent_switches.slice(0, 20)) {
      lines.push(`  ${s.from_app} → ${s.to_app} @ ${s.at_secs}`);
    }
  }
  return lines.join('\n');
}

export function brainMemoryJson(mem: MemoryStats): string {
  return JSON.stringify(mem, null, 2);
}

export function toolStatsJson(rows: ReadonlyArray<ToolStats>): string {
  return JSON.stringify(rows, null, 2);
}

function toolStatsSuccessPct(r: ToolStats): string {
  return r.success_rate < 0 ? '' : String(Math.round(r.success_rate * 1000) / 10);
}

/** One reliability row (no header) — for per-row copy; matches `toolStatsCsv` columns. */
export function toolStatsLineTsv(r: ToolStats): string {
  const esc = (s: string) => s.replace(/\t/g, ' ');
  return [
    esc(r.tool_name),
    r.count,
    r.ok_count,
    r.err_count,
    toolStatsSuccessPct(r),
    r.latency_p50_ms,
    r.latency_p95_ms,
  ].join('\t');
}

/** Tab-separated 7-day (or any) tool reliability table with header. */
export function toolStatsTsv(rows: ReadonlyArray<ToolStats>): string {
  const header = 'tool\tcount\tok\terr\tsuccess_pct\tp50_ms\tp95_ms';
  return [header, ...rows.map(toolStatsLineTsv)].join('\n');
}

export function toolStatsCsv(rows: ReadonlyArray<ToolStats>): string {
  const esc = (s: string) => (s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);
  const header = 'tool,count,ok,err,success_pct,p50_ms,p95_ms';
  const body = rows.map(r => {
    const pct = toolStatsSuccessPct(r);
    return [esc(r.tool_name), r.count, r.ok_count, r.err_count, pct, r.latency_p50_ms, r.latency_p95_ms].join(',');
  });
  return [header, ...body].join('\n');
}

export function auditTimelineCsv(rows: ReadonlyArray<UsageRecord>): string {
  const esc = (s: string) => (s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s);
  // `reason` is the model's pre-dispatch narrative captured alongside
  // the tool call — same field as the hover-text in the Audit timeline.
  const header = 'id,tool,ok,latency_ms,error,reason,created_unix';
  const body = rows.map(r => [
    r.id,
    esc(r.tool_name),
    r.ok ? '1' : '0',
    r.latency_ms,
    r.error_msg ? esc(r.error_msg) : '',
    r.reason ? esc(r.reason) : '',
    r.created_at,
  ].join(','));
  return [header, ...body].join('\n');
}

export function auditTimelineNdjson(rows: ReadonlyArray<UsageRecord>): string {
  return rows.map(r => JSON.stringify(r)).join('\n');
}

export function windowsTsv(windows: ReadonlyArray<WindowInfo>): string {
  const header = 'app\ttitle\tpid\tx\ty\tw\th';
  const lines = windows.map(w => windowInfoLineTsv(w));
  return [header, ...lines].join('\n');
}

/** Single window row (no header) — for per-row copy. */
export function windowInfoLineTsv(w: WindowInfo): string {
  const esc = (s: string) => s.replace(/\t/g, ' ');
  return [
    esc(w.app_name),
    esc(w.title || ''),
    w.pid,
    w.x ?? '',
    w.y ?? '',
    w.w ?? '',
    w.h ?? '',
  ].join('\t');
}

export type InspectorSessionPayload = {
  focused: FocusedApp | null;
  activeTitle: string | null;
  screen: { width: number; height: number } | null;
  cursor: { x: number; y: number } | null;
  windows: ReadonlyArray<WindowInfo>;
  ocr: OcrResult | null;
};

export function inspectorSessionJson(payload: InspectorSessionPayload): string {
  return JSON.stringify(payload, null, 2);
}

export function netStatsText(net: NetStats): string {
  const lines = [
    `interface: ${net.iface ?? '—'}`,
    `ssid: ${net.ssid ?? '—'}`,
    `public_ip: ${net.public_ip ?? '—'}`,
    `ping: ${net.ping_ms != null ? `${net.ping_ms}ms` : '—'}`,
    `down: ${net.down_kbps ?? 0} KB/s`,
    `up: ${net.up_kbps ?? 0} KB/s`,
  ];
  return lines.join('\n');
}

export function nowPlayingText(np: NowPlaying): string {
  const lines = [
    `title: ${np.title || '—'}`,
    `artist: ${np.artist || '—'}`,
    `album: ${np.album || '—'}`,
    `source: ${np.source}`,
    `playing: ${np.playing ? 'yes' : 'no'}`,
  ];
  if (np.duration_sec != null) {
    lines.push(
      `position_sec: ${np.position_sec ?? 0}`,
      `duration_sec: ${np.duration_sec}`,
    );
  }
  return lines.join('\n');
}

export type DevicesEnvironmentPayload = {
  net: NetStats | null;
  nowPlaying: NowPlaying | null;
  daemons: ReadonlyArray<Daemon>;
};

export function devicesEnvironmentJson(payload: DevicesEnvironmentPayload): string {
  return JSON.stringify(payload, null, 2);
}
