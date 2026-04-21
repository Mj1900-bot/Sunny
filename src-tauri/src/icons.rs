//! App icon extraction for macOS .app bundles.
//!
//! Pipeline:
//!   1. Parse `<app>/Contents/Info.plist` via `/usr/libexec/PlistBuddy` to find
//!      the `CFBundleIconFile` entry.
//!   2. Resolve it to `<app>/Contents/Resources/<icon>.icns`
//!      (the key may or may not already include the extension).
//!   3. Convert the .icns to PNG at the requested size using `sips`, which
//!      ships with macOS and has no extra cost:
//!        `sips -s format png -z <size> <size> <icns> --out <tmp.png>`
//!   4. Read the PNG bytes, base64-encode them, delete the temp file.
//!
//! If any step fails (missing plist, icon not shipped with the app, sips
//! errors) we fall back to the system generic application icon so the UI
//! always has something to render.
//!
//! A `Mutex<HashMap>` cache keyed on `"{path}::{size}"` keeps repeat calls
//! for the same tile effectively free (~0ms) while the first conversion
//! takes roughly 40–60ms on an M-series Mac.

use base64::Engine;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::process::Command;

const PLIST_BUDDY: &str = "/usr/libexec/PlistBuddy";
const SIPS_BIN: &str = "/usr/bin/sips";
const GENERIC_ICNS: &str =
    "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericApplicationIcon.icns";

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(app_path: &str, size: u32) -> String {
    format!("{}::{}", app_path, size)
}

fn cache_get(key: &str) -> Option<String> {
    cache().lock().ok().and_then(|g| g.get(key).cloned())
}

fn cache_put(key: String, value: String) {
    if let Ok(mut g) = cache().lock() {
        g.insert(key, value);
    }
}

/// Clamp requested icon size to sensible bounds (sips refuses zero/huge).
fn clamp_size(size: u32) -> u32 {
    size.clamp(16, 1024)
}

/// Run `PlistBuddy -c "Print :CFBundleIconFile"` on the Info.plist and return
/// the trimmed value, or None on failure / empty output.
async fn read_icon_name(app_path: &str) -> Option<String> {
    let plist = PathBuf::from(app_path).join("Contents").join("Info.plist");
    if !plist.exists() {
        return None;
    }
    let out = Command::new(PLIST_BUDDY)
        .arg("-c")
        .arg("Print :CFBundleIconFile")
        .arg(&plist)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Resolve the .icns file for an .app bundle. Handles:
///   - icon name already ending in .icns
///   - icon name without extension
///   - fallback to conventional `AppIcon.icns` if plist lookup fails
fn resolve_icns(app_path: &str, icon_name: Option<&str>) -> Option<PathBuf> {
    let resources = PathBuf::from(app_path).join("Contents").join("Resources");
    if let Some(name) = icon_name {
        let direct = resources.join(name);
        if direct.exists() {
            return Some(direct);
        }
        let with_ext = resources.join(format!("{}.icns", name));
        if with_ext.exists() {
            return Some(with_ext);
        }
    }
    // Common fallback: AppIcon.icns
    let fallback = resources.join("AppIcon.icns");
    if fallback.exists() {
        return Some(fallback);
    }
    None
}

/// Convert an .icns file to a PNG at the requested size using sips, returning
/// the base64-encoded bytes. Writes to a unique temp file and deletes it.
async fn icns_to_png_base64(icns: &Path, size: u32) -> Result<String, String> {
    let size = clamp_size(size);
    let tmp_dir = std::env::temp_dir();
    let unique = format!(
        "sunny-icon-{}-{}.png",
        size,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp = tmp_dir.join(unique);

    let out = Command::new(SIPS_BIN)
        .arg("-s")
        .arg("format")
        .arg("png")
        .arg("-z")
        .arg(size.to_string())
        .arg(size.to_string())
        .arg(icns)
        .arg("--out")
        .arg(&tmp)
        .output()
        .await
        .map_err(|e| format!("sips spawn failed: {}", e))?;

    if !out.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "sips failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let bytes = tokio::fs::read(&tmp)
        .await
        .map_err(|e| format!("read tmp png failed: {}", e))?;
    let _ = tokio::fs::remove_file(&tmp).await;

    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Try to extract the real app icon; fall back to the generic one.
pub async fn app_icon_png(app_path: String, size: u32) -> Result<String, String> {
    let size = clamp_size(size);
    let key = cache_key(&app_path, size);
    if let Some(hit) = cache_get(&key) {
        return Ok(hit);
    }

    // Primary: read plist, resolve icon, convert.
    let icon_name = read_icon_name(&app_path).await;
    let resolved = resolve_icns(&app_path, icon_name.as_deref());

    let result = match resolved {
        Some(icns) => icns_to_png_base64(&icns, size).await,
        None => Err("no icns found".to_string()),
    };

    let b64 = match result {
        Ok(v) => v,
        Err(_) => {
            // Fallback: generic app icon.
            let generic = Path::new(GENERIC_ICNS);
            if !generic.exists() {
                return Err("no icon and no generic fallback available".to_string());
            }
            icns_to_png_base64(generic, size).await?
        }
    };

    cache_put(key, b64.clone());
    Ok(b64)
}

// ---------------- Tests ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_sanity() {
        let raw: &[u8] = b"SUNNY-ICON-TEST";
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .expect("decode roundtrip");
        assert_eq!(decoded, raw);
    }

    #[tokio::test]
    async fn cache_roundtrip_for_known_system_app() {
        // Finder ships on every macOS install, so this path is stable in CI
        // and on dev machines. If the binary is missing we skip — the test
        // should not fail CI on non-macOS runners.
        let path = "/System/Library/CoreServices/Finder.app".to_string();
        if !Path::new(&path).exists() || !Path::new(SIPS_BIN).exists() {
            return;
        }

        let key = cache_key(&path, 64);
        // Ensure clean slate for determinism.
        if let Ok(mut g) = cache().lock() {
            g.remove(&key);
        }

        let first = app_icon_png(path.clone(), 64)
            .await
            .expect("first extraction");
        assert!(!first.is_empty(), "expected non-empty base64");

        // Second call must be served from cache (same bytes, same key).
        let second = app_icon_png(path.clone(), 64)
            .await
            .expect("cached extraction");
        assert_eq!(first, second, "cache must return identical payload");

        assert!(
            cache_get(&key).is_some(),
            "cache should contain the key after extraction"
        );
    }
}

// === REGISTER IN lib.rs ===
// mod icons;
// #[tauri::command] async fn app_icon_png(app_path: String, size: u32) -> Result<String, String> { icons::app_icon_png(app_path, size).await }
// Add to invoke_handler: app_icon_png
// No new Cargo deps (base64 already added in round 2).
// === END REGISTER ===
