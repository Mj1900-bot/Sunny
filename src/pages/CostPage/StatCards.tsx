/** Top-row stat cards: Today's cost / Turns today / Cache hit rate */
import { StatBlock } from '../_shared';
import type { CostToday } from './types';
import type { LlmStats } from './api';

type Props = {
  readonly costToday: CostToday | null;
  readonly llmStats:  LlmStats | null;
};

function fmtUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}


export function StatCards({ costToday, llmStats }: Props) {
  const totalUsd  = costToday?.total_usd ?? 0;
  const turns     = costToday?.turns ?? 0;
  const cacheRate = llmStats?.cache_hit_rate ?? 0;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      <StatBlock
        label="TODAY'S COST"
        value={fmtUsd(totalUsd)}
        sub={totalUsd === 0 ? 'no paid turns yet' : 'USD since midnight'}
        tone="amber"
      />
      <StatBlock
        label="TURNS TODAY"
        value={String(turns)}
        sub={turns === 1 ? '1 completed turn' : `${turns} completed turns`}
        tone="cyan"
      />
      <StatBlock
        label="CACHE HIT RATE"
        value={`${cacheRate.toFixed(1)}%`}
        sub="anthropic prompt cache (0% for ollama/glm)"
        tone="violet"
      />
    </div>
  );
}
