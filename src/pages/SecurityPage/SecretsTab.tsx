/**
 * SECRETS tab — Keychain-backed API keys + vault items, with last-read
 * timestamps sourced from the security audit log.
 */

import { useEffect, useMemo, useState } from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  emptyStateStyle,
  hintStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import { fetchEvents, subscribeEvents } from './api';
import type { SecurityEvent } from './types';
import type { SecretsStatus } from '../../bindings/SecretsStatus';

type VaultItem = {
  id: string;
  name: string;
  createdAt: string;
  lastReveal?: string;
};

const PROVIDER_LABELS: Record<keyof SecretsStatus, string> = {
  anthropic:   'Anthropic',
  zai:         'Z.AI / GLM',
  openai:      'OpenAI',
  openrouter:  'OpenRouter',
  elevenlabs:  'ElevenLabs',
  wavespeed:   'Wavespeed',
};

export function SecretsTab() {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [vault, setVault] = useState<ReadonlyArray<VaultItem>>([]);
  const [events, setEvents] = useState<ReadonlyArray<SecurityEvent>>([]);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setBusy(true);
    const [s, v, e] = await Promise.all([
      invokeSafe<SecretsStatus>('secrets_status'),
      invokeSafe<ReadonlyArray<VaultItem>>('vault_list'),
      fetchEvents(800),
    ]);
    if (s) setStatus(s);
    if (v) setVault(v);
    setEvents(e);
    setBusy(false);
  };

  useEffect(() => {
    void reload();
    const p = subscribeEvents(ev => {
      if (ev.kind === 'secret_read') {
        setEvents(prev => [...prev, ev].slice(-1000));
      }
    });
    return () => {
      void p.then(u => u && u());
    };
  }, []);

  // Derive last-read timestamps from the secret_read event stream.
  const lastRead = useMemo(() => {
    const map = new Map<string, number>();
    for (const ev of events) {
      if (ev.kind !== 'secret_read') continue;
      const prev = map.get(ev.provider) ?? 0;
      if (ev.at > prev) map.set(ev.provider, ev.at);
    }
    return map;
  }, [events]);

  const readCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const ev of events) {
      if (ev.kind !== 'secret_read') continue;
      map.set(ev.provider, (map.get(ev.provider) ?? 0) + 1);
    }
    return map;
  }, [events]);

  const onVerify = async (provider: string) => {
    setBusy(true);
    const v = await invokeSafe<{ ok: boolean; category: string; message: string }>(
      'secret_verify',
      { provider },
    );
    setBusy(false);
    if (v) {
      alert(`${provider}: ${v.ok ? 'OK' : 'FAIL'} (${v.category}) — ${v.message}`);
    }
  };

  const providers = status ? (Object.keys(status) as ReadonlyArray<keyof SecretsStatus>) : [];

  return (
    <>
      {/* Provider keys */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>PROVIDER KEYS (Keychain)</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            env vars override Keychain · values never leave Rust
          </span>
          <button type="button" style={mutedBtnStyle} onClick={() => void reload()} disabled={busy}>
            REFRESH
          </button>
        </div>
        {!status ? (
          <div style={emptyStateStyle}>Loading…</div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {providers.map(p => (
              <ProviderRow
                key={p}
                label={PROVIDER_LABELS[p]}
                providerId={p}
                present={status[p]}
                lastReadAt={lastRead.get(p)}
                readCount={readCounts.get(p) ?? 0}
                onVerify={() => void onVerify(p)}
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>

      {/* Vault items */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>VAULT ITEMS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {vault.length} item{vault.length === 1 ? '' : 's'} · values stored in Keychain
          </span>
        </div>
        {vault.length === 0 ? (
          <div style={emptyStateStyle}>
            Vault is empty. Add a secret from the VAULT module; it lives here under
            `sunny.&lt;uuid&gt;` in the login Keychain.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {vault.map(item => (
              <div
                key={item.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 160px 160px',
                  gap: 10,
                  padding: '6px 10px',
                  border: '1px solid var(--line-soft)',
                  background: 'rgba(4, 10, 16, 0.45)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                <span style={{ color: 'var(--ink)' }}>{item.name}</span>
                <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
                  added {formatDate(item.createdAt)}
                </span>
                <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
                  last revealed {item.lastReveal ? formatDate(item.lastReveal) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ ...sectionStyle, borderStyle: 'dashed' }}>
        <div style={sectionTitleStyle}>NOTES</div>
        <ul style={{ ...hintStyle, margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>
            Every <code>secrets::resolve()</code> call emits a <code>secret_read</code>
            event (without the value).  The counts above are sourced from the
            in-memory audit ring — they reset on app restart.
          </li>
          <li>
            Phase 2 adds pre-send prompt redaction so API keys pasted into chat can't
            leak to a remote LLM — see <code>docs/SECURITY.md</code>.
          </li>
        </ul>
      </section>
    </>
  );
}

function ProviderRow({
  label,
  present,
  lastReadAt,
  readCount,
  onVerify,
  busy,
}: {
  label: string;
  providerId: string;
  present: boolean;
  lastReadAt?: number;
  readCount: number;
  onVerify: () => void;
  busy: boolean;
}) {
  const color = present ? 'var(--green)' : 'var(--ink-dim)';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px 80px 1fr 160px auto',
        gap: 10,
        alignItems: 'center',
        padding: '6px 10px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.45)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <span style={{ color: 'var(--ink)' }}>{label}</span>
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
        {present ? 'stored' : 'missing'}
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
        {readCount > 0
          ? `read ${readCount} time${readCount === 1 ? '' : 's'} this session`
          : 'not read this session'}
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10 }}>
        last read:{' '}
        {lastReadAt ? new Date(lastReadAt * 1000).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
      </span>
      <button type="button" style={primaryBtnStyle} onClick={onVerify} disabled={busy || !present}>
        {busy ? 'VERIFYING…' : 'VERIFY'}
      </button>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour12: false });
}
