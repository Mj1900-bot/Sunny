/**
 * Sprint-12 η — browser-side ed25519 verify path for skill manifests.
 *
 * The Rust side owns the private key and is authoritative for both
 * signing AND verification (see `commands::sign_skill_manifest` /
 * `verify_skill_manifest`).  This module exists so that:
 *
 *   1.  Imports can pre-flight a manifest before firing the Tauri
 *       command — catching obvious tampering without a round-trip.
 *   2.  Unit tests for the import UI can run under vitest without a
 *       live Tauri backend.
 *
 * The canonicalizer here MUST produce the exact same UTF-8 bytes as
 * `identity::canonicalize` in Rust.  We enforce this with a shared
 * contract: sort object keys alphabetically, preserve array order,
 * emit compact JSON (no whitespace).
 *
 * Crypto: `@noble/ed25519` (audited, zero-dep, ships a pure-JS impl —
 * works in the WebView with no wasm round-trip).
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { sha512 } from '@noble/hashes/sha2';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Wire @noble/ed25519's sync SHA-512 to @noble/hashes so `ed.verify` (the
// sync variant) works inside the WebView.  The async variant uses
// `crypto.subtle` by default, but we always go through `verifyAsync`
// below — the sync wiring is here as a defence-in-depth for environments
// (vitest jsdom without WebCrypto) where `subtle` might be absent.
// ---------------------------------------------------------------------------

ed.etc.sha512Sync = (...msgs: Uint8Array[]) => {
  const hash = sha512.create();
  for (const m of msgs) hash.update(m);
  return hash.digest();
};

// ---------------------------------------------------------------------------
// Canonical manifest shape — mirrors the Rust fields.
// ---------------------------------------------------------------------------

/**
 * The object that gets signed.  Deliberately narrow: only the fields the
 * user authored.  Volatile metadata (`id`, `uses_count`, `created_at`,
 * `last_used_at`, etc.) is intentionally excluded so re-saving a skill
 * after a successful run doesn't invalidate its signature.
 */
export type SkillManifest = {
  readonly name: string;
  readonly description: string;
  readonly trigger_text: string;
  readonly recipe: unknown;
};

export type VerifyStatus =
  | { readonly kind: 'valid'; readonly fingerprint: string }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unsigned' };

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Produce the canonical UTF-8 string for a JSON-shaped value. Matches the
 * Rust canonicaliser bit-for-bit:
 *
 *   - Object keys sorted by codepoint (JS default `sort`, which mirrors
 *     Rust's `BTreeMap<String, _>` ordering for ASCII-only keys).
 *   - Arrays preserve input order.
 *   - Compact encoding — no whitespace, no trailing commas.
 *
 * Undefined / function / symbol leaves are not permitted in a manifest
 * (serde_json would reject them on the Rust side), so we don't special-
 * case them here — JSON.stringify will drop them and the signature will
 * fail, which is the correct outcome.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = sortKeys(v);
  return out;
}

// ---------------------------------------------------------------------------
// Fingerprint — SHA-256(pub)[0..8], hex. Matches Rust.
// ---------------------------------------------------------------------------

function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) {
    throw new Error(`hex: odd length ${s.length}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex: non-hex at byte ${i}`);
    out[i] = byte;
  }
  return out;
}

function hexEncode(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export function fingerprintOf(publicKeyHex: string): string {
  const pub = hexDecode(publicKeyHex);
  if (pub.length !== 32) {
    throw new Error(`public key must be 32 bytes, got ${pub.length}`);
  }
  const digest = sha256(pub);
  return hexEncode(digest.slice(0, 8));
}

// ---------------------------------------------------------------------------
// Local verify — pure JS, no backend round-trip.
// ---------------------------------------------------------------------------

/**
 * Verify a manifest / signature / pubkey triple entirely in the browser.
 *
 * Returns:
 *   - `{ kind: 'valid', fingerprint }` on a cryptographic match
 *   - `{ kind: 'invalid', reason }` on any failure (bad hex, wrong
 *     length, forged signature, tampered manifest)
 *
 * Does NOT consult the trust-on-first-use store — that's a separate
 * policy layer. A "valid" result here means "the signer you see is
 * real", not "this signer is trusted".
 */
export async function verifyLocal(
  manifest: SkillManifest,
  signatureHex: string,
  publicKeyHex: string,
): Promise<VerifyStatus> {
  try {
    const sig = hexDecode(signatureHex);
    const pub = hexDecode(publicKeyHex);
    if (sig.length !== 64) return { kind: 'invalid', reason: 'signature must be 64 bytes' };
    if (pub.length !== 32) return { kind: 'invalid', reason: 'public key must be 32 bytes' };
    const canonical = canonicalize(manifest);
    const msg = new TextEncoder().encode(canonical);
    const ok = await ed.verifyAsync(sig, msg, pub);
    if (!ok) return { kind: 'invalid', reason: 'signature does not match manifest' };
    return { kind: 'valid', fingerprint: fingerprintOf(publicKeyHex) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'invalid', reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Tauri bridge — sign / verify / trust commands.
//
// Re-exports of the raw commands live here so UI code never has to
// remember the command names.
// ---------------------------------------------------------------------------

export type SignPayload = {
  readonly signature: string;
  readonly signer_fingerprint: string;
  readonly public_key: string;
};

export async function signManifest(manifest: SkillManifest): Promise<SignPayload | null> {
  return invokeSafe<SignPayload>('sign_skill_manifest', { manifest });
}

export type VerifyOutcome =
  | { readonly status: 'valid'; readonly fingerprint: string }
  | { readonly status: 'invalid'; readonly reason: string };

export async function verifyManifestBackend(
  manifest: SkillManifest,
  signature: string,
  publicKey: string,
): Promise<VerifyOutcome | null> {
  return invokeSafe<VerifyOutcome>('verify_skill_manifest', {
    manifest,
    signature,
    publicKey,
  });
}

export async function isSignerTrusted(fingerprint: string): Promise<boolean> {
  const ok = await invokeSafe<boolean>('identity_is_trusted', { fingerprint });
  return ok === true;
}

export async function trustSigner(
  fingerprint: string,
  publicKey: string,
  label?: string,
): Promise<void> {
  await invokeSafe('identity_trust_signer', {
    fingerprint,
    publicKey,
    label: label ?? null,
  });
}

export type TrustedSigner = {
  readonly label: string;
  readonly added_at: number;
  readonly public_key: string;
};

export type TrustedSignerMap = { readonly signers: Record<string, TrustedSigner> };

export async function listTrustedSigners(): Promise<TrustedSignerMap> {
  const m = await invokeSafe<TrustedSignerMap>('identity_list_trusted');
  return m ?? { signers: {} };
}

export type IdentityPubInfo = {
  readonly public_key: string;
  readonly fingerprint: string;
};

export async function getOwnIdentity(): Promise<IdentityPubInfo | null> {
  return invokeSafe<IdentityPubInfo>('identity_public_key');
}

// ---------------------------------------------------------------------------
// Helpers for the editor / import flows.
// ---------------------------------------------------------------------------

/**
 * Build a manifest from the raw editor fields. Extracted here so every
 * caller signs the exact same shape — if we drift over time, a skill
 * signed in the editor won't verify after a round-trip through import.
 */
export function buildManifest(fields: {
  readonly name: string;
  readonly description: string;
  readonly trigger_text: string;
  readonly recipe: unknown;
}): SkillManifest {
  return {
    name: fields.name,
    description: fields.description,
    trigger_text: fields.trigger_text,
    recipe: fields.recipe,
  };
}
