/**
 * Sparkline — minimal inline SVG line+area chart used by the right-column
 * HUD panels (SYSTEM / NETWORK). Keeps a single DOM node, stays stateless,
 * and scales cleanly inside any flexible container via `preserveAspectRatio="none"`.
 *
 * Values are expected to already be in the 0-`max` domain. Missing / empty
 * arrays render as a flat baseline so the caller never has to guard.
 */
import { useMemo, type CSSProperties } from 'react';

type Props = {
  readonly data: ReadonlyArray<number>;
  readonly max?: number;
  readonly width?: number;
  readonly height?: number;
  readonly color?: string;
  readonly fill?: string;
  readonly strokeWidth?: number;
  readonly style?: CSSProperties;
  readonly ariaLabel?: string;
};

export function Sparkline({
  data,
  max,
  width = 120,
  height = 28,
  color = 'currentColor',
  fill,
  strokeWidth = 1.2,
  style,
  ariaLabel,
}: Props) {
  const { d, area } = useMemo(() => {
    if (data.length < 2) {
      return { d: `M0,${height} L${width},${height}`, area: `M0,${height} L${width},${height} Z` };
    }
    const ceiling = max ?? Math.max(1, ...data);
    const dx = width / (data.length - 1);
    const points = data.map((v, i) => {
      const x = i * dx;
      const y = height - (Math.max(0, Math.min(ceiling, v)) / ceiling) * (height - 1) - 0.5;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const line = `M${points.join(' L')}`;
    const areaPath = `M0,${height} L${points.join(' L')} L${width},${height} Z`;
    return { d: line, area: areaPath };
  }, [data, max, width, height]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      style={{ display: 'block', overflow: 'visible', color, ...style }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      {fill && <path d={area} fill={fill} stroke="none" />}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
