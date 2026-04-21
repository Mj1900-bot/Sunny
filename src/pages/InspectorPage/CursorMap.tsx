/**
 * CursorMap — proportional miniature of the screen with a live cursor dot,
 * crosshair lines, grid overlay, and quadrant label.
 *
 * Upgraded with:
 *  - Pulsing cursor dot animation
 *  - Quadrant label on the dot
 *  - Screen-proportion preserving aspect ratio
 *  - Gradient grid lines
 */

const MAP_W = 200;

export function CursorMap({
  cursor,
  screen,
}: {
  cursor: { x: number; y: number } | null;
  screen: { width: number; height: number } | null;
}) {
  const MAP_H = screen && screen.width > 0
    ? Math.round(MAP_W * (screen.height / screen.width))
    : 112;

  if (!screen) {
    return (
      <div style={{
        width: MAP_W, height: MAP_H,
        border: '1px dashed var(--line-soft)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
        background: 'rgba(0, 0, 0, 0.4)',
      }}>
        screen unknown
      </div>
    );
  }

  const dotX = cursor
    ? Math.round((cursor.x / screen.width) * (MAP_W - 2))
    : null;
  const dotY = cursor
    ? Math.round((cursor.y / screen.height) * (MAP_H - 2))
    : null;

  const quadrant = cursor && screen
    ? `${cursor.x < screen.width / 2 ? 'L' : 'R'}${cursor.y < screen.height / 2 ? 'T' : 'B'}`
    : null;

  return (
    <div style={{
      position: 'relative',
      width: MAP_W, height: MAP_H,
      border: '1px solid var(--line-soft)',
      borderLeft: '2px solid var(--cyan)',
      background: 'linear-gradient(180deg, rgba(0,0,0,0.5), rgba(0,0,0,0.3))',
      overflow: 'hidden',
      flexShrink: 0,
    }}
      title={cursor ? `Cursor at ${cursor.x}, ${cursor.y}` : 'Cursor position unknown'}
    >
      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map(f => (
        <div key={`v-${f}`} style={{
          position: 'absolute',
          left: `${f * 100}%`, top: 0, bottom: 0,
          width: 1,
          background: `linear-gradient(180deg, transparent, rgba(57,229,255,0.08), transparent)`,
        }} />
      ))}
      {[0.25, 0.5, 0.75].map(f => (
        <div key={`h-${f}`} style={{
          position: 'absolute',
          top: `${f * 100}%`, left: 0, right: 0,
          height: 1,
          background: `linear-gradient(90deg, transparent, rgba(57,229,255,0.08), transparent)`,
        }} />
      ))}

      {/* Quadrant labels */}
      {['LT', 'RT', 'LB', 'RB'].map(q => {
        const isLeft = q.startsWith('L');
        const isTop = q.endsWith('T');
        return (
          <div key={q} style={{
            position: 'absolute',
            [isLeft ? 'left' : 'right']: 4,
            [isTop ? 'top' : 'bottom']: 3,
            fontFamily: 'var(--mono)', fontSize: 7,
            color: quadrant === q ? 'var(--cyan)' : 'rgba(57,229,255,0.15)',
            fontWeight: quadrant === q ? 700 : 400,
            transition: 'color 200ms ease',
          }}>{q}</div>
        );
      })}

      {/* Cursor crosshair + dot */}
      {dotX !== null && dotY !== null && (
        <>
          <div style={{
            position: 'absolute', left: dotX, top: 0, bottom: 0,
            width: 1, background: 'rgba(57,229,255,0.35)',
          }} />
          <div style={{
            position: 'absolute', top: dotY, left: 0, right: 0,
            height: 1, background: 'rgba(57,229,255,0.35)',
          }} />
          {/* Outer glow ring */}
          <div style={{
            position: 'absolute',
            left: dotX - 7, top: dotY - 7,
            width: 14, height: 14,
            borderRadius: '50%',
            border: '1px solid var(--cyan)',
            opacity: 0.3,
            animation: 'cursorPulse 2s ease-in-out infinite',
          }} />
          {/* Dot */}
          <div style={{
            position: 'absolute',
            left: dotX - 3, top: dotY - 3,
            width: 6, height: 6,
            borderRadius: '50%',
            background: 'var(--cyan)',
            boxShadow: '0 0 8px var(--cyan)',
          }} />
        </>
      )}

      {/* Screen dimensions */}
      <div style={{
        position: 'absolute', bottom: 2, right: 4,
        fontFamily: 'var(--mono)', fontSize: 7, color: 'rgba(57,229,255,0.4)',
      }}>
        {screen.width}×{screen.height}
      </div>

      <style>{`
        @keyframes cursorPulse {
          0%, 100% { transform: scale(1); opacity: 0.3; }
          50%      { transform: scale(1.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
