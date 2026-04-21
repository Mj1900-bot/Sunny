/** Rolling $/hr chart — last 24 hourly buckets as a filled sparkline. */
import { useMemo } from 'react';
import { Section } from '../_shared';
import type { HourlyBucket } from './types';

type Props = {
  readonly buckets: ReadonlyArray<HourlyBucket>;
};

const W = 280;
const H = 52;

export function CostHourlyChart({ buckets }: Props) {
  const { d, area, maxCost } = useMemo(() => {
    if (buckets.length < 2) {
      return { d: `M0,${H}`, area: `M0,${H} L${W},${H} Z`, maxCost: 0 };
    }
    const vals   = buckets.map(b => b.costUsd);
    const maxVal = Math.max(...vals, 0.00001);
    const dx     = W / (buckets.length - 1);
    const pts    = vals.map((v, i) => {
      const x = i * dx;
      const y = H - (v / maxVal) * (H - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return {
      d:       `M${pts.join(' L')}`,
      area:    `M0,${H} L${pts.join(' L')} L${W},${H} Z`,
      maxCost: maxVal,
    };
  }, [buckets]);

  const allZero = buckets.every(b => b.costUsd === 0);

  return (
    <Section title="$/HR · ROLLING 24H" right={allZero ? 'all free' : `peak $${maxCost.toFixed(4)}/hr`}>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          width="100%"
          height={H}
          style={{ display: 'block', overflow: 'visible' }}
          role="img"
          aria-label="Rolling 24h cost per hour"
        >
          <path d={area} fill="rgba(245,158,11,0.08)" stroke="none" />
          <path d={d} fill="none" stroke="var(--amber)" strokeWidth={1.5}
            strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
          marginTop: 3,
        }}>
          <span>-24h</span>
          <span>now</span>
        </div>
      </div>
    </Section>
  );
}
