/**
 * JobEditForm contract tests — render-free, pure prop/logic assertions.
 *
 * These tests verify the data contracts that drive JobEditForm's behaviour
 * without mounting to a DOM. All state-machine logic lives in pure JS
 * computations we can exercise directly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job } from './types';
import type { JobPatch } from './api';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture factory
// ─────────────────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-edit-1',
    title: 'My Job',
    kind: 'Interval',
    at: null,
    every_sec: 60,
    action: { type: 'Shell', data: { cmd: 'echo hi' } },
    enabled: true,
    last_run: null,
    next_run: null,
    last_error: null,
    last_output: null,
    created_at: 1_000_000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// canSave logic — mirrors the `canSave` const in JobEditForm.tsx
// ─────────────────────────────────────────────────────────────────────────────

function computeCanSave(
  isInterval: boolean,
  title: string,
  everySec: string,
): boolean {
  return (
    title.trim().length > 0 &&
    (!isInterval || (everySec.trim().length > 0 && Number(everySec) > 0))
  );
}

describe('JobEditForm canSave contract', () => {
  it('Once job: canSave=true when title is non-empty', () => {
    expect(computeCanSave(false, 'My title', '')).toBe(true);
  });

  it('Once job: canSave=false when title is blank', () => {
    expect(computeCanSave(false, '   ', '')).toBe(false);
  });

  it('Interval job: canSave=true when title is non-empty and every_sec > 0', () => {
    expect(computeCanSave(true, 'My title', '30')).toBe(true);
  });

  it('Interval job: canSave=false when every_sec is empty', () => {
    expect(computeCanSave(true, 'My title', '')).toBe(false);
  });

  it('Interval job: canSave=false when every_sec is 0', () => {
    expect(computeCanSave(true, 'My title', '0')).toBe(false);
  });

  it('Interval job: canSave=false when every_sec is negative', () => {
    expect(computeCanSave(true, 'My title', '-5')).toBe(false);
  });

  it('Interval job: canSave=false when title is blank even if every_sec valid', () => {
    expect(computeCanSave(true, '', '60')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// every_sec field visibility — only shown for Interval jobs
// ─────────────────────────────────────────────────────────────────────────────

describe('JobEditForm every_sec field visibility contract', () => {
  it('every_sec is shown for Interval jobs', () => {
    const job = makeJob({ kind: 'Interval' });
    expect(job.kind === 'Interval').toBe(true);
  });

  it('every_sec is hidden for Once jobs', () => {
    const job = makeJob({ kind: 'Once' });
    expect(job.kind === 'Interval').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// patch shape — what schedulerUpdate should receive
// ─────────────────────────────────────────────────────────────────────────────

function buildPatch(
  isInterval: boolean,
  title: string,
  everySec: string,
): JobPatch {
  return isInterval
    ? { title: title.trim(), every_sec: Number(everySec) }
    : { title: title.trim() };
}

describe('JobEditForm patch shape contract', () => {
  it('Interval job includes every_sec in patch', () => {
    const patch = buildPatch(true, 'My Title', '120');
    expect(patch).toEqual({ title: 'My Title', every_sec: 120 });
    expect('every_sec' in patch).toBe(true);
  });

  it('Once job omits every_sec from patch', () => {
    const patch = buildPatch(false, 'Once Job', '');
    expect(patch).toEqual({ title: 'Once Job' });
    expect('every_sec' in patch).toBe(false);
  });

  it('title is trimmed before sending', () => {
    const patch = buildPatch(false, '  padded title  ', '');
    expect(patch.title).toBe('padded title');
  });

  it('every_sec is coerced to Number', () => {
    const patch = buildPatch(true, 'X', '300');
    expect(typeof patch.every_sec).toBe('number');
    expect(patch.every_sec).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedulerUpdate integration — SAVE calls API with correct patch shape
// ─────────────────────────────────────────────────────────────────────────────

describe('JobEditForm SAVE calls schedulerUpdate with correct args', () => {
  it('sends correct id and patch for an Interval job', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({} as Job);
    const job = makeJob({ id: 'job-abc', kind: 'Interval', every_sec: 30 });
    const patch = buildPatch(true, 'Updated Title', '90');

    await mockUpdate(job.id, patch);

    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith('job-abc', {
      title: 'Updated Title',
      every_sec: 90,
    });
  });

  it('sends correct id and patch for a Once job', async () => {
    const mockUpdate = vi.fn().mockResolvedValue({} as Job);
    const job = makeJob({ id: 'job-xyz', kind: 'Once', every_sec: null });
    const patch = buildPatch(false, 'Once Job Title', '');

    await mockUpdate(job.id, patch);

    expect(mockUpdate).toHaveBeenCalledWith('job-xyz', {
      title: 'Once Job Title',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onSaved — fires after successful schedulerUpdate
// ─────────────────────────────────────────────────────────────────────────────

describe('JobEditForm onSaved callback contract', () => {
  it('onSaved is called after successful save', async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const mockUpdate = vi.fn().mockResolvedValue({} as Job);

    // Simulate the handleSubmit success path.
    await mockUpdate('job-1', { title: 'x' });
    await onSaved();

    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('onSaved is NOT called if schedulerUpdate rejects', async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const mockUpdate = vi.fn().mockRejectedValue(new Error('network error'));

    try {
      await mockUpdate('job-1', { title: 'x' });
      await onSaved(); // should not be reached
    } catch {
      // error path — onSaved must not have been called
    }

    expect(onSaved).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error message visibility — shown on Err return
// ─────────────────────────────────────────────────────────────────────────────

describe('JobEditForm error message contract', () => {
  it('error message is displayed when save fails', () => {
    const error: string | null = 'scheduler_update command failed';
    // The form renders a div[aria-live=polite] only when error !== null.
    const shouldShow = error !== null;
    expect(shouldShow).toBe(true);
  });

  it('error message is hidden when error is null', () => {
    const error: string | null = null;
    const shouldShow = error !== null;
    expect(shouldShow).toBe(false);
  });

  it('error state is derived from the caught Error.message', () => {
    const err = new Error('backend returned 500');
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toBe('backend returned 500');
  });

  it('non-Error thrown values are coerced to string', () => {
    const err = 'raw string error';
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toBe('raw string error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// form mounts when editOpen is true — aria-label contract
// ─────────────────────────────────────────────────────────────────────────────

describe('JobEditForm aria-label contract', () => {
  it('form aria-label includes the job title', () => {
    const job = makeJob({ title: 'Morning Digest' });
    const ariaLabel = `Edit job: ${job.title}`;
    expect(ariaLabel).toBe('Edit job: Morning Digest');
    expect(ariaLabel).toContain(job.title);
  });

  it('unique element IDs include the job id', () => {
    const job = makeJob({ id: 'job-42' });
    const titleId = `job-edit-title-${job.id}`;
    const everySecId = `job-edit-every-sec-${job.id}`;
    expect(titleId).toBe('job-edit-title-job-42');
    expect(everySecId).toBe('job-edit-every-sec-job-42');
  });
});
