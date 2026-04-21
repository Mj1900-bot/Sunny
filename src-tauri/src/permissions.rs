//! Non-intrusive macOS TCC permission probes.
//!
//! Canonical, no-prompt checks for the two TCC gates the Screen module cares
//! about. Both go through public C APIs that never display a system prompt
//! and never perform a real capture / event synthesis — so they're safe to
//! call on mount to populate a diagnostics panel.
//!
//!   * `CGPreflightScreenCaptureAccess()` — Screen Recording.
//!     Available since macOS 10.15; returns `true` iff the current process is
//!     listed in `/Library/Application Support/com.apple.TCC/TCC.db` under
//!     `kTCCServiceScreenCapture` with `auth_value == allowed`. The matching
//!     `CGRequestScreenCaptureAccess()` *does* prompt; we don't expose it here.
//!
//!   * `AXIsProcessTrusted()` — Accessibility.
//!     Part of ApplicationServices since 10.9; returns `true` iff the process
//!     is listed under `kTCCServiceAccessibility`. The variant
//!     `AXIsProcessTrustedWithOptions` can prompt; we intentionally use the
//!     silent form.
//!
//! Non-macOS builds get stubs that always return `false` so the Tauri command
//! still resolves cleanly on Linux / Windows CI.
//!
//! ### Why FFI instead of more screencapture probing?
//! Relying on a real capture to decide the permission has two failure modes:
//!   1. `screencapture -R x,y,w,h` can fail with "could not create image from
//!      rect" for benign reasons (region touching a protected area, too small
//!      on Retina, etc.), and that looks indistinguishable from a TCC denial.
//!   2. Every probe produces an actual frame, which is wasteful if we only
//!      need a yes/no answer.
//! CGPreflightScreenCaptureAccess returns the authoritative TCC answer
//! directly from `tccd` with none of that noise.

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// `true` iff the current process is authorised for Screen Recording.
/// Never prompts.
#[cfg(target_os = "macos")]
pub fn has_screen_recording() -> bool {
    // SAFETY: CGPreflightScreenCaptureAccess takes no arguments, has no
    // side effects beyond an XPC round-trip to `tccd`, and returns a
    // plain `bool`. Callable from any thread.
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn has_screen_recording() -> bool {
    false
}

/// `true` iff the current process is authorised for Accessibility. Never
/// prompts (that's `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})`).
#[cfg(target_os = "macos")]
pub fn has_accessibility() -> bool {
    // SAFETY: AXIsProcessTrusted takes no arguments, is documented to be
    // callable from any thread, and returns a `Boolean` (ABI-compatible
    // with Rust's `bool` on macOS).
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
pub fn has_accessibility() -> bool {
    false
}

/// `true` iff the current process can read `~/Library/Messages/chat.db`.
///
/// There is no public no-prompt FFI for Full Disk Access, but `chat.db` is the
/// canonical FDA-gated file on every supported macOS version: if we can open
/// it for read, the current signed binary holds `kTCCServiceSystemPolicyAllFiles`.
/// If the file is missing (fresh Mac / Messages never launched) we fall back
/// to the AddressBook image, which is also FDA-gated.
///
/// Never prompts. Safe to call on mount.
#[cfg(target_os = "macos")]
pub fn has_full_disk_access() -> bool {
    use std::fs::File;

    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let candidates = [
        home.join("Library/Messages/chat.db"),
        home.join("Library/Application Support/AddressBook/AddressBook-v22.abcddb"),
    ];
    for path in candidates.iter() {
        if !path.exists() {
            continue;
        }
        // `File::open` on an FDA-gated file without the grant yields
        // `PermissionDenied`. A successful open is proof of access.
        if File::open(path).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
pub fn has_full_disk_access() -> bool {
    false
}

// ----------------------------------------------------------------------------
// Automation probe (`osascript` + System Events)
// ----------------------------------------------------------------------------
//
// There is no public FFI equivalent to CGPreflight for Automation: macOS
// only exposes per-target authorisation state to `AEDeterminePermissionToAu-
// tomateTarget`, which itself prompts. Running a trivial `System Events`
// AppleScript is the de-facto check. We use a dedicated, generous 10 s
// timeout (vs. the 3 s general timeout in `ax.rs`) so a slow or first-run
// System Events daemon isn't misreported as "denied".

#[cfg(target_os = "macos")]
pub async fn check_automation_system_events() -> Result<bool, String> {
    use std::time::Duration;
    use tokio::process::Command;
    use tokio::time::timeout;

    let script = r#"tell application "System Events" to return "ok""#;
    let fat = crate::paths::fat_path().unwrap_or_default();

    let fut = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .env("PATH", fat)
        .output();

    let out = match timeout(Duration::from_secs(10), fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript spawn failed: {e}")),
        Err(_) => return Err("osascript probe timed out after 10s".into()),
    };

    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if stdout == "ok" {
            return Ok(true);
        }
        return Err(format!("unexpected osascript response: {stdout}"));
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let lower = stderr.to_lowercase();
    if lower.contains("not authorized") || lower.contains("-1743") || lower.contains("automation") {
        return Ok(false);
    }
    Err(format!("osascript error: {stderr}"))
}

#[cfg(not(target_os = "macos"))]
pub async fn check_automation_system_events() -> Result<bool, String> {
    Ok(false)
}

// ----------------------------------------------------------------------------
// TCC reset
// ----------------------------------------------------------------------------
//
// Every ad-hoc-signed rebuild of Sunny gets a fresh code signature, and macOS
// TCC keys its grants off the signature (not just the bundle id). The
// practical consequence: "Sunny" still appears in the Privacy & Security
// list, but the new binary is treated as an impostor and the old grant
// doesn't apply. `tccutil reset <service> <bundle_id>` clears Sunny's row
// for a given service so the system will re-prompt fresh on the next call,
// picking up the current signature.

/// Services cleared by [`reset_tcc_for`]. Includes `SystemPolicyAllFiles` so a
/// stale Full Disk Access row (e.g. after a rebuild changes the code signature)
/// is wiped — otherwise Settings can show the toggle ON while `chat.db` reads
/// still fail.
#[cfg(target_os = "macos")]
const TCC_SERVICES: &[&str] = &[
    "ScreenCapture",
    "Accessibility",
    "AppleEvents",
    "SystemPolicyAllFiles",
];

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export)]
pub struct TccResetResult {
    pub bundle_id: String,
    pub ok: Vec<String>,
    pub failed: Vec<String>,
}

#[cfg(target_os = "macos")]
pub async fn reset_tcc_for(bundle_id: String) -> Result<TccResetResult, String> {
    use tokio::process::Command;

    if bundle_id.trim().is_empty() {
        return Err("bundle_id must be non-empty".into());
    }
    // Paranoid guard: tccutil takes a bundle id, not a path, so reject
    // anything that contains a slash or a space to avoid surprises.
    if bundle_id.chars().any(|c| c == '/' || c.is_whitespace()) {
        return Err("bundle_id must not contain slashes or whitespace".into());
    }

    let mut ok = Vec::new();
    let mut failed = Vec::new();
    for svc in TCC_SERVICES {
        let fat = crate::paths::fat_path().unwrap_or_default();
        let out = Command::new("/usr/bin/tccutil")
            .arg("reset")
            .arg(svc)
            .arg(&bundle_id)
            .env("PATH", fat)
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => ok.push((*svc).to_string()),
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                failed.push(format!("{}: {}", svc, if stderr.is_empty() { "non-zero exit".into() } else { stderr }));
            }
            Err(e) => failed.push(format!("{}: spawn failed: {}", svc, e)),
        }
    }

    Ok(TccResetResult { bundle_id, ok, failed })
}

#[cfg(not(target_os = "macos"))]
pub async fn reset_tcc_for(bundle_id: String) -> Result<TccResetResult, String> {
    Ok(TccResetResult { bundle_id, ok: vec![], failed: vec!["tccutil is macOS-only".into()] })
}

// --- Tests ------------------------------------------------------------------
//
// The real behaviour of these calls depends on the TCC database and whether
// the running process is in it, so they're unit-untestable in CI. We keep a
// smoke test that simply verifies the functions *return* and compile: a
// missing framework link would show up here as a linker error, not a runtime
// failure.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_return_without_panicking() {
        let _ = has_screen_recording();
        let _ = has_accessibility();
        let _ = has_full_disk_access();
    }
}
