/**
 * Sprint-12 η — Skill import UI with provenance verification.
 *
 * A user can paste JSON or pick a file containing:
 *
 * ```json
 * {
 *   "name": "...",
 *   "description": "...",
 *   "trigger_text": "...",
 *   "recipe": { "steps": [...], "capabilities": [...] },
 *   "signature": "hex-encoded ed25519 signature (optional)",
 *   "public_key": "hex-encoded ed25519 pubkey (optional)"
 * }
 * ```
 *
 * Verification flow:
 *
 *   1. **No signature** → yellow warning; user may override to save
 *      unsigned.  The Rust `memory_skill_add` path accepts this.
 *   2. **Bad signature / tampered body** → red error; import REFUSED.
 *      Fail-closed: a present signature that doesn't match means
 *      someone tampered with the manifest and we MUST reject rather
 *      than surface a confusing "valid but also corrupt" state.
 *   3. **Valid, signer already trusted** → save immediately.
 *   4. **Valid, unknown signer** → show fingerprint, ask "trust this
 *      signer?" (persists trust-on-first-use decision).
 *
 * See `lib/skillSignature.ts` for the verify path.
 */

import { useCallback, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Section, Toolbar, ToolbarButton } from '../_shared';
import { invokeSafe } from '../../lib/tauri';
import {
  buildManifest,
  isSignerTrusted,
  trustSigner,
  verifyManifestBackend,
  type SkillManifest,
  type VerifyOutcome,
} from '../../lib/skillSignature';
import type { ProceduralSkill } from './api';

// ---------------------------------------------------------------------------
// Manifest shape the user pastes / uploads.
// ---------------------------------------------------------------------------

type ImportDoc = {
  readonly name: string;
  readonly description: string;
  readonly trigger_text: string;
  readonly recipe: unknown;
  readonly signature?: string;
  readonly public_key?: string;
  // Sprint-13 η — the EXPORT side wraps the signature-covering fields in
  // a `manifest` sub-object AND splats them at the top level for
  // backwards compatibility. When both forms are present, the
  // sub-object is authoritative (the top-level fields are a convenience
  // mirror and could drift under adversarial editing). Unknown extras
  // (`schema`, `signer_fingerprint`, `signed_at`) are ignored.
  readonly manifest?: {
    readonly name: string;
    readonly description: string;
    readonly trigger_text: string;
    readonly recipe: unknown;
  };
};

type Verdict =
  | { readonly kind: 'idle' }
  | { readonly kind: 'unsigned'; readonly manifest: SkillManifest }
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
      readonly kind: 'valid_trusted';
      readonly manifest: SkillManifest;
      readonly fingerprint: string;
      readonly signature: string;
      readonly publicKey: string;
    }
  | {
      readonly kind: 'valid_unknown';
      readonly manifest: SkillManifest;
      readonly fingerprint: string;
      readonly signature: string;
      readonly publicKey: string;
    };

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SkillImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (created: ProceduralSkill) => void;
}) {
  const [raw, setRaw] = useState('');
  const [verdict, setVerdict] = useState<Verdict>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustLabel, setTrustLabel] = useState('');

  const parsed = useMemo<ImportDoc | null>(() => {
    if (raw.trim().length === 0) return null;
    try {
      const v = JSON.parse(raw) as unknown;
      if (!isImportDoc(v)) return null;
      return v;
    } catch {
      return null;
    }
  }, [raw]);

  const onFile = useCallback(async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setRaw(text);
      setVerdict({ kind: 'idle' });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runVerify = useCallback(async () => {
    setError(null);
    if (!parsed) {
      setError('Paste or load a JSON skill manifest first.');
      return;
    }
    // Prefer the nested `manifest` sub-object when the export wrapper
    // is present; fall back to the flat sprint-12 η shape otherwise.
    const source = parsed.manifest ?? parsed;
    const manifest = buildManifest({
      name: source.name,
      description: source.description,
      trigger_text: source.trigger_text,
      recipe: source.recipe,
    });

    // No signature — unsigned import path.
    if (!parsed.signature || !parsed.public_key) {
      setVerdict({ kind: 'unsigned', manifest });
      return;
    }

    setBusy(true);
    try {
      const outcome: VerifyOutcome | null = await verifyManifestBackend(
        manifest,
        parsed.signature,
        parsed.public_key,
      );
      if (!outcome) {
        setVerdict({
          kind: 'invalid',
          reason: 'verify_skill_manifest returned null (backend unavailable?)',
        });
        return;
      }
      if (outcome.status === 'invalid') {
        // Fail-closed: a bad signature means tamper + reject.
        setVerdict({ kind: 'invalid', reason: outcome.reason });
        return;
      }
      const trusted = await isSignerTrusted(outcome.fingerprint);
      setVerdict(
        trusted
          ? {
              kind: 'valid_trusted',
              manifest,
              fingerprint: outcome.fingerprint,
              signature: parsed.signature,
              publicKey: parsed.public_key,
            }
          : {
              kind: 'valid_unknown',
              manifest,
              fingerprint: outcome.fingerprint,
              signature: parsed.signature,
              publicKey: parsed.public_key,
            },
      );
    } finally {
      setBusy(false);
    }
  }, [parsed]);

  const insertSkill = useCallback(
    async (signature: string | null, fingerprint: string | null, manifest: SkillManifest) => {
      setBusy(true);
      setError(null);
      try {
        const created = await invokeSafe<ProceduralSkill>('memory_skill_add', {
          name: manifest.name,
          description: manifest.description,
          triggerText: manifest.trigger_text,
          skillPath: '',
          recipe: manifest.recipe,
          signature,
          signerFingerprint: fingerprint,
        });
        if (!created) {
          setError('Import failed — memory_skill_add returned null.');
          return;
        }
        onImported(created);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onImported],
  );

  const saveUnsigned = useCallback(() => {
    if (verdict.kind !== 'unsigned') return;
    void insertSkill(null, null, verdict.manifest);
  }, [verdict, insertSkill]);

  const saveTrusted = useCallback(() => {
    if (verdict.kind !== 'valid_trusted') return;
    void insertSkill(verdict.signature, verdict.fingerprint, verdict.manifest);
  }, [verdict, insertSkill]);

  const trustAndSave = useCallback(async () => {
    if (verdict.kind !== 'valid_unknown') return;
    setBusy(true);
    setError(null);
    try {
      await trustSigner(
        verdict.fingerprint,
        verdict.publicKey,
        trustLabel.trim().length > 0 ? trustLabel.trim() : undefined,
      );
    } catch (e) {
      setError(
        `Trust failed — ${e instanceof Error ? e.message : String(e)}. ` +
          'The skill was not imported.',
      );
      setBusy(false);
      return;
    }
    await insertSkill(verdict.signature, verdict.fingerprint, verdict.manifest);
  }, [verdict, insertSkill, trustLabel]);

  return (
    <Section title="IMPORT SKILL" right="SIGNED JSON">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}
          />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
            or paste the manifest below
          </span>
        </div>

        <textarea
          value={raw}
          onChange={e => {
            setRaw(e.target.value);
            setVerdict({ kind: 'idle' });
          }}
          placeholder={'{ "name": "...", "description": "...", "trigger_text": "...", "recipe": {...}, "signature": "...", "public_key": "..." }'}
          rows={10}
          style={{
            ...inputStyle,
            minHeight: 140,
            fontFamily: 'var(--mono)',
            resize: 'vertical',
          }}
          aria-label="Skill manifest JSON"
        />

        <Toolbar>
          <ToolbarButton tone="teal" onClick={() => void runVerify()} disabled={!parsed || busy}>
            VERIFY
          </ToolbarButton>
          <ToolbarButton onClick={onClose} disabled={busy}>
            CANCEL · ESC
          </ToolbarButton>
          <span style={{ flex: 1 }} />
          {parsed && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
              Parsed · {parsed.signature ? 'signed' : 'unsigned'}
            </span>
          )}
        </Toolbar>

        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}

        {verdict.kind === 'invalid' && (
          <div role="alert" style={errorStyle}>
            <strong style={{ display: 'block', marginBottom: 2 }}>
              IMPORT REFUSED — signature did not verify
            </strong>
            {verdict.reason}
          </div>
        )}

        {verdict.kind === 'unsigned' && (
          <WarnBlock>
            <strong style={{ display: 'block', marginBottom: 2 }}>
              UNSIGNED SKILL
            </strong>
            <div style={{ marginBottom: 6 }}>
              This manifest has no provenance. You cannot verify who wrote it
              or whether it has been tampered with in transit. Import anyway
              only if you trust the source.
            </div>
            <Toolbar>
              <ToolbarButton tone="gold" onClick={saveUnsigned} disabled={busy}>
                IMPORT UNSIGNED
              </ToolbarButton>
            </Toolbar>
          </WarnBlock>
        )}

        {verdict.kind === 'valid_trusted' && (
          <OkBlock>
            <strong style={{ display: 'block', marginBottom: 2 }}>
              SIGNATURE VALID · SIGNER TRUSTED
            </strong>
            <Mono>fingerprint: {verdict.fingerprint}</Mono>
            <Toolbar style={{ marginTop: 6 }}>
              <ToolbarButton tone="cyan" onClick={saveTrusted} disabled={busy}>
                IMPORT
              </ToolbarButton>
            </Toolbar>
          </OkBlock>
        )}

        {verdict.kind === 'valid_unknown' && (
          <WarnBlock>
            <strong style={{ display: 'block', marginBottom: 2 }}>
              SIGNATURE VALID · UNKNOWN SIGNER
            </strong>
            <div style={{ marginBottom: 4 }}>
              The manifest is cryptographically intact, but you have not
              trusted this signer before. If you import, we can remember
              them for next time.
            </div>
            <Mono>fingerprint: {verdict.fingerprint}</Mono>
            <Mono>public_key:  {verdict.publicKey.slice(0, 24)}…</Mono>
            <div style={{ marginTop: 6, marginBottom: 6 }}>
              <label
                style={{
                  fontFamily: 'var(--display)',
                  fontSize: 9,
                  letterSpacing: '0.22em',
                  color: 'var(--ink-2)',
                  fontWeight: 700,
                  display: 'block',
                  marginBottom: 3,
                }}
              >
                LABEL (optional)
              </label>
              <input
                value={trustLabel}
                onChange={e => setTrustLabel(e.target.value)}
                placeholder="e.g. “Community pack · SUNNY Discord”"
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
            <Toolbar>
              <ToolbarButton tone="cyan" onClick={() => void trustAndSave()} disabled={busy}>
                TRUST SIGNER &amp; IMPORT
              </ToolbarButton>
            </Toolbar>
          </WarnBlock>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isImportDoc(v: unknown): v is ImportDoc {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.description === 'string' &&
    typeof o.trigger_text === 'string' &&
    'recipe' in o &&
    (o.signature === undefined || typeof o.signature === 'string') &&
    (o.public_key === undefined || typeof o.public_key === 'string')
  );
}

function WarnBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: '8px 12px',
        border: '1px solid var(--amber)',
        borderLeft: '2px solid var(--amber)',
        background: 'rgba(255, 193, 77, 0.06)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-2)',
      }}
    >
      {children}
    </div>
  );
}

function OkBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: '8px 12px',
        border: '1px solid var(--teal)',
        borderLeft: '2px solid var(--teal)',
        background: 'rgba(0, 210, 180, 0.06)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-2)',
      }}
    >
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  padding: '6px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.3)',
};

const errorStyle: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--red)',
  borderLeft: '2px solid var(--red)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--red)',
  background: 'rgba(255, 77, 94, 0.06)',
};
