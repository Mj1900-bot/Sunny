/**
 * MachineGauges — radial gauge cluster for CPU, MEM, TEMP, BATT.
 * Uses ProgressRing from shared primitives for consistent styling.
 * Includes a client-side sparkline history ring for CPU and MEM.
 */

// No React hooks needed — state managed by parent via pushMetricHistory
import { ProgressRing, Sparkline } from '../_shared';
import type { WorldState } from './types';

// ---------------------------------------------------------------------------
// Client-side metric history for sparklines
// ---------------------------------------------------------------------------

type MetricPoint = { cpu: number; mem: number; ts: number };
const MAX_METRIC_POINTS = 30;
let _metricHistory: MetricPoint[] = [];

export function pushMetricHistory(w: WorldState): MetricPoint[] {
  const point: MetricPoint = { cpu: w.cpu_pct, mem: w.mem_pct, ts: w.timestamp_ms };
  if (_metricHistory.length > 0 && _metricHistory[_metricHistory.length - 1].ts === point.ts) {
    return _metricHistory;
  }
  const next = [..._metricHistory, point];
  _metricHistory = next.length > MAX_METRIC_POINTS
    ? next.slice(next.length - MAX_METRIC_POINTS)
    : next;
  return _metricHistory;
}

// ---------------------------------------------------------------------------
// Gauge subcomponent
// ---------------------------------------------------------------------------

function Gauge({
  label, value, pct, tone, unit,
}: {
  label: string;
  value: string;
  pct: number;
  tone: 'cyan' | 'amber' | 'green' | 'violet' | 'red' | 'gold';
  unit?: string;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    }}>
      <ProgressRing
        progress={Math.max(0, Math.min(1, pct / 100))}
        size={72}
        stroke={5}
        tone={tone}
      >
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0,
        }}>
          <span style={{
            fontFamily: 'var(--display)', fontSize: 14, fontWeight: 800,
            color: `var(--${tone})`, letterSpacing: '0.04em', lineHeight: 1,
          }}>
            {value}
          </span>
          {unit && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 7, color: 'var(--ink-dim)',
              letterSpacing: '0.1em',
            }}>
              {unit}
            </span>
          )}
        </div>
      </ProgressRing>
      <span style={{
        fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
        color: 'var(--ink-2)', fontWeight: 700,
      }}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Battery indicator
// ---------------------------------------------------------------------------

function BatteryPill({ pct, charging }: { pct: number; charging: boolean }) {
  const tone = pct < 20 ? 'red' : pct < 50 ? 'amber' : 'green';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center',
    }}>
      <div
        title={`${Math.round(pct)}%${charging ? ' charging' : ''}`}
        style={{
          width: 52, height: 22,
          border: `1.5px solid var(--${tone})`,
          borderRadius: 4,
          position: 'relative', overflow: 'hidden',
          background: 'rgba(0,0,0,0.3)',
        }}
      >
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${Math.max(4, Math.min(100, pct))}%`,
          background: `var(--${tone})`,
          boxShadow: `0 0 8px var(--${tone})`,
          transition: 'width 600ms ease',
          opacity: 0.7,
        }} />
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
          color: '#fff', letterSpacing: '0.04em',
          textShadow: '0 0 4px rgba(0,0,0,0.8)',
        }}>
          {Math.round(pct)}%{charging ? ' ⚡' : ''}
        </div>
      </div>
      <span style={{
        fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
        color: 'var(--ink-2)', fontWeight: 700,
      }}>
        BATTERY
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function MachineGauges({
  world,
  metricHistory,
}: {
  world: WorldState;
  metricHistory: ReadonlyArray<MetricPoint>;
}) {
  const cpuTone = world.cpu_pct > 80 ? 'red' as const : world.cpu_pct > 50 ? 'amber' as const : 'cyan' as const;
  const memTone = world.mem_pct > 85 ? 'red' as const : world.mem_pct > 60 ? 'amber' as const : 'violet' as const;
  const tempTone = world.temp_c > 85 ? 'red' as const : world.temp_c > 70 ? 'amber' as const : 'green' as const;

  const cpuValues = metricHistory.map(p => p.cpu);
  const memValues = metricHistory.map(p => p.mem);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* Radial gauges row */}
      <div style={{
        display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end',
        gap: 8, flexWrap: 'wrap',
      }}>
        <Gauge label="CPU" value={`${world.cpu_pct.toFixed(0)}`} pct={world.cpu_pct} tone={cpuTone} unit="%" />
        <Gauge label="MEM" value={`${world.mem_pct.toFixed(0)}`} pct={world.mem_pct} tone={memTone} unit="%" />
        <Gauge label="TEMP" value={`${world.temp_c.toFixed(0)}`} pct={Math.min(100, (world.temp_c / 95) * 100)} tone={tempTone} unit="°C" />
      </div>

      {/* Battery */}
      {world.battery_pct != null && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <BatteryPill pct={world.battery_pct} charging={world.battery_charging ?? false} />
        </div>
      )}

      {/* Sparkline history */}
      {cpuValues.length >= 2 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: '8px 4px 0',
          borderTop: '1px solid var(--line-soft)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)',
              letterSpacing: '0.08em', minWidth: 28,
            }}>CPU</span>
            <Sparkline values={cpuValues} width={120} height={22} tone={cpuTone} filled />
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
            }}>{cpuValues[cpuValues.length - 1].toFixed(0)}%</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)',
              letterSpacing: '0.08em', minWidth: 28,
            }}>MEM</span>
            <Sparkline values={memValues} width={120} height={22} tone={memTone} filled />
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
            }}>{memValues[memValues.length - 1].toFixed(0)}%</span>
          </div>
        </div>
      )}

      {/* Thermal warning */}
      {world.temp_c > 85 && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)',
          padding: '6px 8px',
          border: '1px solid rgba(255,80,80,0.35)',
          background: 'rgba(255,0,0,0.06)',
          animation: 'pulseDot 2s ease-in-out infinite',
        }}>
          ⚠ High silicon temperature — the system may throttle.
        </div>
      )}
    </div>
  );
}
