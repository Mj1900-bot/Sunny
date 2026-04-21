// ─────────────────────────────────────────────────────────────────
// Scheduler API (thin wrappers around final Tauri command surface)
// ─────────────────────────────────────────────────────────────────

import { invoke } from '../../lib/tauri';
import type { AddArgs, Job } from './types';

export function schedulerList(): Promise<Job[]> {
  return invoke<Job[]>('scheduler_list');
}

export function schedulerAdd(args: AddArgs): Promise<Job> {
  return invoke<Job>('scheduler_add', args as unknown as Record<string, unknown>);
}

export function schedulerDelete(id: string): Promise<void> {
  return invoke<void>('scheduler_delete', { id });
}

export function schedulerSetEnabled(id: string, enabled: boolean): Promise<Job> {
  return invoke<Job>('scheduler_set_enabled', { id, enabled });
}

export function schedulerRunOnce(id: string): Promise<Job> {
  return invoke<Job>('scheduler_run_once', { id });
}

export type JobPatch = {
  title?: string;
  every_sec?: number;
};

export function schedulerUpdate(id: string, patch: JobPatch): Promise<Job> {
  return invoke<Job>('scheduler_update', { id, patch: patch as unknown as Record<string, unknown> });
}
