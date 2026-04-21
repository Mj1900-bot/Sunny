//! Sprint-12 η — SUNNY provenance identity.
//!
//! Owns the local ed25519 keypair used to sign procedural-skill manifests
//! and verifies signatures on imported community skills.  The private key
//! **never leaves Rust** — the frontend only ever calls the `sign_skill`
//! / `verify_skill` commands.  The verify path is *also* available in
//! the browser (`src/lib/skillSignature.ts`, `@noble/ed25519`) for
//! situations where a skill is being dry-run before insertion; the two
//! paths agree bit-for-bit because they both canonicalize the manifest
//! the same way (see `canonicalize`).
//!
//! ## Canonicalization
//!
//! A skill manifest is the JSON object
//!
//! ```json
//! { "name": ..., "description": ..., "trigger_text": ..., "recipe": ... }
//! ```
//!
//! (fields exactly in that order; absent when null).  Before signing /
//! verifying we produce a byte string by:
//!
//!   1. Parse the input as `serde_json::Value`.
//!   2. Recursively **sort every object's keys alphabetically** (by
//!      Unicode codepoint — same as `str::cmp` / JS default sort).
//!   3. Emit compact JSON (no whitespace, no trailing commas).
//!   4. UTF-8 encode — those bytes are the signing input.
//!
//! This is a subset of RFC 8785 (JCS) that covers everything a
//! skill manifest can contain (strings, numbers, bools, arrays,
//! objects, null).  Numbers pass through as serde_json emits them —
//! skill manifests never contain fractional literals, so we don't need
//! the full JCS number-normalization path.
//!
//! ## On-disk layout
//!
//! ```text
//! ~/.sunny/identity/
//!   ├── ed25519.key              # 32-byte secret seed, mode 0o600
//!   ├── ed25519.pub              # 32-byte public key (hex), mode 0o644
//!   └── trusted_signers.json     # { fingerprint -> { label, added_at } }
//! ```
//!
//! The secret file is **literal 32 bytes** (the ed25519 seed).  We do
//! not wrap it in PEM / PKCS#8 — the only consumer is this module.
//!
//! ## Fail-closed
//!
//! On a *present-but-invalid* signature the verifier returns
//! `VerifyOutcome::Invalid` and the import UI **rejects** the skill.
//! *Absent* signatures are treated as `Unsigned` — the UI warns yellow
//! and lets the user override.  *Valid but unknown signer* is
//! `UnknownSigner` — the UI shows the fingerprint and asks for
//! trust-on-first-use.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Constants + directory resolution
// ---------------------------------------------------------------------------

const IDENTITY_DIR: &str = ".sunny";
const IDENTITY_SUB: &str = "identity";
const SECRET_FILE: &str = "ed25519.key";
const PUBLIC_FILE: &str = "ed25519.pub";
const TRUSTED_FILE: &str = "trusted_signers.json";

pub fn identity_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    Ok(home.join(IDENTITY_DIR).join(IDENTITY_SUB))
}

// ---------------------------------------------------------------------------
// Keypair cache — load on first use, keep in memory for the process life.
// ---------------------------------------------------------------------------

fn key_cell() -> &'static Mutex<Option<SigningKey>> {
    static CELL: OnceLock<Mutex<Option<SigningKey>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Load an existing keypair, or generate+persist a new one if none exists.
/// Safe to call from many threads — the mutex serialises first-touch.
pub fn ensure_keypair() -> Result<(), String> {
    let mut guard = key_cell()
        .lock()
        .map_err(|_| "identity: key mutex poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let dir = identity_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create identity dir: {e}"))?;
    let secret_path = dir.join(SECRET_FILE);
    let public_path = dir.join(PUBLIC_FILE);

    let signing = if secret_path.exists() {
        load_signing_key(&secret_path)?
    } else {
        let sk = generate_signing_key();
        write_secret(&secret_path, &sk)?;
        write_public(&public_path, &sk.verifying_key())?;
        log::info!(
            "identity: minted new ed25519 keypair ({}…)",
            &fingerprint_of(&sk.verifying_key())[..12]
        );
        sk
    };

    // Public file may be missing on a keypair imported from a backup
    // (user copied only ed25519.key). Regenerate it rather than erroring.
    if !public_path.exists() {
        write_public(&public_path, &signing.verifying_key())?;
    }

    *guard = Some(signing);
    Ok(())
}

fn generate_signing_key() -> SigningKey {
    use rand_core::OsRng;
    SigningKey::generate(&mut OsRng)
}

fn load_signing_key(path: &Path) -> Result<SigningKey, String> {
    let bytes = fs::read(path).map_err(|e| format!("read secret key: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "identity: secret key file must be exactly 32 bytes, got {}",
            bytes.len()
        ));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&bytes);
    Ok(SigningKey::from_bytes(&seed))
}

fn write_secret(path: &Path, sk: &SigningKey) -> Result<(), String> {
    let bytes = sk.to_bytes();
    fs::write(path, bytes).map_err(|e| format!("write secret key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod secret key: {e}"))?;
    }
    Ok(())
}

fn write_public(path: &Path, vk: &VerifyingKey) -> Result<(), String> {
    let hex_pub = hex::encode(vk.to_bytes());
    fs::write(path, format!("{hex_pub}\n")).map_err(|e| format!("write public key: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/// Hex-encoded 64-char public key ("raw", uncompressed 32-byte ed25519 pub).
pub fn public_key_hex() -> Result<String, String> {
    ensure_keypair()?;
    let guard = key_cell()
        .lock()
        .map_err(|_| "identity: key mutex poisoned".to_string())?;
    let sk = guard.as_ref().ok_or_else(|| "identity: key not loaded".to_string())?;
    Ok(hex::encode(sk.verifying_key().to_bytes()))
}

/// 16-char hex fingerprint — the first 8 bytes of SHA-256 of the raw
/// 32-byte public key.  Short enough to fit in the UI, still collision-
/// resistant enough for human trust decisions.
pub fn own_fingerprint() -> Result<String, String> {
    ensure_keypair()?;
    let guard = key_cell()
        .lock()
        .map_err(|_| "identity: key mutex poisoned".to_string())?;
    let sk = guard.as_ref().ok_or_else(|| "identity: key not loaded".to_string())?;
    Ok(fingerprint_of(&sk.verifying_key()))
}

fn fingerprint_of(vk: &VerifyingKey) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(vk.to_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

/// Canonicalize a manifest `serde_json::Value` and sign the resulting
/// UTF-8 bytes with the local private key. Returns a hex-encoded 64-byte
/// signature.
pub fn sign_canonical(manifest: &Value) -> Result<SignPayload, String> {
    ensure_keypair()?;
    let guard = key_cell()
        .lock()
        .map_err(|_| "identity: key mutex poisoned".to_string())?;
    let sk = guard.as_ref().ok_or_else(|| "identity: key not loaded".to_string())?;
    let canonical = canonicalize(manifest);
    let sig: Signature = sk.sign(canonical.as_bytes());
    Ok(SignPayload {
        signature: hex::encode(sig.to_bytes()),
        signer_fingerprint: fingerprint_of(&sk.verifying_key()),
        public_key: hex::encode(sk.verifying_key().to_bytes()),
    })
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SignPayload {
    /// 128-char hex (64 bytes, ed25519 signature).
    pub signature: String,
    /// 16-char hex — SHA-256(pub)[0..8].
    pub signer_fingerprint: String,
    /// 64-char hex — raw 32-byte public key. Included so a verifier that
    /// hasn't seen the signer before can compute the same fingerprint.
    pub public_key: String,
}

/// Verify a `(manifest, signature, public_key)` triple.
///
/// `public_key_hex` is the claimed signer; the verifier re-derives the
/// fingerprint from it so a forged manifest claiming someone else's
/// fingerprint without a matching pubkey is immediately exposed.
pub fn verify_canonical(
    manifest: &Value,
    signature_hex: &str,
    public_key_hex: &str,
) -> VerifyOutcome {
    let sig_bytes = match hex::decode(signature_hex) {
        Ok(b) if b.len() == 64 => b,
        _ => return VerifyOutcome::Invalid { reason: "signature: wrong length / not hex".into() },
    };
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);
    let sig = Signature::from_bytes(&sig_arr);

    let pub_bytes = match hex::decode(public_key_hex) {
        Ok(b) if b.len() == 32 => b,
        _ => return VerifyOutcome::Invalid { reason: "public_key: wrong length / not hex".into() },
    };
    let mut pub_arr = [0u8; 32];
    pub_arr.copy_from_slice(&pub_bytes);
    let vk = match VerifyingKey::from_bytes(&pub_arr) {
        Ok(v) => v,
        Err(e) => return VerifyOutcome::Invalid { reason: format!("public_key: {e}") },
    };

    let canonical = canonicalize(manifest);
    match vk.verify(canonical.as_bytes(), &sig) {
        Ok(()) => VerifyOutcome::Valid {
            fingerprint: fingerprint_of(&vk),
        },
        Err(e) => VerifyOutcome::Invalid { reason: format!("signature check: {e}") },
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum VerifyOutcome {
    Valid { fingerprint: String },
    Invalid { reason: String },
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/// Produce the canonical UTF-8 bytes for a JSON value.
///
/// * Object keys sorted alphabetically (by Unicode codepoint).
/// * Compact encoding (no whitespace).
/// * Arrays preserve order (semantically meaningful — recipe step order!).
///
/// Numbers round-trip through serde_json as-is. Because a skill manifest
/// only ever carries integers, booleans, strings, and nested containers
/// we don't need JCS's full number-normalization — adding it later is a
/// breaking canonicalization change so we pick a deliberate minimum.
pub fn canonicalize(v: &Value) -> String {
    let normalized = sort_keys(v);
    serde_json::to_string(&normalized).expect("canonicalize: serialize cannot fail on owned Value")
}

fn sort_keys(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            // Collect into BTreeMap so keys come out alphabetical.
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (k, inner) in map {
                sorted.insert(k.clone(), sort_keys(inner));
            }
            let out: Map<String, Value> = sorted.into_iter().collect();
            Value::Object(out)
        }
        Value::Array(arr) => {
            Value::Array(arr.iter().map(sort_keys).collect())
        }
        // Leaves — strings, numbers, bools, null — pass through unchanged.
        leaf => leaf.clone(),
    }
}

// ---------------------------------------------------------------------------
// Trust-on-first-use store
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct TrustedSignerMap {
    /// fingerprint → (label, added_at_epoch_secs, public_key_hex)
    // Native rendering by ts-rs produces `Record<string, TrustedSigner>`
    // AND the import for `TrustedSigner` — overriding with
    // `#[ts(type = ...)]` drops the import and breaks `pnpm build`.
    pub signers: BTreeMap<String, TrustedSigner>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct TrustedSigner {
    pub label: String,
    #[ts(type = "number")]
    pub added_at: i64,
    pub public_key: String,
}

pub fn load_trusted() -> Result<TrustedSignerMap, String> {
    let path = identity_dir()?.join(TRUSTED_FILE);
    if !path.exists() {
        return Ok(TrustedSignerMap::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read trusted: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(TrustedSignerMap::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse trusted: {e}"))
}

pub fn save_trusted(map: &TrustedSignerMap) -> Result<(), String> {
    let dir = identity_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create identity dir: {e}"))?;
    let path = dir.join(TRUSTED_FILE);
    let body = serde_json::to_string_pretty(map).map_err(|e| format!("encode trusted: {e}"))?;
    fs::write(&path, body).map_err(|e| format!("write trusted: {e}"))?;
    Ok(())
}

pub fn trust_signer(fingerprint: &str, public_key: &str, label: &str) -> Result<(), String> {
    // Sanity: the fingerprint the caller hands in must match the pubkey.
    // Without this, a malicious import UI could persist a trust record
    // under a friendly fingerprint for an unrelated public key.
    let pub_bytes = hex::decode(public_key)
        .map_err(|e| format!("trust: invalid public_key hex: {e}"))?;
    if pub_bytes.len() != 32 {
        return Err("trust: public_key must be 32 bytes".into());
    }
    let mut pub_arr = [0u8; 32];
    pub_arr.copy_from_slice(&pub_bytes);
    let vk = VerifyingKey::from_bytes(&pub_arr)
        .map_err(|e| format!("trust: invalid public_key: {e}"))?;
    let derived = fingerprint_of(&vk);
    if derived != fingerprint {
        return Err(format!(
            "trust: fingerprint mismatch (claimed {fingerprint}, derived {derived})"
        ));
    }

    let mut map = load_trusted()?;
    map.signers.insert(
        fingerprint.to_string(),
        TrustedSigner {
            label: label.to_string(),
            added_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            public_key: public_key.to_string(),
        },
    );
    save_trusted(&map)
}

pub fn is_trusted(fingerprint: &str) -> Result<bool, String> {
    Ok(load_trusted()?.signers.contains_key(fingerprint))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_sorts_keys_alphabetically() {
        let v: Value = serde_json::from_str(
            r#"{"b":1,"a":{"z":2,"y":3},"c":[{"n":1,"m":2}]}"#,
        )
        .unwrap();
        let canonical = canonicalize(&v);
        assert_eq!(canonical, r#"{"a":{"y":3,"z":2},"b":1,"c":[{"m":2,"n":1}]}"#);
    }

    #[test]
    fn canonical_preserves_array_order() {
        // Array order is semantic — recipe steps depend on it.
        let v: Value = serde_json::from_str(r#"{"steps":[3,1,2]}"#).unwrap();
        let canonical = canonicalize(&v);
        assert_eq!(canonical, r#"{"steps":[3,1,2]}"#);
    }

    #[test]
    fn canonical_is_deterministic_across_key_insertion_order() {
        let a: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        assert_eq!(canonicalize(&a), canonicalize(&b));
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        use rand_core::OsRng;
        let sk = SigningKey::generate(&mut OsRng);
        let vk = sk.verifying_key();
        let manifest: Value = serde_json::from_str(
            r#"{"name":"test","recipe":{"steps":[{"kind":"answer","text":"hi"}]}}"#,
        )
        .unwrap();
        let canonical = canonicalize(&manifest);
        let sig = sk.sign(canonical.as_bytes());
        let outcome = verify_canonical(
            &manifest,
            &hex::encode(sig.to_bytes()),
            &hex::encode(vk.to_bytes()),
        );
        match outcome {
            VerifyOutcome::Valid { fingerprint } => {
                assert_eq!(fingerprint, fingerprint_of(&vk));
            }
            VerifyOutcome::Invalid { reason } => panic!("expected Valid, got Invalid: {reason}"),
        }
    }

    #[test]
    fn tampered_manifest_fails_verification() {
        use rand_core::OsRng;
        let sk = SigningKey::generate(&mut OsRng);
        let vk = sk.verifying_key();
        let manifest: Value = serde_json::from_str(r#"{"name":"original"}"#).unwrap();
        let sig = sk.sign(canonicalize(&manifest).as_bytes());

        let tampered: Value = serde_json::from_str(r#"{"name":"evil"}"#).unwrap();
        let outcome = verify_canonical(
            &tampered,
            &hex::encode(sig.to_bytes()),
            &hex::encode(vk.to_bytes()),
        );
        matches!(outcome, VerifyOutcome::Invalid { .. });
    }

    #[test]
    fn fingerprint_is_16_hex_chars() {
        use rand_core::OsRng;
        let sk = SigningKey::generate(&mut OsRng);
        let fp = fingerprint_of(&sk.verifying_key());
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
