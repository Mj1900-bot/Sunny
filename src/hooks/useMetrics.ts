import { useEffect, useState } from 'react';
import { invoke, listen, isTauri } from '../lib/tauri';

// Wire-compatible types are re-exported from the auto-generated ts-rs
// bindings (`src/bindings/*.ts`). Regenerate with
// `./scripts/regen-bindings.sh` after modifying the Rust structs.
export type { SystemMetrics } from '../bindings/SystemMetrics';
export type { NetStats } from '../bindings/NetStats';
export type { ProcessRow } from '../bindings/ProcessRow';
export type { BatteryInfo } from '../bindings/BatteryInfo';

import type { SystemMetrics } from '../bindings/SystemMetrics';
import type { NetStats } from '../bindings/NetStats';
import type { ProcessRow } from '../bindings/ProcessRow';
import type { BatteryInfo } from '../bindings/BatteryInfo';

/**
 * Metric updates flow through the Tauri event bus — the Rust-side
 * sampler owns cadence (fast when charging / on AC, slow on battery)
 * and emits `sunny://metrics`, `sunny://net`, `sunny://processes`,
 * `sunny://battery` whenever a fresh reading lands. This hook:
 *
 *   1. Runs ONE bootstrap invoke burst on mount so consumers don't
 *      render null placeholders during the first Rust emit window.
 *   2. Subscribes to the four event channels for ongoing updates.
 *
 * An earlier version of this hook also ran a recursive 2-5s poll loop
 * that invoked the same four commands — every metric arrived twice
 * (once from push, once from poll), doubling IPC traffic at rest for
 * zero added freshness. The poll is removed.
 */
export function useMetrics() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [net, setNet] = useState<NetStats | null>(null);
  const [procs, setProcs] = useState<ProcessRow[]>([]);
  const [battery, setBattery] = useState<BatteryInfo | null>(null);

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    let unlisteners: Array<() => void> = [];

    const bootstrap = async () => {
      try {
        const [m, n, p, b] = await Promise.all([
          invoke<SystemMetrics>('get_metrics'),
          invoke<NetStats>('get_net'),
          invoke<ProcessRow[]>('get_processes', { limit: 32 }),
          invoke<BatteryInfo | null>('get_battery'),
        ]);
        if (cancelled) return;
        setMetrics(m);
        setNet(n);
        setProcs(p);
        if (b) setBattery(b);
      } catch (error) {
        console.error('metrics bootstrap failed', error);
      }
    };

    (async () => {
      await bootstrap();
      if (cancelled) return;

      unlisteners = await Promise.all([
        listen<SystemMetrics>('sunny://metrics', setMetrics),
        listen<NetStats>('sunny://net', setNet),
        listen<ProcessRow[]>('sunny://processes', setProcs),
        listen<BatteryInfo>('sunny://battery', setBattery),
      ]);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach(fn => fn());
    };
  }, []);

  return { metrics, net, procs, battery, isTauri };
}
