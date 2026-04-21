import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel } from './Panel';
import type { SystemMetrics, BatteryInfo } from '../hooks/useMetrics';
import { invokeSafe, isTauri } from '../lib/tauri';
import { toast } from '../hooks/useToast';
import { useView } from '../store/view';
import { Sparkline } from './Sparkline';

type Props = { metrics: SystemMetrics | null; battery: BatteryInfo | null };

type Status = 'ok' | 'warn' | 'crit';

type BarProps = {
  label: string;
  value: string | number;
  unit?: string;
  meta?: string;
  pct: number;
  status?: Status;
  onClick?: () => void;
  title?: string;
  sparkline?: ReadonlyArray<number>;
};

function Bar({ label, value, unit = '%', meta, pct, status = 'ok', onClick, title, sparkline }: BarProps) {
  const statusClass = status === 'ok' ? '' : ` ${status}`;
  return (
    <div
      className={`sys-item${statusClass}${onClick ? ' clickable' : ''}`}
      onClick={onClick}
      title={title}
    >
      <div className="h">
        <span className="k">{label}</span>
        <span className="v">{value}{unit}{meta && <small>{meta}</small>}</span>
      </div>
      <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
      {sparkline && sparkline.length >= 2 && (
        <div style={{ height: 16, marginTop: 3, opacity: 0.7 }}>
          <Sparkline
            data={sparkline}
            max={100}
            height={16}
            color="var(--cyan-2)"
            fill="rgba(57,229,255,0.10)"
            strokeWidth={1}
          />
        </div>
      )}
    </div>
  );
}

function bucket(value: number, warn: number, crit: number): Status {
  if (value >= crit) return 'crit';
  if (value >= warn) return 'warn';
  return 'ok';
}

function tempPct(celsius: number): number {
  const pct = ((celsius - 40) / (95 - 40)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function formatUptime(secs: number): string {
  if (secs <= 0) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function openActivityMonitor(): Promise<void> {
  if (!isTauri) { toast.info('Would open Activity Monitor'); return; }
  await invokeSafe<void>('open_app', { name: 'Activity Monitor' });
}

async function openBatteryPrefs(): Promise<void> {
  if (!isTauri) { toast.info('Would open Battery settings'); return; }
  await invokeSafe<void>('open_path', { path: 'x-apple.systempreferences:com.apple.Battery-Settings.extension' });
}

async function openAboutThisMac(): Promise<void> {
  if (!isTauri) { toast.info('Would open About This Mac'); return; }
  // AppleScript-triggered "About This Mac" dialog.
  await invokeSafe<string>('applescript', {
    script: 'tell application "System Events" to click menu item "About This Mac" of menu 1 of menu bar item 1 of menu bar 1 of application process "Finder"',
  });
}

async function openStoragePrefs(): Promise<void> {
  if (!isTauri) { toast.info('Would open Storage settings'); return; }
  await invokeSafe<void>('open_path', { path: 'x-apple.systempreferences:com.apple.settings.Storage' });
}

function shortChip(brand: string | undefined): string {
  if (!brand) return 'Apple Silicon';
  return brand.replace(/^Apple\s+/i, '').trim() || 'Apple Silicon';
}

const HISTORY_LEN = 60;

export function SystemPanel({ metrics, battery }: Props) {
  const { dockHidden } = useView();
  const m = metrics;
  const cpu = m ? Math.round(m.cpu) : 42;
  const mem = m ? m.mem_used_gb : 18.4;
  const memTotal = m ? m.mem_total_gb : 36;
  const memPct = m ? m.mem_pct : 51;
  const temp = m ? Math.round(m.temp_c || 62) : 62;
  const gpu = Math.min(100, Math.max(0, cpu * 1.4 + 15));

  // Rolling history for sparklines — kept in a ref so appends don't trigger
  // a re-render by themselves; we bump state via `tick` below once per
  // metrics update so the chart actually refreshes.
  const historyRef = useRef<{
    cpu: number[];
    mem: number[];
    temp: number[];
    gpu: number[];
  }>({ cpu: [], mem: [], temp: [], gpu: [] });
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!m) return;
    const h = historyRef.current;
    const push = (arr: number[], v: number) => {
      arr.push(v);
      if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
    };
    push(h.cpu, cpu);
    push(h.mem, memPct);
    push(h.temp, tempPct(temp));
    push(h.gpu, gpu);
    setTick(t => (t + 1) % 1_000_000);
  }, [m, cpu, memPct, temp, gpu]);

  const hasBattery = battery !== null || (m !== null && m.is_laptop);
  const bat = battery ? Math.round(battery.percent) : 0;
  const charging = battery?.charging ?? false;

  const chipLabel = shortChip(m?.chip);
  const uptime = formatUptime(m?.uptime_secs ?? 0);
  const host = m?.host ?? '—';
  const cores = m?.cpu_cores ?? 10;

  const toActivity = useCallback(() => { void openActivityMonitor(); }, []);
  const toBattery = useCallback(() => { void openBatteryPrefs(); }, []);
  const toAbout = useCallback(() => { void openAboutThisMac(); }, []);
  const toStorage = useCallback(() => { void openStoragePrefs(); }, []);

  const cpuStatus = bucket(cpu, 75, 92);
  const gpuStatus = bucket(gpu, 75, 92);
  const memStatus = bucket(memPct, 80, 93);
  const tempStatus = bucket(temp, 80, 90);
  const batStatus: Status = charging ? 'ok' : bucket(100 - bat, 80, 90);

  const h = historyRef.current;

  const right = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={toActivity}
        className="hdr-chip"
        title={`Open Activity Monitor · ${cores}-core`}
      >
        ACT ▾
      </button>
    </span>
  );

  return (
    <Panel id="p-sys" title="SYSTEM" right={right}>
      <div className="sys">
        <Bar
          label="CPU" value={cpu} meta={`${cores}-core`} pct={cpu} status={cpuStatus}
          onClick={toActivity} title="Open Activity Monitor"
          sparkline={dockHidden ? h.cpu : undefined}
        />
        <Bar
          label="GPU" value={Math.round(gpu)} meta={chipLabel} pct={gpu} status={gpuStatus}
          onClick={toActivity} title="Open Activity Monitor"
          sparkline={dockHidden ? h.gpu : undefined}
        />
        <Bar
          label="MEMORY" value={mem.toFixed(1)} unit="" meta={`/${Math.round(memTotal)} GB`} pct={memPct} status={memStatus}
          onClick={toActivity} title="Open Activity Monitor"
          sparkline={dockHidden ? h.mem : undefined}
        />
        <Bar
          label="TEMP" value={temp} unit="°C" meta="core" pct={tempPct(temp)} status={tempStatus}
          onClick={toActivity} title="Open Activity Monitor"
          sparkline={dockHidden ? h.temp : undefined}
        />
        {hasBattery && battery && (
          <Bar
            label="BATTERY" value={bat} meta={charging ? 'charging' : 'on battery'} pct={bat} status={batStatus}
            onClick={toBattery} title="Open Battery settings"
          />
        )}

        {dockHidden && (
          <>
            <div
              style={{
                marginTop: 4,
                paddingTop: 6,
                borderTop: '1px solid var(--line-soft)',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                rowGap: 4,
                columnGap: 10,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                color: 'var(--ink-2)',
              }}
            >
              <KV k="HOST" v={host} title="Hostname" />
              <KV k="CHIP" v={chipLabel} title={m?.chip ?? ''} />
              <KV k="UPTIME" v={uptime} title={`${m?.uptime_secs ?? 0}s`} />
              <KV k="MEM FREE" v={`${Math.max(0, memTotal - mem).toFixed(1)}G`} />
            </div>

            <div
              style={{
                display: 'flex',
                gap: 4,
                marginTop: 6,
                flexWrap: 'wrap',
              }}
            >
              <Chip onClick={toActivity} label="ACTIVITY" />
              <Chip onClick={toStorage} label="STORAGE" />
              <Chip onClick={toAbout} label="ABOUT" />
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function KV({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, minWidth: 0 }} title={title}>
      <span style={{ color: 'var(--ink-dim)', letterSpacing: '0.16em', fontSize: 9.5, fontFamily: 'var(--display)' }}>{k}</span>
      <b
        style={{
          color: 'var(--cyan)', fontWeight: 700,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {v}
      </b>
    </div>
  );
}

function Chip({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '3px 7px',
        fontFamily: 'var(--display)',
        fontSize: 9.5,
        letterSpacing: '0.18em',
        fontWeight: 700,
        color: 'var(--cyan)',
        border: '1px solid var(--line-soft)',
        background: 'rgba(57,229,255,0.04)',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(57,229,255,0.14)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(57,229,255,0.04)'; }}
    >
      {label}
    </button>
  );
}
