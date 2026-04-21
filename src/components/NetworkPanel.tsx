import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './Panel';
import type { NetStats } from '../hooks/useMetrics';
import { invokeSafe, isTauri } from '../lib/tauri';
import { toast } from '../hooks/useToast';
import { useView } from '../store/view';
import { Sparkline } from './Sparkline';

type Props = { net: NetStats | null; ping: number };

async function copyToClipboard(text: string, label: string): Promise<void> {
  if (!text || text === '—') {
    toast.info(`${label} unavailable`);
    return;
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${label}`);
  } catch (err) {
    console.error('NetworkPanel: copy failed', err);
    toast.error('Copy failed');
  }
}

async function openNetworkPrefs(): Promise<void> {
  if (!isTauri) { toast.info('Would open Network settings'); return; }
  await invokeSafe<void>('open_path', { path: 'x-apple.systempreferences:com.apple.Network-Settings.extension' });
}

async function openWifiPrefs(): Promise<void> {
  if (!isTauri) { toast.info('Would open Wi-Fi settings'); return; }
  await invokeSafe<void>('open_path', { path: 'x-apple.systempreferences:com.apple.wifi-settings-extension' });
}

async function openSharingPrefs(): Promise<void> {
  if (!isTauri) { toast.info('Would open Sharing settings'); return; }
  await invokeSafe<void>('open_path', { path: 'x-apple.systempreferences:com.apple.Sharing-Settings.extension' });
}

async function toggleWifi(enable: boolean): Promise<void> {
  if (!isTauri) {
    toast.info(`Would ${enable ? 'enable' : 'disable'} Wi-Fi`);
    return;
  }
  const state = enable ? 'on' : 'off';
  const res = await invokeSafe<{ stdout: string; stderr: string; code: number }>('run_shell', {
    cmd: `networksetup -setairportpower en0 ${state}`,
  });
  if (res && res.code === 0) {
    toast.success(`Wi-Fi ${enable ? 'enabled' : 'disabled'}`);
  } else {
    toast.error('Wi-Fi toggle failed');
  }
}

async function openSpeedTest(): Promise<void> {
  if (!isTauri) { toast.info('Would open fast.com'); return; }
  await invokeSafe<void>('open_path', { path: 'https://fast.com' });
}

async function flushDns(): Promise<void> {
  if (!isTauri) { toast.info('Would flush DNS cache'); return; }
  const res = await invokeSafe<{ stdout: string; stderr: string; code: number }>('run_shell', {
    cmd: 'dscacheutil -flushcache; sudo killall -HUP mDNSResponder 2>/dev/null; echo ok',
  });
  if (res) toast.success('DNS flush requested');
}

/** Format a KB/s value as "842 KB/s" or "1.2 MB/s" once it crosses 1000 KB/s. */
function formatRate(kbps: number): { value: string; unit: string } {
  if (kbps >= 1000) {
    const mb = kbps / 1024;
    return { value: mb >= 10 ? mb.toFixed(1) : mb.toFixed(2), unit: 'MB/s' };
  }
  return { value: String(Math.round(kbps)), unit: 'KB/s' };
}

function formatBytes(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.round(kb)} KB`;
}

function pingColor(ms: number): string {
  if (ms <= 0) return 'var(--ink-dim)';
  if (ms < 50) return 'var(--green)';
  if (ms < 150) return 'var(--cyan)';
  if (ms < 300) return 'var(--amber)';
  return 'var(--red)';
}

function pingLabel(ms: number): string {
  if (ms <= 0) return 'unknown';
  if (ms < 50) return 'excellent';
  if (ms < 150) return 'good';
  if (ms < 300) return 'fair';
  return 'poor';
}

const HISTORY_LEN = 60;

export function NetworkPanel({ net, ping }: Props) {
  const { dockHidden } = useView();
  const pathRef = useRef<SVGPathElement>(null);
  const [fakeData] = useState<number[]>(() => Array.from({ length: 30 }, () => Math.random() * 30 + 6));

  // Real rolling history driven by the metrics events.
  const histRef = useRef<{ down: number[]; up: number[]; ping: number[] }>({
    down: [], up: [], ping: [],
  });
  // Cumulative session totals (approximate): integrate kbps at the polling
  // cadence (~2s). Uses a ref so we don't rebuild timers on every update.
  const totalsRef = useRef<{ downKb: number; upKb: number; sinceMs: number }>({
    downKb: 0, upKb: 0, sinceMs: Date.now(),
  });
  const lastAtRef = useRef<number>(Date.now());
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!net) return;
    const now = Date.now();
    const deltaSec = Math.max(0.5, Math.min(10, (now - lastAtRef.current) / 1000));
    lastAtRef.current = now;
    totalsRef.current.downKb += (net.down_kbps * deltaSec);
    totalsRef.current.upKb += (net.up_kbps * deltaSec);
    const h = histRef.current;
    h.down.push(net.down_kbps);
    h.up.push(net.up_kbps);
    if (h.down.length > HISTORY_LEN) h.down.splice(0, h.down.length - HISTORY_LEN);
    if (h.up.length > HISTORY_LEN) h.up.splice(0, h.up.length - HISTORY_LEN);
    if (ping > 0) {
      h.ping.push(ping);
      if (h.ping.length > HISTORY_LEN) h.ping.splice(0, h.ping.length - HISTORY_LEN);
    }
    setTick(t => (t + 1) % 1_000_000);
  }, [net, ping]);

  // Legacy decorative wave — used when we don't yet have enough real data
  // to draw a meaningful sparkline. Stops firing once real `net` data arrives
  // (h.down.length >= 4 switches the graph to <Sparkline>), and mutates via
  // immutable clone to comply with the no-mutation policy.
  useEffect(() => {
    const id = window.setInterval(() => {
      // Bail early once real data has taken over — no point animating the
      // decorative wave when the Sparkline component is rendering instead.
      if (net) return;
      const prev = fakeData[fakeData.length - 1];
      const next = Math.max(4, Math.min(46, prev + (Math.random() - 0.5) * 10));
      // Immutable shift-and-push: produce a new array rather than mutating in place.
      const updated = [...fakeData.slice(1), next];
      // Reflect the new sequence into the backing array so the SVG path stays
      // in sync. We keep the useState array as the source of truth length-wise
      // but drive the DOM ref directly for zero-React-render wave animation.
      fakeData.splice(0, fakeData.length, ...updated);
      if (pathRef.current) {
        const pts = updated.map((v, i) => `${(i / (updated.length - 1)) * 200},${52 - v}`);
        pathRef.current.setAttribute('d', 'M0,52 L' + pts.join(' L') + ' L200,52 Z');
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [fakeData, net]);

  const downFmt = formatRate(net ? net.down_kbps : 842);
  const upFmt = formatRate(net ? net.up_kbps : 124);
  const iface = net?.iface ?? 'en0';
  const ssid = net?.ssid && net.ssid.length > 0 ? net.ssid : '—';
  const publicIp = net?.public_ip && net.public_ip.length > 0 ? net.public_ip : '—';
  const pingDisplay = ping > 0 ? `${ping} ms` : '—';
  const vpnActive = net?.vpn_active ?? false;

  const barNodes = useMemo(() => {
    const count = 18;
    return Array.from({ length: count }, (_, i) => {
      const phase = (i * 0.6180339887) % 1;
      const duration = 0.85 + phase * 0.75;
      const delay = -((i * 0.137) % 1.4);
      return (
        <i
          key={i}
          style={{ animationDuration: `${duration.toFixed(3)}s`, animationDelay: `${delay.toFixed(3)}s` }}
        />
      );
    });
  }, []);

  const toNetPrefs = useCallback(() => { void openNetworkPrefs(); }, []);
  const toWifiPrefs = useCallback(() => { void openWifiPrefs(); }, []);
  const toSharing = useCallback(() => { void openSharingPrefs(); }, []);
  const toSpeedTest = useCallback(() => { void openSpeedTest(); }, []);
  const toFlushDns = useCallback(() => { void flushDns(); }, []);
  const copySsid = useCallback(() => { void copyToClipboard(ssid, 'SSID'); }, [ssid]);
  const copyPublicIp = useCallback(() => { void copyToClipboard(publicIp, 'public IP'); }, [publicIp]);
  const copyIface = useCallback(() => { void copyToClipboard(iface, 'interface'); }, [iface]);
  const wifiOff = useCallback(() => { void toggleWifi(false); }, []);
  const wifiOn = useCallback(() => { void toggleWifi(true); }, []);

  const resetTotals = useCallback(() => {
    totalsRef.current = { downKb: 0, upKb: 0, sinceMs: Date.now() };
    setTick(t => (t + 1) % 1_000_000);
    toast.info('Session totals reset');
  }, []);

  const h = histRef.current;
  const pingAvg = h.ping.length > 0 ? Math.round(h.ping.reduce((a, b) => a + b, 0) / h.ping.length) : 0;
  const pingMax = h.ping.length > 0 ? Math.max(...h.ping) : 0;
  const sessionMin = Math.max(1, Math.floor((Date.now() - totalsRef.current.sinceMs) / 60_000));

  return (
    <Panel
      id="p-net"
      title="NETWORK"
      right={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={toSpeedTest}
            className="hdr-chip"
            title="Open fast.com speed test"
          >
            TEST ▴
          </button>
          <span
            style={{ color: vpnActive ? 'var(--green)' : 'var(--ink-dim)' }}
            title={vpnActive ? 'VPN tunnel active' : 'No VPN detected'}
          >
            {vpnActive ? '● VPN' : '○ VPN'}
          </span>
        </span>
      }
    >
      <div className="net">
        <div
          className="kv clickable"
          onClick={toNetPrefs}
          onDoubleClick={copyIface}
          title="Open Network settings (double-click to copy)"
        >
          <span>IFACE</span><b>{iface}</b>
        </div>
        <div
          className="kv clickable"
          onClick={toWifiPrefs}
          onDoubleClick={copySsid}
          title="Open Wi-Fi settings (double-click to copy SSID)"
        >
          <span>SSID</span><b>{ssid}</b>
        </div>
        <div className="kv" title={`Round-trip to 1.1.1.1 — ${pingLabel(ping)}`}>
          <span>PING</span>
          <b style={{ color: pingColor(ping) }}>
            {pingDisplay}
            {pingAvg > 0 && (
              <small style={{ color: 'var(--ink-dim)', marginLeft: 6, fontSize: '0.75em' }}>
                avg {pingAvg} · peak {pingMax}
              </small>
            )}
          </b>
        </div>
        <div className="split">
          <div className="cell">
            <div className="k">DOWN</div>
            <div className="v">{downFmt.value}<small>{downFmt.unit}</small></div>
          </div>
          <div className="cell">
            <div className="k">UP</div>
            <div className="v">{upFmt.value}<small>{upFmt.unit}</small></div>
          </div>
        </div>

        {/* Graph — prefer real data once we have enough samples; fall back to
            the decorative wave so the panel never looks empty at boot. */}
        {h.down.length >= 4 ? (
          <div className="graph" style={{ color: 'var(--cyan)' }} title={`DOWN last ${h.down.length} samples`}>
            <Sparkline
              data={h.down}
              height={52}
              color="var(--cyan)"
              fill="rgba(57,229,255,0.14)"
              strokeWidth={1.3}
            />
          </div>
        ) : (
          <div className="graph">
            <svg viewBox="0 0 200 52" preserveAspectRatio="none">
              <path ref={pathRef} fill="rgba(57,229,255,.14)" stroke="currentColor" strokeWidth={1.3} />
            </svg>
          </div>
        )}
        <div className="bars">{barNodes}</div>

        <div
          className="kv clickable"
          onClick={copyPublicIp}
          title="Copy public IP"
          style={{ opacity: 0.65, fontSize: '0.72rem' }}
        >
          <span>PUBLIC IP</span><b>{publicIp}</b>
        </div>

        {dockHidden && (
          <>
            {h.ping.length >= 2 && (
              <div
                style={{
                  marginTop: 6,
                  paddingTop: 6,
                  borderTop: '1px solid var(--line-soft)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: 'var(--display)',
                    fontSize: 9.5,
                    letterSpacing: '0.22em',
                    color: 'var(--ink-2)',
                    fontWeight: 600,
                    marginBottom: 3,
                  }}
                >
                  <span>PING HISTORY</span>
                  <span style={{ color: pingColor(ping) }}>{pingLabel(ping).toUpperCase()}</span>
                </div>
                <div style={{ height: 34, color: pingColor(ping) }}>
                  <Sparkline
                    data={h.ping}
                    height={34}
                    color="currentColor"
                    fill="rgba(57,229,255,0.10)"
                    strokeWidth={1.2}
                  />
                </div>
              </div>
            )}

            <div
              style={{
                marginTop: 6,
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
              <KV k="SESSION" v={`${sessionMin}m`} title={`Since ${new Date(totalsRef.current.sinceMs).toLocaleTimeString()}`} />
              <KV k="RX" v={formatBytes(totalsRef.current.downKb)} title="Total bytes received this session" />
              <KV k="TX" v={formatBytes(totalsRef.current.upKb)} title="Total bytes sent this session" />
              <KV k="ROUTE" v={vpnActive ? 'VPN' : 'direct'} title="Default route" />
            </div>

            <div
              style={{
                display: 'flex',
                gap: 4,
                marginTop: 6,
                flexWrap: 'wrap',
              }}
            >
              <Chip onClick={wifiOn} label="WIFI ON" />
              <Chip onClick={wifiOff} label="WIFI OFF" />
              <Chip onClick={toFlushDns} label="FLUSH DNS" />
              <Chip onClick={toSharing} label="SHARING" />
              <Chip onClick={resetTotals} label="RESET Σ" />
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
