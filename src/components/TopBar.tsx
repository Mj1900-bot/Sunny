import { useEffect, useMemo, useState } from 'react';
import { useClock } from '../hooks/useClock';
import { useView } from '../store/view';
import { invokeSafe } from '../lib/tauri';
import type {
  SystemMetrics,
  NetStats,
  ProcessRow,
  BatteryInfo,
} from '../hooks/useMetrics';

type Props = {
  host: string;
  ping: number;
  metrics: SystemMetrics | null;
  net: NetStats | null;
  procs: ProcessRow[];
  battery: BatteryInfo | null;
};

function shortenModel(model: string): string {
  return model.replace(/^claude-/, '');
}

// Mac users see `⌘`, everyone else sees `Ctrl`. Used only for tooltip
// copy — the actual hotkey dispatcher in useGlobalHotkeys already matches
// either metaKey or ctrlKey.
function primaryMod(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+';
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? '\u2318' : 'Ctrl+';
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

export function TopBar({ host, ping, metrics, net, procs: _procs, battery }: Props) {
  const { clock, date } = useClock();
  const { settings, openSettings, view, dockHidden, toggleDock } = useView();

  const [claw, setClaw] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const up = await invokeSafe<boolean>('openclaw_ping');
      if (alive) setClaw(up);
    };
    check();
    const id = window.setInterval(check, 20_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const model = shortenModel(settings.model);
  const ledColor = claw === null ? 'var(--ink-dim)' : claw ? 'var(--green)' : 'var(--amber)';

  // STABLE marquee content. We deliberately exclude fast-changing metrics
  // (CPU%, memory, temp, top-proc) because they re-render the text every
  // 1.4s and glitch the CSS animation. Those values already live in the
  // SYSTEM + PROCESSES panels. The marquee shows context that's either
  // static or changes slowly (minutes, not seconds).
  const uptimeBucket = metrics ? Math.floor(metrics.uptime_secs / 60) : 0; // only updates once per minute
  const batBucket = battery ? Math.round(battery.percent / 5) * 5 : null; // 5% buckets
  const track = useMemo(() => {
    const facts: string[] = [];
    facts.push(`HOST ${host}`);
    if (net?.ssid) facts.push(`SSID ${net.ssid}`);
    if (net?.public_ip) facts.push(`IP ${net.public_ip}`);
    if (net?.iface) facts.push(`IFACE ${net.iface}`);
    if (metrics) {
      facts.push(`MEM ${metrics.mem_total_gb.toFixed(0)}GB`);
      facts.push(`CORES ${metrics.cpu_cores}`);
      facts.push(`UP ${formatUptime(uptimeBucket * 60)}`);
    }
    if (batBucket !== null && battery) {
      facts.push(`BAT ${batBucket}%${battery.charging ? ' ⚡' : ''}`);
    }
    facts.push(`VIEW ${view.toUpperCase()}`);
    facts.push(`THEME ${settings.theme.toUpperCase()}`);
    facts.push(`VOICE ${settings.voiceName} · ${settings.voiceRate}wpm`);
    facts.push(`AGENT ${model}`);
    facts.push(`GATEWAY ${claw === null ? 'CHECK' : claw ? 'ONLINE' : 'OFFLINE'}`);
    // Wake-word is gated off pending a real KWS (see `useWakeWord.ts`).
    // Surface the honest input path — push-to-talk — instead of lying about
    // a "hey sunny" hotword that never fires.
    facts.push(`PTT ${settings.pushToTalkKey.toUpperCase()}`);
    return [...facts, ...facts].join('   ·   ');
  }, [
    host, net?.ssid, net?.public_ip, net?.iface,
    metrics?.mem_total_gb, metrics?.cpu_cores, uptimeBucket,
    batBucket, battery?.charging,
    view, settings.theme, settings.voiceName, settings.voiceRate,
    model, claw, settings.pushToTalkKey,
  ]);

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <div className="dot" />
        SUNNY
      </div>
      <div className="marquee-chip" data-tauri-drag-region aria-label="System telemetry">
        <div className="marquee-inner" data-tauri-drag-region>{track}</div>
      </div>
      <div className="chips" data-tauri-drag-region="false">
        <button
          type="button"
          className="chip-fixed chip-ai chip-dock"
          onClick={toggleDock}
          aria-pressed={!dockHidden}
          aria-label={dockHidden ? 'Show terminals and AI chat dock' : 'Hide terminals and AI chat dock'}
          title={`${dockHidden ? 'Show' : 'Hide'} dock  (${primaryMod()}J)`}
        >
          DOCK <b>{dockHidden ? '▴' : '▾'}</b>
        </button>
        <span className="chip-fixed">PING <b>{ping}ms</b></span>
        <span
          className="chip-fixed chip-ai"
          onClick={openSettings}
          title={`AI provider: ${settings.provider} · click to open Settings`}
        >
          <span className="led" style={{ background: ledColor, boxShadow: `0 0 6px ${ledColor}` }} />
          AI <b>{model}</b>
        </span>
        <span className="chip-fixed">{date}</span>
        <span className="chip-fixed" style={{ color: 'var(--cyan)', fontWeight: 700 }}>{clock}</span>
      </div>
    </div>
  );
}
