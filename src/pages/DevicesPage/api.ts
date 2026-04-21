import { invokeSafe } from '../../lib/tauri';

export type Daemon = {
  id: string;
  title: string;
  kind: string;
  at: number | null;
  every_sec: number | null;
  on_event: string | null;
  goal: string;
  enabled: boolean;
  next_run: number | null;
  last_run: number | null;
  last_status: string | null;
  last_output: string | null;
};

export type NowPlaying = {
  title: string;
  artist: string;
  album: string;
  source: 'spotify' | 'music' | 'system' | 'none' | string;
  playing: boolean;
  position_sec: number | null;
  duration_sec: number | null;
};

export type NetStats = {
  ssid?: string | null;
  public_ip?: string | null;
  iface?: string | null;
  ping_ms?: number | null;
  down_kbps?: number | null;
  up_kbps?: number | null;
};

export async function listDaemons(): Promise<ReadonlyArray<Daemon>> {
  return (await invokeSafe<Daemon[]>('daemons_list')) ?? [];
}

export async function setDaemonEnabled(id: string, enabled: boolean): Promise<void> {
  await invokeSafe('daemons_set_enabled', { id, enabled });
}

export async function nowPlaying(): Promise<NowPlaying | null> {
  return invokeSafe<NowPlaying>('media_now_playing');
}

export async function getNet(): Promise<NetStats | null> {
  return invokeSafe<NetStats>('get_net');
}

export async function togglePlayPause(): Promise<void> {
  await invokeSafe('media_toggle_play_pause');
}
export async function mediaNext(): Promise<void> { await invokeSafe('media_next'); }
export async function mediaPrev(): Promise<void> { await invokeSafe('media_prev'); }

/** Trigger a daemon to run immediately via the scheduler. */
export async function runDaemonNow(id: string): Promise<void> {
  await invokeSafe('scheduler_run_once', { id });
}
