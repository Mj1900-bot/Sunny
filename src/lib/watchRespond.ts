/**
 * watchRespond - generic rule engine: pattern to action over a streaming text source.
 *
 * Polls a cumulative text source on a tick. Diffs against the previous buffer to
 * isolate NEW text, then runs each rule's regex against a bounded trailing window
 * (last WINDOW_BYTES of the full buffer) so regex backtracking stays cheap even
 * when the stream grows into megabytes.
 *
 * Used by the Claude Code tool and others to react to CLI output: answer prompts,
 * detect completion, report progress, bail on errors, etc.
 */

// ---------- Public types ----------

export type WatchActionResult = {
  readonly respond?: string;
  readonly stop?: boolean;
  readonly note?: string;
};

export type WatchContext = {
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly lastResponse: string | null;
};

export type WatchRule = {
  readonly pattern: RegExp;
  readonly name: string;
  readonly action: (
    match: RegExpExecArray,
    ctx: WatchContext,
  ) => Promise<WatchActionResult>;
  readonly once?: boolean;
  readonly cooldownMs?: number;
};

export type WatchSource = {
  readonly read: () => Promise<string>;
  readonly write: (text: string) => Promise<void>;
};

export type WatchEvent = {
  readonly t: number;
  readonly kind: 'match' | 'respond' | 'stop' | 'timeout' | 'abort' | 'error';
  readonly name?: string;
  readonly note?: string;
};

export type WatchOptions = {
  readonly rules: ReadonlyArray<WatchRule>;
  readonly timeoutMs?: number;
  readonly tickMs?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (e: WatchEvent) => void;
};

export type WatchResult = {
  readonly stopReason: 'rule_stop' | 'timeout' | 'abort' | 'error';
  readonly matches: number;
  readonly elapsedMs: number;
};

// ---------- Constants ----------

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_TICK_MS = 500;
/** Trailing window size for regex scanning - bounds backtracking cost. */
const WINDOW_BYTES = 8 * 1024;

// ---------- Per-rule runtime state (kept in closure, never mutated in place) ----------

type RuleState = {
  readonly lastFiredAt: number;
  readonly hitCount: number;
};

const makeInitialState = (): RuleState => ({ lastFiredAt: 0, hitCount: 0 });

const markFired = (prev: RuleState, at: number): RuleState => ({
  lastFiredAt: at,
  hitCount: prev.hitCount + 1,
});

// ---------- Utilities ----------

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const trailingWindow = (text: string): string =>
  text.length > WINDOW_BYTES ? text.slice(text.length - WINDOW_BYTES) : text;

const makeCtx = (
  bytes: number,
  elapsedMs: number,
  lastResponse: string | null,
): WatchContext => ({ bytes, elapsedMs, lastResponse });

const isAbortError = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'name' in e &&
  (e as { name?: string }).name === 'AbortError';

// ---------- Core loop ----------

export async function runWatch(
  source: WatchSource,
  opts: WatchOptions,
): Promise<WatchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const emit = opts.onEvent ?? ((): void => {});
  const startedAt = Date.now();

  // immutable map keyed by rule.name; never mutated - replaced on each update
  let ruleStates: Readonly<Record<string, RuleState>> = Object.freeze(
    Object.fromEntries(opts.rules.map((r) => [r.name, makeInitialState()])),
  );

  let previousLength = 0;
  let matches = 0;
  let lastResponse: string | null = null;

  const finish = (
    stopReason: WatchResult['stopReason'],
  ): WatchResult => ({
    stopReason,
    matches,
    elapsedMs: Date.now() - startedAt,
  });

  try {
    // main poll loop
    while (true) {
      if (opts.signal?.aborted) {
        emit({ t: Date.now(), kind: 'abort' });
        return finish('abort');
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        emit({ t: Date.now(), kind: 'timeout' });
        return finish('timeout');
      }

      let buffer: string;
      try {
        buffer = await source.read();
      } catch (err) {
        emit({
          t: Date.now(),
          kind: 'error',
          note: err instanceof Error ? err.message : String(err),
        });
        return finish('error');
      }

      // Diff: if buffer shrank or was replaced, reset offset defensively.
      if (buffer.length < previousLength) {
        previousLength = 0;
      }
      const hadNewBytes = buffer.length > previousLength;
      previousLength = buffer.length;

      if (hadNewBytes) {
        const window = trailingWindow(buffer);

        // iterate rules (order preserved from caller)
        for (const rule of opts.rules) {
          const state = ruleStates[rule.name] ?? makeInitialState();
          if (rule.once === true && state.hitCount > 0) continue;

          const cooldown = rule.cooldownMs ?? 0;
          const now = Date.now();
          if (
            cooldown > 0 &&
            state.lastFiredAt > 0 &&
            now - state.lastFiredAt < cooldown
          ) {
            continue;
          }

          // Fresh regex instance against the bounded trailing window.
          // We do not rely on the rule's lastIndex (callers may reuse patterns).
          const re = new RegExp(
            rule.pattern.source,
            rule.pattern.flags.replace('g', '').replace('y', ''),
          );
          const match = re.exec(window);
          if (match === null) continue;

          matches += 1;
          emit({ t: now, kind: 'match', name: rule.name });

          // Replace the rule state immutably.
          ruleStates = Object.freeze({
            ...ruleStates,
            [rule.name]: markFired(state, now),
          });

          let result: WatchActionResult;
          try {
            result = await rule.action(
              match,
              makeCtx(buffer.length, now - startedAt, lastResponse),
            );
          } catch (err) {
            emit({
              t: Date.now(),
              kind: 'error',
              name: rule.name,
              note: err instanceof Error ? err.message : String(err),
            });
            return finish('error');
          }

          if (result.note !== undefined) {
            emit({
              t: Date.now(),
              kind: 'match',
              name: rule.name,
              note: result.note,
            });
          }

          if (result.respond !== undefined) {
            try {
              await source.write(result.respond);
              lastResponse = result.respond;
              emit({ t: Date.now(), kind: 'respond', name: rule.name });
            } catch (err) {
              emit({
                t: Date.now(),
                kind: 'error',
                name: rule.name,
                note: err instanceof Error ? err.message : String(err),
              });
              return finish('error');
            }
          }

          if (result.stop === true) {
            emit({ t: Date.now(), kind: 'stop', name: rule.name });
            return finish('rule_stop');
          }
        }
      }

      try {
        await sleep(tickMs, opts.signal);
      } catch (err) {
        if (isAbortError(err)) {
          emit({ t: Date.now(), kind: 'abort' });
          return finish('abort');
        }
        emit({
          t: Date.now(),
          kind: 'error',
          note: err instanceof Error ? err.message : String(err),
        });
        return finish('error');
      }
    }
  } catch (err) {
    emit({
      t: Date.now(),
      kind: 'error',
      note: err instanceof Error ? err.message : String(err),
    });
    return finish('error');
  }
}

// ---------- Common rules library ----------

export const CommonRules: {
  yesPrompt: (response?: string) => WatchRule;
  shellPromptSettled: (quietMs: number) => WatchRule;
  errorDetect: (onError: (msg: string) => Promise<void>) => WatchRule;
  completionMark: (markers: RegExp[]) => WatchRule;
  progressReporter: (onTick: (line: string) => void) => WatchRule;
  claudePromptReturned: () => WatchRule;
} = {
  /**
   * Matches a yes/no style prompt at the tail of the stream and answers
   * with the given response (default "yes\n"). Cooldown prevents spamming
   * when the same prompt stays on screen across multiple ticks.
   */
  yesPrompt: (response = 'yes\n'): WatchRule => ({
    name: 'yesPrompt',
    pattern:
      /(?:\[y\/n\]|\(y\/n\)|\[Y\/n\]|\(Y\/n\)|\[y\/N\]|\(y\/N\)|yes\/no|\?\s*$)/i,
    cooldownMs: 1500,
    action: async () => ({
      respond: response,
      note: `answered prompt with ${JSON.stringify(response)}`,
    }),
  }),

  /**
   * Fires when the trailing window has been unchanged for `quietMs` and
   * ends in what looks like a shell prompt. Stops the watch loop.
   * Implementation note: we stash the last-seen tail plus timestamp in a
   * closure over the rule object.
   */
  shellPromptSettled: (quietMs: number): WatchRule => {
    let lastTail = '';
    let lastChangeAt = Date.now();
    return {
      name: 'shellPromptSettled',
      pattern: /[$#%\u203A\u276F>]\s*$/,
      action: async (match) => {
        const tail = match[0];
        const now = Date.now();
        if (tail !== lastTail) {
          lastTail = tail;
          lastChangeAt = now;
          return {};
        }
        if (now - lastChangeAt >= quietMs) {
          return { stop: true, note: `prompt settled for ${quietMs}ms` };
        }
        return {};
      },
    };
  },

  /**
   * Surfaces error lines to a user-supplied handler. Does not stop the
   * loop - callers decide whether to bail by combining with completionMark.
   */
  errorDetect: (onError: (msg: string) => Promise<void>): WatchRule => ({
    name: 'errorDetect',
    pattern:
      /^.*\b(?:error|err|fatal|panic|traceback|exception)\b[^\n]*/im,
    cooldownMs: 500,
    action: async (match) => {
      await onError(match[0]);
      return { note: `error line: ${match[0].slice(0, 200)}` };
    },
  }),

  /**
   * Stops the loop when any of the given marker regexes appear.
   * All markers share one rule; the composite pattern is an alternation.
   */
  completionMark: (markers: RegExp[]): WatchRule => {
    const source =
      markers.length === 0
        ? '(?!)'
        : markers.map((m) => `(?:${m.source})`).join('|');
    return {
      name: 'completionMark',
      pattern: new RegExp(source, 'm'),
      once: true,
      action: async (match) => ({
        stop: true,
        note: `completion marker: ${match[0].slice(0, 120)}`,
      }),
    };
  },

  /**
   * Calls onTick for each newly observed line that looks like progress
   * (percent, fractions, progress bars). Does not respond or stop.
   */
  progressReporter: (onTick: (line: string) => void): WatchRule => ({
    name: 'progressReporter',
    pattern: /^[^\n]*(?:\d+%|\d+\/\d+|\[[=#>\-\s]+\])[^\n]*/m,
    cooldownMs: 250,
    action: async (match) => {
      onTick(match[0]);
      return {};
    },
  }),

  /**
   * Claude-Code specific: the CLI returns a prompt glyph on its own line
   * when it's idle and waiting for input. Stops the loop.
   */
  claudePromptReturned: (): WatchRule => ({
    name: 'claudePromptReturned',
    pattern: /(?:^|\n)\s*(?:\u2771|\u203A|>)\s*$/,
    once: true,
    action: async () => ({
      stop: true,
      note: 'claude prompt returned',
    }),
  }),
};

// ---------- Inline test examples (DO NOT EXECUTE) ----------
//
// Example 1 - auto-answer a yes/no prompt and stop when shell settles:
//
//   import { runWatch, CommonRules, type WatchSource } from './watchRespond';
//   let buf = 'installing foo... proceed? [y/N] ';
//   const source: WatchSource = {
//     read: async () => buf,
//     write: async (t) => { buf += `\n${t}done.\n$ `; },
//   };
//   const result = await runWatch(source, {
//     rules: [CommonRules.yesPrompt(), CommonRules.shellPromptSettled(300)],
//     tickMs: 50,
//     timeoutMs: 3000,
//   });
//   // expect: result.stopReason === 'rule_stop', result.matches >= 2
//
// Example 2 - stop on completion marker, detect error once:
//
//   let buf = '';
//   const source: WatchSource = {
//     read: async () => buf,
//     write: async () => {},
//   };
//   const errors: string[] = [];
//   queueMicrotask(() => {
//     buf += 'step 1\nERROR: disk full\nall good - build succeeded\n';
//   });
//   const result = await runWatch(source, {
//     rules: [
//       CommonRules.errorDetect(async (m) => { errors.push(m); }),
//       CommonRules.completionMark([/build succeeded/]),
//     ],
//     tickMs: 10,
//     timeoutMs: 1000,
//   });
//   // expect: result.stopReason === 'rule_stop', errors.length === 1
//
// Example 3 - abort signal:
//
//   const ctrl = new AbortController();
//   setTimeout(() => ctrl.abort(), 50);
//   const result = await runWatch(
//     { read: async () => '', write: async () => {} },
//     { rules: [], signal: ctrl.signal, tickMs: 20, timeoutMs: 5000 },
//   );
//   // expect: result.stopReason === 'abort'
