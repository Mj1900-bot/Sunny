/**
 * Sprint-13 η — EXPORT counterpart to sprint-12 η's skill signing + TOFU
 * import.  The importer accepts `{manifest, signature, public_key}`; this
 * module emits a richer superset so future SUNNY versions (and future
 * tooling — marketplace, share-sheet, URL handoff) can distinguish a
 * v1 SUNNY skill bundle from an arbitrary JSON blob that happens to look
 * similar.
 *
 *   Export schema — `sunny.skill.v1`
 *   ------------------------------
 *   {
 *     "schema":              "sunny.skill.v1",
 *     "manifest":            { name, description, trigger_text, recipe },
 *     "signature":           "<128-hex>",   // ed25519 over canonical(manifest)
 *     "signer_fingerprint":  "<16-hex>",    // sha256(pubkey)[0..8]
 *     "public_key":          "<64-hex>",    // raw 32-byte ed25519 pubkey
 *     "signed_at":           <unix_ms>      // when the exporter packaged it
 *   }
 *
 * The importer in sprint-12 η only reads `name / description / trigger_text
 * / recipe / signature? / public_key?` off the TOP LEVEL.  Our bundle puts
 * the first four under a `manifest` sub-object, so we SPLAT them back up
 * on write for backwards compatibility — the old importer sees the flat
 * shape, the new importer sees the wrapped one.  This is the migration
 * rule in action: new fields ignored by old code, old fields preserved
 * by new code.
 *
 * NB: this module is a READ-ONLY consumer of `skillSignature.ts`.  It
 * MUST NOT re-sign or re-canonicalise — if the signature stored against
 * a skill came from the editor, we ship it verbatim.  Any discrepancy
 * between our canonicalisation and the signer's would invalidate the
 * bundle on the receiving side.
 */

import { buildManifest, type SkillManifest } from './skillSignature';
import type { ProceduralSkill } from '../pages/SkillsPage/api';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const EXPORT_SCHEMA = 'sunny.skill.v1' as const;

/** The wire-format bundle a user pastes / saves / shares. */
export type SkillBundle = {
  readonly schema: typeof EXPORT_SCHEMA;
  readonly manifest: SkillManifest;
  readonly signature: string;
  readonly signer_fingerprint: string;
  readonly public_key: string;
  readonly signed_at: number;
  // Legacy-compatible fields — splatted so an older importer (sprint-12 η)
  // that reads `{name, description, trigger_text, recipe, signature,
  // public_key}` off the top level still works.  New top-level keys
  // (`schema`, `signer_fingerprint`, `signed_at`) are ignored by that
  // importer thanks to its `isImportDoc` guard tolerating extras.
  readonly name: string;
  readonly description: string;
  readonly trigger_text: string;
  readonly recipe: unknown;
};

/** Why we refused to export a particular skill. */
export type SkillExportRefusal =
  | { readonly kind: 'unsigned'; readonly skillName: string }
  | { readonly kind: 'missing_pubkey'; readonly skillName: string; readonly fingerprint: string };

// ---------------------------------------------------------------------------
// Public-key resolver
// ---------------------------------------------------------------------------

/**
 * The skill row only stores `signature` + `signer_fingerprint`.  To ship
 * a full bundle we need the 32-byte public key.  Sources, in order:
 *
 *   1. The trust store (`identity_list_trusted`) — any signer the user
 *      has imported from in the past is keyed by fingerprint.
 *   2. The user's own identity (`identity_public_key`) — self-signed
 *      skills (the common case) match here.
 *
 * Returns `null` if neither source has the pubkey.  Caller treats that
 * as a hard refusal — we refuse to export a signed manifest without the
 * pubkey rather than strip the signature (which would silently turn a
 * signed export into an unsigned one).
 */
export function resolvePublicKey(
  fingerprint: string,
  ownFingerprint: string | null,
  ownPublicKey: string | null,
  trusted: Readonly<Record<string, { readonly public_key: string }>>,
): string | null {
  const fromTrust = trusted[fingerprint];
  if (fromTrust) return fromTrust.public_key;
  if (ownFingerprint && ownFingerprint === fingerprint && ownPublicKey) {
    return ownPublicKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundle builder
// ---------------------------------------------------------------------------

/**
 * Build an export bundle from a skill row.  Returns `null` + a refusal
 * reason if the skill is unsigned or we can't locate the pubkey.
 *
 * The `now` injection is deliberate — keeps the function pure so unit
 * tests can assert byte-for-byte equality without freezing the clock.
 */
export function buildSkillBundle(
  skill: ProceduralSkill,
  publicKey: string | null,
  now: number = Date.now(),
): { readonly bundle: SkillBundle | null; readonly refusal: SkillExportRefusal | null } {
  if (!skill.signature || !skill.signer_fingerprint) {
    return {
      bundle: null,
      refusal: { kind: 'unsigned', skillName: skill.name },
    };
  }
  if (!publicKey) {
    return {
      bundle: null,
      refusal: {
        kind: 'missing_pubkey',
        skillName: skill.name,
        fingerprint: skill.signer_fingerprint,
      },
    };
  }
  const manifest = buildManifest({
    name: skill.name,
    description: skill.description,
    trigger_text: skill.trigger_text,
    recipe: skill.recipe,
  });
  const bundle: SkillBundle = {
    schema: EXPORT_SCHEMA,
    manifest,
    signature: skill.signature,
    signer_fingerprint: skill.signer_fingerprint,
    public_key: publicKey,
    signed_at: now,
    // Legacy splat for the sprint-12 η importer.
    name: manifest.name,
    description: manifest.description,
    trigger_text: manifest.trigger_text,
    recipe: manifest.recipe,
  };
  return { bundle, refusal: null };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Pretty-print a bundle for clipboard / file I/O.  We use 2-space
 * indentation so a human pasting it into a code review or Discord
 * channel gets readable JSON — the canonical form matters for the
 * signature, not for the wrapper.
 */
export function serializeBundle(bundle: SkillBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** Serialise an array of bundles.  Matches the bulk-import expectation: a
 *  top-level JSON array of the same per-skill shape. */
export function serializeBundleArray(bundles: ReadonlyArray<SkillBundle>): string {
  return JSON.stringify(bundles, null, 2);
}

// ---------------------------------------------------------------------------
// Filename suggestions
// ---------------------------------------------------------------------------

/**
 * Produce a shell-safe filename stem for a skill.  Keeps ASCII letters,
 * digits, dash, underscore; collapses everything else to a single dash.
 * Truncates to 48 chars so the pathname doesn't balloon on overly long
 * skill names.
 */
export function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'skill';
}

/** Default filename for a single-skill export. */
export function suggestedFilename(bundle: SkillBundle): string {
  const slug = slugifySkillName(bundle.manifest.name);
  const fp = bundle.signer_fingerprint.slice(0, 8);
  return `sunny-skill-${slug}-${fp}.json`;
}

/** Default filename for a bulk export. */
export function suggestedBulkFilename(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `sunny-skills-${yyyy}${mm}${dd}.json`;
}

// ---------------------------------------------------------------------------
// Fingerprint shortening
// ---------------------------------------------------------------------------

/** The 8-char digest shown in toasts and card previews. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}
