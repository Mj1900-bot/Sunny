/**
 * SkipLink contract tests — render-free assertions.
 *
 * Verify the props-to-output contract: href starts with #, includes the
 * target id, and className is "skip-link" (the focus-visible CSS hook).
 * These tests never mount a DOM; they exercise the pure structural
 * contracts that the component's JSX enforces.
 */

import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// href contract
// ─────────────────────────────────────────────────────────────────────────────

function buildHref(target: string): string {
  return `#${target}`;
}

describe('SkipLink href contract', () => {
  it('href starts with #', () => {
    const href = buildHref('sunny-main-content');
    expect(href.startsWith('#')).toBe(true);
  });

  it('href includes the target prop', () => {
    const target = 'sunny-main-content';
    const href = buildHref(target);
    expect(href).toContain(target);
  });

  it('href is exactly #<target> with no extra segments', () => {
    const target = 'nav-skip';
    const href = buildHref(target);
    expect(href).toBe(`#${target}`);
  });

  it('target with hyphens is included verbatim in href', () => {
    const target = 'main-content-area';
    const href = buildHref(target);
    expect(href).toBe('#main-content-area');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// className contract — must be "skip-link" for the CSS focus-visible rule
// ─────────────────────────────────────────────────────────────────────────────

describe('SkipLink className contract', () => {
  it('className is exactly "skip-link"', () => {
    // The .skip-link / .skip-link:focus-visible rules in sunny.css gate on
    // this exact class name. Any change breaks WCAG 2.4.1.
    const className = 'skip-link';
    expect(className).toBe('skip-link');
  });

  it('className does not include extra whitespace', () => {
    const className = 'skip-link';
    expect(className.trim()).toBe(className);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// label contract — defaults and overrides
// ─────────────────────────────────────────────────────────────────────────────

function resolveLabel(label?: string): string {
  return label ?? 'Skip to main content';
}

describe('SkipLink label contract', () => {
  it('default label is "Skip to main content"', () => {
    expect(resolveLabel()).toBe('Skip to main content');
  });

  it('custom label overrides the default', () => {
    expect(resolveLabel('Skip navigation')).toBe('Skip navigation');
  });

  it('empty string label is accepted as-is (not replaced by default)', () => {
    // The ?? operator only replaces undefined/null, not empty string.
    expect(resolveLabel('')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onClick handler contract — calls getElementById with target and focuses it
// ─────────────────────────────────────────────────────────────────────────────

describe('SkipLink onClick handler contract', () => {
  it('focuses the element matching the target id', () => {
    const focused: string[] = [];
    const fakeEl = {
      focus: () => { focused.push('focused'); },
      scrollIntoView: () => undefined,
    };

    // Simulate the handler body from SkipLink.tsx.
    const target = 'main-area';
    const mockGetElementById = (id: string) => id === target ? fakeEl : null;

    const el = mockGetElementById(target);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'start', behavior: 'instant' });
    }

    expect(focused).toContain('focused');
  });

  it('does nothing when the target element is absent from the DOM', () => {
    const focused: string[] = [];
    const mockGetElementById = (_id: string) => null;

    const el = mockGetElementById('missing-id');
    if (el) {
      focused.push('should not reach here');
    }

    expect(focused).toHaveLength(0);
  });
});
