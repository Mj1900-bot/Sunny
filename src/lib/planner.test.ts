import { describe, expect, it } from 'vitest';
import { __internal } from './planner';

const { shouldSkip, evaluateSkip, extractLargestObject, parseDecomposition } =
  __internal;

describe('shouldSkip', () => {
  describe('short-goal guard', () => {
    it('skips goals under the minimum length', () => {
      expect(shouldSkip('open safari')).toBe(true);
      expect(shouldSkip('')).toBe(true);
      expect(shouldSkip('   ')).toBe(true);
    });
  });

  describe('ASCII conjunctions', () => {
    it('does not skip on " and "', () => {
      expect(shouldSkip('deploy sunny and text mom about it')).toBe(false);
    });

    it('does not skip on " then "', () => {
      expect(shouldSkip('build the project then run the tests please')).toBe(false);
    });

    it('does not skip on "; "', () => {
      expect(shouldSkip('commit everything; push to main please')).toBe(false);
    });

    it('does not skip on ", then "', () => {
      expect(shouldSkip('fix the bug, then open a pull request')).toBe(false);
    });

    it('does not skip on " after "', () => {
      expect(shouldSkip('deploy the app after the tests finish running')).toBe(false);
    });
  });

  describe('& conjunction', () => {
    it('does not skip on whitespace-flanked "&"', () => {
      expect(shouldSkip('build the image & push to registry')).toBe(false);
    });

    it('skips on identifier-like "&" (no whitespace)', () => {
      // `foo&bar` should NOT count as a conjunction.
      expect(shouldSkip('grep for foo&bar in the logfile output')).toBe(true);
    });
  });

  describe('em-dash / en-dash', () => {
    it('does not skip on em-dash', () => {
      expect(shouldSkip('deploy sunny—text mom about it later')).toBe(false);
    });

    it('does not skip on en-dash', () => {
      expect(shouldSkip('pull the repo – then build it please')).toBe(false);
    });
  });

  describe('non-English conjunctions', () => {
    it('does not skip on Chinese 和', () => {
      expect(shouldSkip('请帮我部署应用程序和通知妈妈这件事情并发送电子邮件')).toBe(false);
    });

    it('does not skip on Chinese 以及', () => {
      expect(shouldSkip('请帮我部署应用程序以及通知妈妈这件事情并发送电子邮件')).toBe(false);
    });

    it('does not skip on Korean 와/과', () => {
      expect(shouldSkip('애플리케이션 배포와 엄마에게 알림을 보내주세요 부탁합니다')).toBe(false);
    });

    it('does not skip on Spanish " y "', () => {
      expect(shouldSkip('despliega la aplicación y avisa a mamá')).toBe(false);
    });

    it('does not skip on French " et "', () => {
      expect(shouldSkip('déploie l application et envoie un message')).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('does not skip when conjunctions appear in upper case', () => {
      expect(shouldSkip('Deploy Sunny AND Text Mom About It')).toBe(false);
      expect(shouldSkip('BUILD THE PROJECT THEN RUN THE TESTS')).toBe(false);
    });
  });

  describe('idiomatic phrases (false-positive avoidance)', () => {
    it('skips "black and white" when it is the only conjunction', () => {
      expect(shouldSkip('render the diagram in black and white')).toBe(true);
    });

    it('skips "salt and pepper"', () => {
      expect(shouldSkip('add some salt and pepper to the recipe')).toBe(true);
    });

    it('skips "trial and error"', () => {
      expect(shouldSkip('figure it out through trial and error')).toBe(true);
    });

    it('still splits when an idiom co-occurs with a real conjunction', () => {
      // "black and white" is idiomatic, but " then " still triggers.
      expect(
        shouldSkip('render it in black and white then open the file'),
      ).toBe(false);
    });
  });

  describe('single-clause goals', () => {
    it('skips goals without any conjunction', () => {
      expect(shouldSkip('summarize this entire file for me please')).toBe(true);
      expect(shouldSkip('write a detailed plan for the project')).toBe(true);
    });
  });

  // ---- sprint-7 Agent H: more aggressive voice-transcript triggers ----

  describe('sprint-7 voice-transcript triggers', () => {
    it('decomposes the canonical voice pattern "deploy sunny and text mom about it"', () => {
      expect(shouldSkip('deploy sunny and text mom about it')).toBe(false);
    });

    it('decomposes "ship it + text mom" (plus as conjunction)', () => {
      // 19 chars, below the old 16-char floor BUT relies on ` + `.
      expect(shouldSkip('ship it + text mom')).toBe(false);
    });

    it('decomposes "first call mom, then remind me about the meeting"', () => {
      expect(
        shouldSkip('first call mom, then remind me about the meeting'),
      ).toBe(false);
    });

    it('does NOT decompose "what\'s the weather and time" (single-subject compound)', () => {
      expect(shouldSkip("what's the weather and time")).toBe(true);
    });

    it('does NOT decompose "how many cats and dogs are there"', () => {
      expect(shouldSkip('how many cats and dogs are there')).toBe(true);
    });

    it('still decomposes wh-queries with strong secondary signals', () => {
      // "and also" is a strong multi-goal marker that beats wh-compound.
      expect(
        shouldSkip("what's the weather and also remind me about the call"),
      ).toBe(false);
    });

    it('decomposes period-separated imperatives', () => {
      expect(
        shouldSkip('update the calendar. send a reminder to john'),
      ).toBe(false);
    });

    it('decomposes numbered lists', () => {
      expect(
        shouldSkip('1. call mom 2. book the flight 3. text sara'),
      ).toBe(false);
    });

    it('decomposes "and also"', () => {
      expect(shouldSkip('review the pr and also merge it soon')).toBe(false);
    });

    it('decomposes "after that"', () => {
      expect(
        shouldSkip('run the migration after that restart the worker'),
      ).toBe(false);
    });

    it('lowered MIN_GOAL_CHARS lets short voice goals through', () => {
      // 13 chars; would have been skipped at the old 16-char floor.
      expect(shouldSkip('call + text ok')).toBe(false);
    });

    it('still skips very short fragments', () => {
      // Below the new 12-char floor.
      expect(shouldSkip('a + b')).toBe(true);
      expect(shouldSkip('hi')).toBe(true);
    });
  });

  describe('evaluateSkip telemetry reasons', () => {
    it('tags short goals as "short"', () => {
      expect(evaluateSkip('hi').reason).toBe('short');
    });

    it('tags plain conjunction matches with the trigger name', () => {
      expect(evaluateSkip('deploy sunny and text mom about it').reason).toBe(
        'has-conj: and',
      );
      expect(
        evaluateSkip('build the project then run the tests please').reason,
      ).toBe('has-conj: then');
      expect(evaluateSkip('ship it + text mom').reason).toBe('has-conj: +');
    });

    it('tags period-imperative patterns', () => {
      expect(
        evaluateSkip('update the calendar. send a reminder to john').reason,
      ).toBe('has-conj: period-imperative');
    });

    it('tags numbered lists', () => {
      expect(
        evaluateSkip('1. call mom 2. book the flight 3. text sara').reason,
      ).toBe('has-conj: numbered-list');
    });

    it('tags wh-compound suppressions', () => {
      expect(evaluateSkip("what's the weather and time").reason).toBe(
        'wh-compound',
      );
    });

    it('tags single-clause goals as "no conj"', () => {
      expect(
        evaluateSkip('summarize this entire file for me please').reason,
      ).toBe('no conj');
    });
  });
});

describe('extractLargestObject', () => {
  it('returns null when there is no object', () => {
    expect(extractLargestObject('no braces in here at all')).toBe(null);
  });

  it('extracts a simple object', () => {
    const input = 'prefix {"a": 1, "b": 2} suffix';
    const out = extractLargestObject(input);
    expect(out).not.toBe(null);
    expect(JSON.parse(out as string)).toEqual({ a: 1, b: 2 });
  });

  it('handles nested objects and picks the outermost', () => {
    const input = '{"outer": {"inner": 1}, "x": 2}';
    const out = extractLargestObject(input);
    expect(out).not.toBe(null);
    expect(JSON.parse(out as string)).toEqual({ outer: { inner: 1 }, x: 2 });
  });

  it('handles escaped quotes inside strings', () => {
    const input = '{"msg": "she said \\"hello\\" to me"}';
    const out = extractLargestObject(input);
    expect(out).not.toBe(null);
    expect(JSON.parse(out as string)).toEqual({ msg: 'she said "hello" to me' });
  });

  it('handles raw newlines inside JSON string values (Agent J bug #3)', () => {
    // A cheap model often emits raw newlines inside string values, which
    // makes JSON.parse throw. extractLargestObject must rewrite them to
    // `\n` so the extracted slice parses.
    const raw = '{"a": "line1\nline2", "b": "quoted \\"word\\""}';
    const out = extractLargestObject(raw);
    expect(out).not.toBe(null);
    const parsed = JSON.parse(out as string);
    expect(parsed).toEqual({ a: 'line1\nline2', b: 'quoted "word"' });
  });

  it('handles raw tabs and carriage returns inside strings', () => {
    const raw = '{"a": "col1\tcol2\r\nrow2"}';
    const out = extractLargestObject(raw);
    expect(out).not.toBe(null);
    expect(JSON.parse(out as string)).toEqual({ a: 'col1\tcol2\r\nrow2' });
  });

  it('does not confuse a backslash before an escaped quote with a real close', () => {
    const raw = '{"k": "a\\"b", "done": true}';
    const out = extractLargestObject(raw);
    expect(out).not.toBe(null);
    expect(JSON.parse(out as string)).toEqual({ k: 'a"b', done: true });
  });

  it('strips prose/markdown around the object', () => {
    const raw =
      'Sure, here is your answer: ```json\n{"decompose": true, "subgoals": ["a","b"]}\n``` hope that helps!';
    const out = extractLargestObject(raw);
    expect(out).not.toBe(null);
    expect(JSON.parse(out as string)).toEqual({
      decompose: true,
      subgoals: ['a', 'b'],
    });
  });
});

describe('parseDecomposition (integration)', () => {
  it('parses a well-formed decomposition', () => {
    const raw = JSON.stringify({
      decompose: true,
      subgoals: ['sub one', 'sub two'],
      rationale: 'two independent tasks',
    });
    const out = parseDecomposition(raw);
    expect(out).not.toBe(null);
    expect(out?.subgoals).toEqual(['sub one', 'sub two']);
    expect(out?.rationale).toBe('two independent tasks');
  });

  it('recovers from raw newlines inside sub-goal strings', () => {
    // The shape that previously made the decomposer bail.
    const raw = `{
      "decompose": true,
      "subgoals": ["step one
with a newline", "step two"],
      "rationale": "line1
line2"
    }`;
    const out = parseDecomposition(raw);
    expect(out).not.toBe(null);
    expect(out?.subgoals.length).toBe(2);
  });

  it('returns null when decompose is false', () => {
    const raw = JSON.stringify({ decompose: false, subgoals: [] });
    expect(parseDecomposition(raw)).toBe(null);
  });

  it('returns null on total garbage', () => {
    expect(parseDecomposition('lol not json at all')).toBe(null);
  });
});
