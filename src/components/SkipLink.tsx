/**
 * SkipLink — WCAG 2.4.1 "Bypass Blocks" skip navigation link.
 *
 * Visually hidden (off-screen) until keyboard-focused, then revealed at the
 * top-left of the viewport via the `.skip-link` / `.skip-link:focus-visible`
 * rules in sunny.css.  The onClick handler programmatically focuses the target
 * element so activation works regardless of whether the browser moves focus on
 * <a href="#…"> anchor clicks (behavior varies across Tauri's webview).
 *
 * Usage:
 *   <SkipLink target="sunny-main-content" />
 *   <main id="sunny-main-content" tabIndex={-1} style={{ outline: 'none' }}>…</main>
 *
 * The target element must have tabIndex={-1} so it is programmatically
 * focusable without entering the natural tab order.
 */

import type { JSX } from 'react';

type Props = {
  /** id of the landmark element to jump to (without the leading #). */
  readonly target: string;
  /** Link label — defaults to "Skip to main content". */
  readonly label?: string;
};

export function SkipLink({ target, label = 'Skip to main content' }: Props): JSX.Element {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const el = document.getElementById(target);
    if (el) {
      el.focus();
      // Scroll into view in case the stage has a CSS transform applied.
      el.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  };

  return (
    <a href={`#${target}`} className="skip-link" onClick={handleClick}>
      {label}
    </a>
  );
}
