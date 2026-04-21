/**
 * SYSTEM tab — host + bundle posture and active connections.
 *
 * Five panels, all live:
 *   1. Bundle + process metadata (pid, path, signer, version, env).
 *   2. System-integrity grid (SIP / Gatekeeper / FileVault / Firewall /
 *      Sunny bundle codesign / configuration profiles).
 *   3. Canary token status.
 *   4. Active network connections (lsof snapshot for the Sunny PID).
 *   5. File integrity monitor table (`~/.sunny/*` hashes).
 *   6. Per-tool rate snapshot (live rate / baseline / z-score).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  emptyStateStyle,
  hintStyle,
  mutedBtnStyle,
  sectionStyle,
  sectionTitleStyle,
  severityColor,
} from './styles';
import { invokeSafe } from '../../lib/tauri';
import {
  fetchBundleInfo,
  fetchCanaryStatus,
  fetchConnections,
  fetchEnvFingerprint,
  fetchFimBaseline,
  fetchIncidents,
  fetchIntegrityGrid,
  fetchProcessTree,
  fetchToolRates,
  fetchXprotect,
} from './api';
import type {
  BundleInfo,
  CanaryStatus,
  Connection,
  DescendantProcess,
  FimBaseline,
  IncidentEntry,
  IntegrityGrid,
  ToolRateSnapshot,
  XprotectStatus,
} from './types';

export function SystemTab() {
  const [bundle, setBundle] = useState<BundleInfo | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityGrid | null>(null);
  const [canary, setCanary] = useState<CanaryStatus | null>(null);
  const [conns, setConns] = useState<ReadonlyArray<Connection>>([]);
  const [fim, setFim] = useState<FimBaseline | null>(null);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [tools, setTools] = useState<ReadonlyArray<ToolRateSnapshot>>([]);
  const [procs, setProcs] = useState<ReadonlyArray<DescendantProcess>>([]);
  const [xprotect, setXprotect] = useState<XprotectStatus | null>(null);
  const [incidents, setIncidents] = useState<ReadonlyArray<IncidentEntry>>([]);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setBusy(true);
    const b = await fetchBundleInfo();
    const ig = await fetchIntegrityGrid();
    const cs = await fetchCanaryStatus();
    const c = await fetchConnections();
    const f = await fetchFimBaseline();
    const e = await fetchEnvFingerprint();
    const t = await fetchToolRates();
    const p = await fetchProcessTree();
    const xp = await fetchXprotect();
    const inc = await fetchIncidents();
    setBundle(b);
    setIntegrity(ig);
    setCanary(cs);
    setConns(c);
    setFim(f);
    setEnv(e);
    setTools(t);
    setProcs(p);
    setXprotect(xp);
    setIncidents(inc);
    setBusy(false);
  };

  useEffect(() => {
    void reload();
    // Re-probe every 15 s; connections + tool rates move quickly,
    // integrity + FIM rarely change but the cost is tiny.
    const t = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <>
      <BundlePanel bundle={bundle} onReload={() => void reload()} busy={busy} />
      <IntegrityPanel integrity={integrity} />
      <XprotectPanel xp={xprotect} />
      <CanaryPanel canary={canary} />
      <ProcessTreePanel procs={procs} />
      <ConnectionsPanel conns={conns} />
      <FimPanel fim={fim} />
      <IncidentsPanel incidents={incidents} onCapture={() => void reload()} />
      <EnvPanel env={env} />
      <ToolRatesPanel tools={tools} />
    </>
  );
}

function XprotectPanel({ xp }: { xp: XprotectStatus | null }) {
  if (!xp) {
    return (
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>APPLE XPROTECT</div>
        <div style={emptyStateStyle}>Probing Apple's built-in YARA engine…</div>
      </section>
    );
  }
  const color = xp.present ? 'var(--green)' : 'var(--amber)';
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>APPLE XPROTECT</span>
        <span style={{
          marginLeft: 'auto',
          padding: '1px 8px',
          border: `1px solid ${color}88`,
          background: `${color}14`,
          color,
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.22em',
          fontWeight: 700,
        }}>
          {xp.present ? `v${xp.version || '?'}` : 'NOT FOUND'}
        </span>
      </div>
      {xp.present ? (
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, fontFamily: 'var(--mono)', fontSize: 11 }}>
          <Key>YARA RULES</Key>
          <Val>{xp.rules_count.toLocaleString()} rules · {formatBytes(xp.rules_size)}</Val>
          <Key>PATH</Key>
          <Val>{xp.rules_path}</Val>
          <Key>FINGERPRINT</Key>
          <Val highlight>{xp.rules_sha256.slice(0, 32)}…</Val>
        </div>
      ) : (
        <div style={hintStyle}>
          XProtect bundle not present at the expected path. On macOS 13+ it lives under
          <code style={{ marginLeft: 4 }}>/Library/Apple/System/…/XProtect.bundle</code>.
        </div>
      )}
      <div style={{ ...hintStyle, marginTop: 8, fontSize: 10 }}>
        Apple's signature engine runs automatically on every app launch. We don't execute
        these rules ourselves — we just show you they're in place alongside Sunny's own
        signature DB so you know how many independent detectors are covering you.
      </div>
    </section>
  );
}

function IncidentsPanel({ incidents, onCapture }: { incidents: ReadonlyArray<IncidentEntry>; onCapture: () => void }) {
  const [busy, setBusy] = useState(false);
  const onManualCapture = async () => {
    setBusy(true);
    await invokeSafe<string>('security_incident_capture', { reason: 'manual from SYSTEM tab' });
    setBusy(false);
    onCapture();
  };
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>INCIDENT BUNDLES</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          {incidents.length} bundle{incidents.length === 1 ? '' : 's'} · auto-captured on panic
        </span>
        <button type="button" style={mutedBtnStyle} onClick={() => void onManualCapture()} disabled={busy}>
          {busy ? 'CAPTURING…' : 'CAPTURE NOW'}
        </button>
      </div>
      {incidents.length === 0 ? (
        <div style={emptyStateStyle}>
          No incident bundles yet. Panic capture drops a forensic JSON under
          <code style={{ marginLeft: 4 }}>~/.sunny/security/incidents/</code>.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 2 }}>
          {incidents.slice(0, 20).map(inc => (
            <div
              key={inc.path}
              style={{
                display: 'grid',
                gridTemplateColumns: '200px 1fr 100px',
                gap: 10,
                padding: '4px 10px',
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.45)',
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
              }}
            >
              <span style={{ color: 'var(--cyan)' }}>
                {new Date(inc.captured_at * 1000).toLocaleString('en-GB', { hour12: false })}
              </span>
              <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inc.path}>
                {inc.path.split('/').slice(-2).join('/')}
              </span>
              <span style={{ color: 'var(--ink-dim)', textAlign: 'right' }}>
                {formatBytes(inc.size)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProcessTreePanel({ procs }: { procs: ReadonlyArray<DescendantProcess> }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>PROCESS TREE · Sunny descendants</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          {procs.length} descendant{procs.length === 1 ? '' : 's'} · polled every 10 s
        </span>
      </div>
      {procs.length === 0 ? (
        <div style={emptyStateStyle}>
          No descendant processes right now. The agent hasn't shelled out.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 2 }}>
          {procs.slice(0, 40).map(p => (
            <div
              key={p.pid}
              style={{
                display: 'grid',
                gridTemplateColumns: '70px 70px 200px 1fr',
                gap: 10,
                padding: '3px 8px',
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.45)',
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
              }}
              title={p.cmd}
            >
              <span style={{ color: 'var(--cyan)' }}>{p.pid}</span>
              <span style={{ color: 'var(--ink-dim)' }}>← {p.parent_pid}</span>
              <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <span style={{ color: 'var(--ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.cmd || p.exe}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function BundlePanel({
  bundle,
  onReload,
  busy,
}: {
  bundle: BundleInfo | null;
  onReload: () => void;
  busy: boolean;
}) {
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>SUNNY PROCESS</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>self-identity</span>
        <button type="button" style={mutedBtnStyle} onClick={onReload} disabled={busy}>
          {busy ? 'PROBING…' : 'REFRESH'}
        </button>
      </div>
      {!bundle ? (
        <div style={emptyStateStyle}>Resolving process metadata…</div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr',
            rowGap: 4,
            columnGap: 12,
            fontFamily: 'var(--mono)',
            fontSize: 11,
          }}
        >
          <Key>PID</Key>           <Val>{bundle.pid}</Val>
          <Key>VERSION</Key>       <Val>{bundle.version}</Val>
          <Key>BUNDLE PATH</Key>   <Val>{bundle.bundle_path || '(dev build)'}</Val>
          <Key>EXE PATH</Key>      <Val>{bundle.exe_path}</Val>
          <Key>CODE SIGNER</Key>   <Val highlight>{bundle.signer}</Val>
        </div>
      )}
    </section>
  );
}

function IntegrityPanel({ integrity }: { integrity: IntegrityGrid | null }) {
  const rows: Array<{ key: string; label: string; blurb: string; data?: { status: string; summary: string; detail: string } }> = useMemo(() => [
    { key: 'sip', label: 'System Integrity Protection', blurb: 'Kernel-level protection of system files / kexts. Should be enabled.', data: integrity?.sip },
    { key: 'gatekeeper', label: 'Gatekeeper', blurb: 'Signature-verification for downloaded apps. Should be enabled.', data: integrity?.gatekeeper },
    { key: 'filevault', label: 'FileVault', blurb: 'Full-disk encryption at rest. Should be on.', data: integrity?.filevault },
    { key: 'firewall', label: 'Application Firewall', blurb: 'macOS built-in per-app inbound firewall. Secondary to PF / Little Snitch.', data: integrity?.firewall },
    { key: 'bundle', label: 'Sunny bundle codesign', blurb: 'Re-checked every 2 min. A failure here means the binary has been tampered with.', data: integrity?.bundle },
    { key: 'profiles', label: 'Configuration profiles / MDM', blurb: 'Listed via `profiles`. New profiles you didn\'t install are worth investigating.', data: integrity?.config_profiles },
  ], [integrity]);

  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>SYSTEM INTEGRITY</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          Last probed{' '}
          {integrity?.updated_at
            ? new Date(integrity.updated_at * 1000).toLocaleTimeString('en-GB', { hour12: false })
            : '—'}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {rows.map(r => {
          const status = r.data?.status ?? 'unknown';
          const color = severityColor(status as 'ok' | 'warn' | 'crit' | 'unknown');
          return (
            <div
              key={r.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '260px 90px 1fr',
                gap: 10,
                alignItems: 'center',
                padding: '6px 10px',
                border: `1px solid ${color}33`,
                background: `${color}08`,
                fontFamily: 'var(--mono)',
                fontSize: 11,
              }}
              title={r.data?.detail || ''}
            >
              <span style={{ color: 'var(--ink)' }}>{r.label}</span>
              <span
                style={{
                  color,
                  padding: '1px 7px',
                  border: `1px solid ${color}88`,
                  background: `${color}14`,
                  fontSize: 9,
                  letterSpacing: '0.22em',
                  fontWeight: 700,
                  textAlign: 'center',
                  textTransform: 'uppercase',
                }}
              >
                {r.data?.summary || status}
              </span>
              <span style={{ color: 'var(--ink-dim)', fontSize: 10.5 }}>{r.blurb}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CanaryPanel({ canary }: { canary: CanaryStatus | null }) {
  const armed = canary?.armed ?? false;
  const color = armed ? 'var(--green)' : 'var(--ink-dim)';
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>CANARY TOKEN</span>
        <span style={{
          marginLeft: 'auto',
          padding: '1px 8px',
          border: `1px solid ${color}88`,
          background: `${color}14`,
          color,
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.22em',
          fontWeight: 700,
        }}>
          {armed ? 'ARMED' : 'OFFLINE'}
        </span>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, display: 'grid', gap: 4 }}>
        <div>
          <span style={{ color: 'var(--ink-dim)' }}>Token preview </span>
          <span style={{ color: 'var(--cyan)' }}>{canary?.token_preview || '—'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--ink-dim)' }}>Location </span>
          <span style={{ color: 'var(--ink)' }}>{canary?.location || '—'}</span>
        </div>
        <div style={{ ...hintStyle, marginTop: 4 }}>
          A honeypot API-key-shaped string planted in the process env + a file under
          ~/.sunny/security/. Sunny's own HTTP wrapper scans every outbound URL for this
          token — if anything ever contains it, that's a confirmed exfiltration and
          panic mode engages automatically.
        </div>
      </div>
    </section>
  );
}

function ConnectionsPanel({ conns }: { conns: ReadonlyArray<Connection> }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>ACTIVE CONNECTIONS</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          lsof -iP · {conns.length} socket{conns.length === 1 ? '' : 's'}
        </span>
      </div>
      {conns.length === 0 ? (
        <div style={emptyStateStyle}>
          No open sockets for this process — or `lsof` isn't installed.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 2 }}>
          {conns.slice(0, 80).map((c, i) => {
            const listen = c.state === 'LISTEN';
            const color = listen ? 'var(--violet)' : c.state === 'ESTABLISHED' ? 'var(--green)' : 'var(--ink-dim)';
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '50px 50px 180px 1fr 100px',
                  gap: 10,
                  padding: '3px 8px',
                  border: `1px solid ${color}22`,
                  background: `${color}06`,
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                }}
              >
                <span style={{ color }}>{c.protocol}</span>
                <span style={{ color: 'var(--ink-dim)' }}>{c.fd}</span>
                <span style={{ color: 'var(--ink)' }}>{c.local}</span>
                <span style={{ color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.remote}
                </span>
                <span style={{ color, textAlign: 'right' }}>{c.state}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FimPanel({ fim }: { fim: FimBaseline | null }) {
  if (!fim) {
    return (
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>FILE INTEGRITY MONITOR</div>
        <div style={emptyStateStyle}>Probing config hashes…</div>
      </section>
    );
  }
  const entries = Object.values(fim.entries);
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>FILE INTEGRITY MONITOR</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          {entries.length} tracked paths · captured{' '}
          {fim.captured_at ? new Date(fim.captured_at * 1000).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 2 }}>
        {entries.map(e => {
          const color = e.exists ? 'var(--green)' : 'var(--amber)';
          return (
            <div
              key={e.path}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 120px 140px 110px',
                gap: 10,
                padding: '4px 10px',
                border: `1px solid ${color}33`,
                background: `${color}06`,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
              }}
            >
              <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {shortenHomePath(e.path)}
              </span>
              <span style={{ color: 'var(--ink-dim)', textAlign: 'right' }}>
                {e.exists ? formatBytes(e.size) : 'missing'}
              </span>
              <span style={{ color: 'var(--cyan)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.sha256 ? e.sha256.slice(0, 16) + '…' : '—'}
              </span>
              <span style={{ color: 'var(--ink-dim)', textAlign: 'right', fontSize: 10 }}>
                {e.modified ? new Date(e.modified * 1000).toLocaleDateString('en-GB') : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EnvPanel({ env }: { env: Record<string, string> }) {
  const rows = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>ENV FINGERPRINT</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          allowlisted keys only · values never logged
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={emptyStateStyle}>No tracked env vars set.</div>
      ) : (
        <div style={{ display: 'grid', gap: 2 }}>
          {rows.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '180px 1fr',
                gap: 10,
                padding: '4px 10px',
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.45)',
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
              }}
            >
              <span style={{ color: 'var(--cyan)' }}>{k}</span>
              <span style={{ color: 'var(--ink)' }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolRatesPanel({ tools }: { tools: ReadonlyArray<ToolRateSnapshot> }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>TOOL RATE BASELINES</span>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>
          z ≥ 3 or rate ≥ 5× baseline auto-fires an anomaly event · {tools.length} tool{tools.length === 1 ? '' : 's'} seen
        </span>
      </div>
      {tools.length === 0 ? (
        <div style={emptyStateStyle}>
          No tool calls yet this session — run a chat turn to start the baseline.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 2 }}>
          {tools.slice(0, 40).map(t => {
            const hot = t.z_score >= 3 || t.rate_per_min >= 5 * Math.max(1, t.baseline_per_min);
            const color = hot ? 'var(--amber)' : 'var(--ink-dim)';
            return (
              <div
                key={t.tool}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 90px 110px 90px 70px',
                  gap: 10,
                  padding: '4px 10px',
                  border: `1px solid ${color}22`,
                  background: `${color}06`,
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                }}
              >
                <span style={{ color: 'var(--ink)' }}>{t.tool}</span>
                <span style={{ color: 'var(--cyan)', textAlign: 'right' }}>
                  {t.rate_per_min.toFixed(0)}/min
                </span>
                <span style={{ color: 'var(--ink-dim)', textAlign: 'right' }}>
                  baseline {t.baseline_per_min.toFixed(1)}
                </span>
                <span style={{ color: hot ? 'var(--amber)' : 'var(--ink-dim)', textAlign: 'right' }}>
                  z={t.z_score.toFixed(1)}
                </span>
                <span style={{ color: 'var(--ink-dim)', textAlign: 'right' }}>
                  {t.total_calls} total
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, letterSpacing: '0.2em', color: 'var(--ink-dim)', textTransform: 'uppercase' }}>
      {children}
    </span>
  );
}

function Val({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return (
    <span style={{
      color: highlight ? 'var(--cyan)' : 'var(--ink)',
      fontWeight: highlight ? 600 : 400,
      wordBreak: 'break-all',
    }}>
      {children}
    </span>
  );
}

function shortenHomePath(p: string): string {
  // ~/Users/…  → ~/… for readability.  Falls back to raw if HOME
  // isn't known client-side.
  const m = p.match(/^\/Users\/[^/]+(\/.*)$/);
  return m ? `~${m[1]}` : p;
}

function formatBytes(n: number): string {
  if (!n) return '0';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
