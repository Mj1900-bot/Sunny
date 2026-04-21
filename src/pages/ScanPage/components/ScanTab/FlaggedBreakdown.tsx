import { useEffect, useMemo, useState } from 'react';
import type { Finding } from '../../types';
import { SIGNAL_LABEL, VERDICT_META, formatSize, shortPath } from '../../types';
import { scanRevealInFinder } from '../../api';
import { DISPLAY_FONT, hintStyle, mutedBtnStyle } from '../../styles';

const VERDICT_HEADLINE: Record<'suspicious' | 'malicious', { title: string; blurb: string }> = {
  malicious: {
    title: 'MALICIOUS',
    blurb:
      'SHA-256 matched a known-bad sample (MalwareBazaar or VirusTotal). Move to the vault immediately.',
  },
  suspicious: {
    title: 'SUSPICIOUS',
    blurb:
      'Multiple risk signals combined — path, signature, age, or type. Not confirmed malware; worth reviewing.',
  },
};

const SIGNAL_EXPLAINER: Record<string, string> = {
  malware_bazaar_hit: 'SHA-256 is listed on abuse.ch MalwareBazaar as a known malware sample.',
  virustotal_hit: 'VirusTotal reports detections from multiple AV engines on this hash.',
  quarantined: 'macOS marked this file with a Gatekeeper quarantine attribute (downloaded / untrusted origin).',
  unsigned: 'Binary has no valid code signature — anyone could have produced or tampered with it.',
  risky_path: 'Location is a known persistence or drop target (LaunchAgents, tmp, Downloads, …).',
  recently_modified: 'Written or modified very recently — worth re-checking after fresh activity.',
  executable: 'File is marked executable or has a Mach-O / PE / ELF magic header.',
  unusual_script: 'Script body shows obfuscation markers (base64 blobs, decode-and-exec chains, curl | sh, …).',
  size_anomaly: 'Size is unusual for its file type — can indicate padded droppers or stripped binaries.',
  hidden_in_user_dir: 'Dot-prefixed (hidden) file buried inside a user directory — unusual for legitimate apps.',
  known_malware_family: 'Matched a 2024-2026 macOS malware family IoC — Atomic Stealer (AMOS), Banshee, XCSSET, NotLockBit, KandyKorn, RustBucket, etc.',
  prompt_injection: 'Matched a known LLM attack pattern from OWASP LLM01 — jailbreak (DAN/STAN/AIM), fake system-role markers, invisible Unicode smuggling, or agent tool-call exfil.',
};

export function FlaggedBreakdown({
  findings,
  isLive,
  onJumpToFindings,
}: {
  findings: ReadonlyArray<Finding>;
  isLive: boolean;
  onJumpToFindings?: () => void;
}) {
  const malicious = useMemo(
    () => findings.filter(f => f.verdict === 'malicious'),
    [findings],
  );
  const suspicious = useMemo(
    () => findings.filter(f => f.verdict === 'suspicious'),
    [findings],
  );
  const total = malicious.length + suspicious.length;

  if (total === 0) return null;

  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          paddingBottom: 6,
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <span
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 10.5,
            letterSpacing: '0.26em',
            color: 'var(--cyan)',
            fontWeight: 700,
          }}
        >
          FLAGGED · WHY
        </span>
        <span style={{ ...hintStyle }}>
          {malicious.length > 0 && (
            <>
              <strong style={{ color: '#ff6a6a' }}>{malicious.length}</strong> malicious
              {suspicious.length > 0 ? ' · ' : ' '}
            </>
          )}
          {suspicious.length > 0 && (
            <>
              <strong style={{ color: 'var(--amber)' }}>{suspicious.length}</strong> suspicious
            </>
          )}
          {isLive ? ' · updating as we scan' : ' · scan complete'}
        </span>
        {onJumpToFindings && (
          <button
            style={{ ...mutedBtnStyle, marginLeft: 'auto' }}
            onClick={onJumpToFindings}
            title="Open the full Findings triage view"
          >
            OPEN FINDINGS →
          </button>
        )}
      </div>

      {malicious.length > 0 && (
        <FlaggedGroup
          heading={VERDICT_HEADLINE.malicious}
          findings={malicious}
          initiallyExpanded={true}
        />
      )}
      {suspicious.length > 0 && (
        <FlaggedGroup
          heading={VERDICT_HEADLINE.suspicious}
          findings={suspicious}
          initiallyExpanded={suspicious.length <= 5}
        />
      )}
    </div>
  );
}

function FlaggedGroup({
  heading,
  findings,
  initiallyExpanded,
}: {
  heading: { title: string; blurb: string };
  findings: ReadonlyArray<Finding>;
  initiallyExpanded: boolean;
}) {
  const [openAll, setOpenAll] = useState<boolean>(initiallyExpanded);
  const verdict = findings[0]?.verdict ?? 'suspicious';
  const meta = VERDICT_META[verdict];

  return (
    <div
      style={{
        border: `1px solid ${meta.border}`,
        background: meta.bg,
        padding: '10px 12px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 10,
            letterSpacing: '0.26em',
            color: meta.color,
            fontWeight: 700,
          }}
        >
          {heading.title} · {findings.length}
        </span>
        <span style={{ ...hintStyle, fontSize: 10.5, color: 'var(--ink-2)' }}>
          {heading.blurb}
        </span>
        <button
          onClick={() => setOpenAll(v => !v)}
          style={{ ...mutedBtnStyle, marginLeft: 'auto' }}
        >
          {openAll ? 'COLLAPSE ALL' : 'EXPAND ALL'}
        </button>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {findings.map(f => (
          <FlaggedRow key={f.id} finding={f} startOpen={openAll} />
        ))}
      </div>
    </div>
  );
}

function FlaggedRow({
  finding,
  startOpen,
}: {
  finding: Finding;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState<boolean>(startOpen);
  // When the group-level toggle flips, track it so the row follows suit.
  useEffect(() => setOpen(startOpen), [startOpen]);

  const meta = VERDICT_META[finding.verdict];
  const signals = finding.signals;
  const topSignal = signals[0];

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.55)',
      }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto',
          gap: 10,
          alignItems: 'center',
          padding: '8px 10px',
          width: '100%',
          boxSizing: 'border-box',
        }}
        title={finding.path}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.18em',
            color: meta.color,
            border: `1px solid ${meta.border}`,
            background: meta.bg,
            padding: '1px 6px',
          }}
        >
          {meta.label}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {shortPath(finding.path, 90)}
        </span>
        <span style={{ ...hintStyle, fontSize: 10 }}>
          {formatSize(finding.size)} · {signals.length} signal{signals.length === 1 ? '' : 's'}
        </span>
        <span
          style={{
            ...hintStyle,
            fontSize: 10,
            color: 'var(--ink-dim)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        >
          ▸
        </span>
      </button>

      {!open && topSignal && (
        <div
          style={{
            ...hintStyle,
            fontSize: 10.5,
            padding: '0 10px 8px 10px',
            color: 'var(--ink-2)',
          }}
        >
          <span style={{ color: meta.color }}>▸</span>{' '}
          <strong style={{ color: 'var(--ink)' }}>
            {SIGNAL_LABEL[topSignal.kind]}
          </strong>
          {' — '}
          {topSignal.detail || SIGNAL_EXPLAINER[topSignal.kind] || 'flagged by heuristic'}
          {signals.length > 1 && (
            <span style={{ color: 'var(--ink-dim)' }}>
              {'  '}(+{signals.length - 1} more — click to expand)
            </span>
          )}
        </div>
      )}

      {open && (
        <div
          style={{
            borderTop: '1px dashed var(--line-soft)',
            padding: '10px 12px 12px 12px',
            display: 'grid',
            gap: 10,
          }}
        >
          <div
            style={{
              ...hintStyle,
              fontSize: 11,
              color: 'var(--ink-2)',
            }}
          >
            <span style={{ color: meta.color }}>▸</span> {finding.summary}
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            {signals.map((s, i) => {
              const sv = VERDICT_META[s.weight];
              return (
                <div
                  key={`${s.kind}-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '130px auto 1fr',
                    gap: 10,
                    alignItems: 'start',
                    padding: '6px 8px',
                    border: '1px dashed var(--line-soft)',
                    background: 'rgba(2, 6, 10, 0.55)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 9.5,
                      letterSpacing: '0.18em',
                      color: 'var(--ink-dim)',
                      textTransform: 'uppercase',
                      paddingTop: 2,
                    }}
                  >
                    {SIGNAL_LABEL[s.kind]}
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      padding: '1px 6px',
                      fontFamily: 'var(--mono)',
                      fontSize: 9,
                      letterSpacing: '0.18em',
                      color: sv.color,
                      border: `1px solid ${sv.border}`,
                      background: sv.bg,
                      height: 'fit-content',
                    }}
                  >
                    {sv.label}
                  </span>
                  <div style={{ display: 'grid', gap: 3 }}>
                    <span
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: 'var(--ink)',
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                      }}
                    >
                      {s.detail || '(no detail)'}
                    </span>
                    {SIGNAL_EXPLAINER[s.kind] && (
                      <span
                        style={{
                          ...hintStyle,
                          fontSize: 10,
                          color: 'var(--ink-dim)',
                          lineHeight: 1.45,
                        }}
                      >
                        {SIGNAL_EXPLAINER[s.kind]}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr',
              rowGap: 4,
              columnGap: 10,
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
            }}
          >
            <span style={{ color: 'var(--ink-dim)', letterSpacing: '0.18em' }}>PATH</span>
            <span style={{ color: 'var(--ink)', wordBreak: 'break-all' }}>{finding.path}</span>
            <span style={{ color: 'var(--ink-dim)', letterSpacing: '0.18em' }}>SHA-256</span>
            <span style={{ color: 'var(--ink)', wordBreak: 'break-all' }}>
              {finding.sha256 ?? '(not hashed)'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              style={mutedBtnStyle}
              onClick={e => {
                e.stopPropagation();
                void scanRevealInFinder(finding.path).catch(() => undefined);
              }}
            >
              REVEAL IN FINDER
            </button>
            <button
              style={mutedBtnStyle}
              onClick={e => {
                e.stopPropagation();
                void navigator.clipboard?.writeText(finding.path);
              }}
            >
              COPY PATH
            </button>
            {finding.sha256 && (
              <button
                style={mutedBtnStyle}
                onClick={e => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(finding.sha256 ?? '');
                }}
              >
                COPY SHA-256
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
