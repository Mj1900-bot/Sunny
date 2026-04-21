import { Suspense, type ReactNode } from 'react';
import { useView } from '../store/view';

type Props = {
  title: string;
  /** Retained for backward compat with callers; no longer rendered. */
  badge?: string;
  children: ReactNode;
};

/**
 * Minimal HUD-themed fallback for lazy-loaded module bodies.
 * No spinner — a quiet mono "LOADING" row that matches the existing chrome.
 */
function ModuleLoading() {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '0.24em',
        color: 'var(--cyan)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 2px',
      }}
    >
      <span>LOADING</span>
      <span style={{ color: 'var(--ink-dim)' }}>·····</span>
    </div>
  );
}

/**
 * Full-screen module page shown on top of the ORB panel when a nav item
 * other than OVERVIEW is active. The sci-fi HUD chrome stays around it.
 */
export function ModuleView({ title, badge: _badge, children }: Props) {
  const setView = useView(s => s.setView);

  return (
    <div className="module-view panel" id="p-orb">
      <div className="c1" />
      <div className="c2" />
      <h3>
        {title}
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            onClick={() => setView('overview')}
            style={{
              all: 'unset', cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 10,
              letterSpacing: '0.18em', color: 'var(--cyan)',
              padding: '2px 8px', border: '1px solid var(--line-soft)',
            }}
          >
            ESC · OVERVIEW
          </button>
        </span>
      </h3>
      <div className="body" style={{ padding: 16, overflow: 'auto' }}>
        <Suspense fallback={<ModuleLoading />}>{children}</Suspense>
      </div>
    </div>
  );
}
