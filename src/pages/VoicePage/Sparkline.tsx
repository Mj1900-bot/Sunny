/**
 * Tiny RMS sparkline rendered as inline SVG bars.
 * Accepts a fixed array of normalised levels (0–1).
 * Stateless — purely driven by the stored rmsHistory array.
 */

type Props = {
  readonly levels: ReadonlyArray<number>;
  readonly width?: number;
  readonly height?: number;
  readonly tone?: 'cyan' | 'violet' | 'amber';
};

const COLORS: Record<NonNullable<Props['tone']>, string> = {
  cyan: '#39E5FF',
  violet: '#B48CFF',
  amber: '#FFB547',
};

export function Sparkline({ levels, width = 72, height = 20, tone = 'cyan' }: Props) {
  if (levels.length === 0) {
    return (
      <span style={{
        display: 'inline-block', width, height,
        background: 'rgba(57,229,255,0.04)',
        border: '1px dashed rgba(57,229,255,0.15)',
        verticalAlign: 'middle',
      }} />
    );
  }

  const bars = Math.min(levels.length, 32);
  const src = levels.slice(-bars);
  const gap = 1;
  const barW = (width - gap * (bars - 1)) / bars;
  const color = COLORS[tone];

  return (
    <svg
      width={width}
      height={height}
      aria-hidden
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
    >
      {src.map((v, i) => {
        const pct = Math.max(0.04, Math.min(1, v));
        const barH = Math.max(2, pct * height);
        const x = i * (barW + gap);
        const y = height - barH;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            fill={color}
            opacity={0.55 + pct * 0.45}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}
