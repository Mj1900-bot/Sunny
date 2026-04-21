//! Identity, skill signing/verification, and skill export commands.
//!
//! Sprint-12 η — ed25519 provenance for procedural skills.
//!
//! The private key lives under `~/.sunny/identity/ed25519.key` and never
//! leaves the Rust process.  These commands expose the minimum surface the
//! SkillEditor / SkillImport need:
//!
//!   * `identity_public_key`         → hex pubkey + fingerprint for sharing
//!   * `sign_skill_manifest`         → produce a signature over {name,
//!                                      description, trigger_text, recipe}
//!   * `verify_skill_manifest`       → { status: "valid" | "invalid", … }
//!   * `identity_trust_signer`       → persist trust-on-first-use decision
//!   * `identity_is_trusted`         → "does the UI need to prompt?"
//!   * `identity_list_trusted`       → show the user what they've trusted
//!
//! `sign_skill_manifest` deliberately takes the manifest as a
//! `serde_json::Value` so callers can't accidentally sign a re-serialised
//! version that differs from the canonical form (the canonicaliser runs
//! in Rust).

use crate::identity;

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct IdentityPubInfo {
    pub public_key: String,
    pub fingerprint: String,
}

#[tauri::command]
pub fn identity_public_key() -> Result<IdentityPubInfo, String> {
    Ok(IdentityPubInfo {
        public_key: identity::public_key_hex()?,
        fingerprint: identity::own_fingerprint()?,
    })
}

#[tauri::command]
pub fn sign_skill_manifest(manifest: serde_json::Value) -> Result<identity::SignPayload, String> {
    identity::sign_canonical(&manifest)
}

#[tauri::command]
pub fn verify_skill_manifest(
    manifest: serde_json::Value,
    signature: String,
    public_key: String,
) -> Result<identity::VerifyOutcome, String> {
    Ok(identity::verify_canonical(&manifest, &signature, &public_key))
}

#[tauri::command]
pub fn identity_trust_signer(
    fingerprint: String,
    public_key: String,
    label: Option<String>,
) -> Result<(), String> {
    identity::trust_signer(
        &fingerprint,
        &public_key,
        &label.unwrap_or_else(|| format!("signer-{}", &fingerprint[..8.min(fingerprint.len())])),
    )
}

#[tauri::command]
pub fn identity_is_trusted(fingerprint: String) -> Result<bool, String> {
    identity::is_trusted(&fingerprint)
}

#[tauri::command]
pub fn identity_list_trusted() -> Result<identity::TrustedSignerMap, String> {
    identity::load_trusted()
}

// ---------------------------------------------------------------------------
// Sprint-13 η — skill export to disk.
//
// The browser-side `SkillExport.tsx` modal builds the signed bundle
// JSON in-process (read-only; never re-signs).  When the user picks
// "SAVE TO FILE" we want a real native save-dialog — not the web's
// `<a download>` which has no default directory and no overwrite
// protection.  `rfd::FileDialog` pops NSSavePanel on macOS and the
// platform-native equivalent elsewhere.
//
// Contract:
//   * `json` — the already-serialised bundle (or array of bundles for
//              bulk export).  We DO NOT deserialise / re-serialise it
//              here — that would invalidate the signature by changing
//              the canonical form.
//   * `suggested_name` — hint for the dialog; the user is free to
//                        rename.  We write whatever path the dialog
//                        returns.
//
// Return:
//   * `Ok(Some(path))` when a file was written.
//   * `Ok(None)` when the user cancelled the dialog.
//   * `Err(msg)` on filesystem failure (the caller surfaces this as a
//                red banner; cancellation is NOT an error).
// ---------------------------------------------------------------------------

fn default_downloads_dir() -> std::path::PathBuf {
    // `dirs::download_dir` is platform-aware (Finder's "Downloads" on macOS,
    // `XDG_DOWNLOAD_DIR` on Linux).  Falling back to the home dir if it's
    // somehow absent keeps the dialog from blowing up in exotic sandboxes.
    dirs::download_dir().unwrap_or_else(|| {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
    })
}

#[tauri::command]
pub async fn skill_export_save(
    json: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let start_dir = default_downloads_dir();
    // Run the blocking native-dialog call on a worker thread so the
    // async reactor isn't blocked while the user deliberates.
    let chosen: Option<std::path::PathBuf> = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Save signed skill bundle")
            .set_file_name(&suggested_name)
            .set_directory(&start_dir)
            .add_filter("SUNNY skill bundle", &["json"])
            .save_file()
    })
    .await
    .map_err(|e| format!("skill_export_save: dialog task failed: {e}"))?;

    let Some(path) = chosen else { return Ok(None) };
    std::fs::write(&path, json.as_bytes())
        .map_err(|e| format!("skill_export_save: write {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn skill_export_save_bulk(
    json: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    // Same flow as single-skill export; kept as a distinct command so the
    // dialog title reflects the user's intent.  (rfd's title is the only
    // UX hint a sighted user gets in the save panel's sheet.)
    let start_dir = default_downloads_dir();
    let chosen: Option<std::path::PathBuf> = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Export all signed skills")
            .set_file_name(&suggested_name)
            .set_directory(&start_dir)
            .add_filter("SUNNY skill bundle (array)", &["json"])
            .save_file()
    })
    .await
    .map_err(|e| format!("skill_export_save_bulk: dialog task failed: {e}"))?;

    let Some(path) = chosen else { return Ok(None) };
    std::fs::write(&path, json.as_bytes())
        .map_err(|e| format!("skill_export_save_bulk: write {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
