// ─────────────────────────────────────────────────────────────────
// Scheduler backend types — numeric wire shape tracks the
// auto-generated ts-rs bindings (`src/bindings/Job*.ts`). Regenerate
// with `cd src-tauri && cargo test --lib export_bindings_`.
//
// `JobKind` and `JobAction` intentionally stay local:
//   • `JobKind` — consumer code (draft forms, row chips, template
//     helpers) compares `d.kind === 'Once'`, the legacy string form.
//     The Rust serde `#[serde(tag = "type")]` actually ships
//     `{ "type": "Once" }` at runtime — handled in `kindTagOf()`
//     below — but we keep the TS surface stable rather than
//     retrofitting every caller.
//   • `JobAction` — the bindings' Speak variant declares
//     `voice: string | null, rate: number | null` (ts-rs mirrors
//     `Option<T>` as `T | null`). Consumers build Speak actions
//     by conditionally assigning `voice` / `rate`, which yields
//     `voice?: string`. Serde happily treats a missing field as
//     `None`, so the local looser shape is wire-compatible with
//     Rust without forcing every caller to thread explicit nulls.
// ─────────────────────────────────────────────────────────────────

export type JobKind = 'Once' | 'Interval';

export type JobAction =
  | { type: 'Shell'; data: { cmd: string } }
  | { type: 'Notify'; data: { title: string; body: string } }
  | { type: 'Speak'; data: { text: string; voice?: string; rate?: number } }
  | {
      type: 'AgentGoal';
      data: { goal: string; speak_answer?: boolean; write_note?: string | null };
    };

export type Job = {
  id: string;
  title: string;
  kind: JobKind;
  at: number | null;
  every_sec: number | null;
  action: JobAction;
  enabled: boolean;
  last_run: number | null;
  next_run: number | null;
  last_error: string | null;
  last_output: string | null;
  created_at: number;
};

export type ActionType = JobAction['type'];

/** Actions the NEW JOB form can create (seeded `AgentGoal` jobs are Rust-only). */
export type FormActionType = Exclude<ActionType, 'AgentGoal'>;

export type AddArgs = {
  title: string;
  kind: JobKind;
  at?: number;
  every_sec?: number;
  action: JobAction;
};

// ─────────────────────────────────────────────────────────────────
// NEW-JOB draft state
// ─────────────────────────────────────────────────────────────────

export type IntervalUnit = 's' | 'm' | 'h' | 'd';

export type Draft = {
  title: string;
  kind: JobKind;
  onceLocal: string; // datetime-local value
  intervalValue: string; // numeric string
  intervalUnit: IntervalUnit;
  actionType: FormActionType;
  shellCmd: string;
  notifyTitle: string;
  notifyBody: string;
  speakText: string;
  speakVoice: string;
  speakRate: string;
};

// ─────────────────────────────────────────────────────────────────
// R9-2: job templates + derived status
//
// Mirrors `scheduler_templates::JobTemplate` (serde default camelCase off —
// the Rust struct uses snake_case field names that serde passes through).
// ─────────────────────────────────────────────────────────────────

export type JobTemplate = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly schedule_hint: string;
  readonly kind: JobKind;
  readonly every_sec: number | null;
  readonly action: JobAction;
};

/** Derived from `last_error`/`last_run`: green / red / dim dot in the card. */
export type JobStatus = 'ok' | 'error' | 'never';

export function jobStatus(job: Job): JobStatus {
  if (job.last_error !== null && job.last_error.length > 0) return 'error';
  if (job.last_run !== null) return 'ok';
  return 'never';
}

/**
 * At runtime, Rust's `#[serde(tag = "type")] enum JobKind { Once, Interval }`
 * serialises to `{ "type": "Once" }` / `{ "type": "Interval" }`. The legacy
 * `JobKind` string union above describes what the *old* UI thought it was
 * getting; the discriminator below is what actually lands in JS.
 *
 * Only the new Auto page consumes this. Existing callers continue to use the
 * string form.
 */
export type JobKindTag = { readonly type: 'Once' } | { readonly type: 'Interval' };

export function kindTagOf(job: Job): JobKindTag {
  // Pre-existing code already treats `Job['kind']` as a string, but the
  // runtime value from the Rust side is `{ type: "Once" | "Interval" }`.
  // Support both so this helper is safe in every context.
  const raw: unknown = job.kind;
  if (typeof raw === 'string') {
    return raw === 'Once' ? { type: 'Once' } : { type: 'Interval' };
  }
  if (raw !== null && typeof raw === 'object' && 'type' in raw) {
    const t = (raw as { type: unknown }).type;
    return t === 'Once' ? { type: 'Once' } : { type: 'Interval' };
  }
  return { type: 'Interval' };
}
