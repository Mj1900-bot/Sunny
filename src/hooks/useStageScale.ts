import { useEffect } from 'react';

/**
 * Scales the 1600×900 stage to fill the current window on BOTH axes.
 * We scale x and y independently so there's never black space at the
 * edges when the window aspect differs from 16:9. The orb canvas uses
 * `min(W, H)` internally so it stays circular regardless of the
 * container stretch.
 */
export function useStageScale(designWidth = 1600, designHeight = 900) {
  useEffect(() => {
    const fit = () => {
      const sx = window.innerWidth / designWidth;
      const sy = window.innerHeight / designHeight;
      document.documentElement.style.setProperty('--sx', String(sx));
      document.documentElement.style.setProperty('--sy', String(sy));
      // Keep --scale as the smaller of the two for components that want
      // a proportional value (orb intensity, etc).
      document.documentElement.style.setProperty('--scale', String(Math.min(sx, sy)));
    };

    fit();
    window.addEventListener('resize', fit);

    const ro = new ResizeObserver(() => fit());
    ro.observe(document.documentElement);

    const vv = window.visualViewport;
    if (vv) vv.addEventListener('resize', fit);

    return () => {
      window.removeEventListener('resize', fit);
      ro.disconnect();
      if (vv) vv.removeEventListener('resize', fit);
    };
  }, [designWidth, designHeight]);
}
