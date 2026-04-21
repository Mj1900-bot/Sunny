// TerminalsOverlay/useWindowDrag.ts
//
// Hook that turns a fixed-position div into a draggable, resizable,
// maximizable floating window.  Used by the TerminalsOverlay shell.

import { useCallback, useEffect, useRef, useState } from 'react';

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_W = 640;
const MIN_H = 400;

export function useWindowDrag() {
  // -1 signals "not yet initialised — derive from viewport".
  const [rect, setRect] = useState<Rect>({ x: -1, y: -1, w: -1, h: -1 });
  const [maximized, setMaximized] = useState(false);
  const [active, setActive] = useState(false);

  const ref = useRef<{
    mode: 'move' | Edge;
    sx: number;
    sy: number;
    orig: Rect;
  } | null>(null);

  const preMax = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });

  // Derive initial size from local storage or viewport once.
  useEffect(() => {
    if (rect.w >= 0) return;
    try {
      const saved = localStorage.getItem('sunny-terminals-rect');
      const maxed = localStorage.getItem('sunny-terminals-max');
      if (maxed === 'true') {
        setMaximized(true);
      }
      if (saved) {
        const r = JSON.parse(saved) as Rect;
        // Clamp to ensure it's not off-screen if monitors changed
        const clampedW = Math.min(r.w, window.innerWidth);
        const clampedH = Math.min(r.h, window.innerHeight);
        const clampedX = Math.max(0, Math.min(r.x, window.innerWidth - 100));
        const clampedY = Math.max(0, Math.min(r.y, window.innerHeight - 100));
        const finalR = { x: clampedX, y: clampedY, w: clampedW, h: clampedH };
        setRect(finalR);
        preMax.current = finalR;
        return;
      }
    } catch {}

    const w = Math.min(Math.round(window.innerWidth * 0.7), 1200);
    const h = Math.min(Math.round(window.innerHeight * 0.7), 800);
    const x = Math.round((window.innerWidth - w) / 2);
    const y = Math.round((window.innerHeight - h) / 2);
    const r: Rect = { x, y, w, h };
    setRect(r);
    preMax.current = r;
  }, [rect.w]);

  // Unified mouse tracking for both move and edge-resize.
  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      const d = ref.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;

      if (d.mode === 'move') {
        setRect({ ...d.orig, x: d.orig.x + dx, y: Math.max(0, d.orig.y + dy) });
        return;
      }

      // Edge resize — each edge affects different dimensions.
      const o = d.orig;
      let { x, y, w, h } = o;
      const edge: string = d.mode;
      if (edge.includes('e')) w = Math.max(MIN_W, o.w + dx);
      if (edge.includes('s')) h = Math.max(MIN_H, o.h + dy);
      if (edge.includes('w')) {
        const nw = Math.max(MIN_W, o.w - dx);
        x = o.x + (o.w - nw);
        w = nw;
      }
      if (edge.includes('n')) {
        const nh = Math.max(MIN_H, o.h - dy);
        y = Math.max(0, o.y + (o.h - nh));
        h = nh;
      }
      setRect({ x, y, w, h });
    };
    const onUp = () => {
      ref.current = null;
      setActive(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [active]);

  // Sync state to local storage when not actively dragging
  useEffect(() => {
    if (active || rect.w < 0) return;
    localStorage.setItem('sunny-terminals-rect', JSON.stringify(rect));
    localStorage.setItem('sunny-terminals-max', String(maximized));
  }, [rect, maximized, active]);

  const startMove = useCallback(
    (e: React.MouseEvent) => {
      if (maximized) return;
      ref.current = { mode: 'move', sx: e.clientX, sy: e.clientY, orig: rect };
      setActive(true);
    },
    [rect, maximized],
  );

  const startEdge = useCallback(
    (edge: Edge, e: React.MouseEvent) => {
      if (maximized) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current = { mode: edge, sx: e.clientX, sy: e.clientY, orig: rect };
      setActive(true);
    },
    [rect, maximized],
  );

  const toggleMax = useCallback(() => {
    setMaximized(prev => {
      if (!prev) {
        preMax.current = rect;
        return true;
      }
      setRect(preMax.current);
      return false;
    });
  }, [rect]);

  return { rect, maximized, active, startMove, startEdge, toggleMax };
}
