//! Per-file heuristic inspections. None of these on their own are
//! conclusive; the scanner combines them with MalwareBazaar/VirusTotal
//! lookups to form a verdict.
//!
//! Every heuristic is best-effort and must never panic — we're running over
//! arbitrary filesystems owned by the user, who can have exotic symlinks,
//! sparse files, corrupt archives, or files without read permission.

use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use super::types::{Signal, SignalKind, Verdict};

// ---------------------------------------------------------------------------
// Metadata-cheap heuristics (no subprocess, no read)
// ---------------------------------------------------------------------------

/// Downloads, /tmp, Desktop — places malware drops itself.
pub fn path_risk(path: &Path) -> Option<Signal> {
    let s = path.to_string_lossy();
    let home = dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

    // Absolute paths worth flagging wherever they occur.
    if s.starts_with("/tmp/") || s.starts_with("/private/tmp/") || s.starts_with("/var/tmp/") {
        return Some(Signal {
            kind: SignalKind::RiskyPath,
            detail: "Lives in /tmp — transient location commonly used by droppers.".into(),
            weight: Verdict::Info,
        });
    }

    // User-dir specific paths.
    if !home.is_empty() {
        if s.starts_with(&format!("{home}/Downloads/")) {
            return Some(Signal {
                kind: SignalKind::RiskyPath,
                detail: "Lives in ~/Downloads — arrived via browser or messenger.".into(),
                weight: Verdict::Info,
            });
        }
        if s.starts_with(&format!("{home}/Desktop/")) {
            return Some(Signal {
                kind: SignalKind::RiskyPath,
                detail: "Lives on ~/Desktop — user-facing drop zone.".into(),
                weight: Verdict::Info,
            });
        }
    }

    None
}

pub fn recently_modified(meta: &Metadata) -> Option<Signal> {
    let modified = meta.modified().ok()?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    let hours = age.as_secs() / 3600;
    if hours <= 24 {
        Some(Signal {
            kind: SignalKind::RecentlyModified,
            detail: format!("Modified {hours}h ago — fresh arrival."),
            weight: Verdict::Info,
        })
    } else {
        None
    }
}

pub fn hidden_in_user_dir(path: &Path) -> Option<Signal> {
    let name = path.file_name()?.to_string_lossy();
    if !name.starts_with('.') || name == "." || name == ".." {
        return None;
    }
    // Only flag hidden files inside user-visible dirs — ignoring the tons of
    // legit dotfiles inside ~/ itself.
    let parent = path.parent()?;
    let parent_name = parent.file_name().map(|n| n.to_string_lossy().to_string())?;
    if matches!(parent_name.as_str(), "Downloads" | "Desktop" | "Documents") {
        Some(Signal {
            kind: SignalKind::HiddenInUserDir,
            detail: format!("Hidden file in ~/{parent_name} — unusual for a user folder."),
            weight: Verdict::Info,
        })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// File-content heuristics (small reads)
// ---------------------------------------------------------------------------

/// Read the first 4 bytes and classify by magic. `None` for unreadable /
/// empty files — caller treats those as "not an executable".
pub fn magic_signal(path: &Path) -> Option<Signal> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut hdr = [0u8; 4];
    if f.read(&mut hdr).ok()? < 4 {
        return None;
    }

    // Mach-O magic (fat + thin, BE + LE).
    let mach = matches!(
        &hdr,
        b"\xFE\xED\xFA\xCE" | b"\xCE\xFA\xED\xFE" |
        b"\xFE\xED\xFA\xCF" | b"\xCF\xFA\xED\xFE" |
        b"\xCA\xFE\xBA\xBE" | b"\xBE\xBA\xFE\xCA"
    );
    // ELF (Linux, rare on macOS).
    let elf = &hdr == b"\x7FELF";
    // PE/DOS (Windows — never benign on macOS outside a VM image).
    let pe = &hdr[..2] == b"MZ";

    if mach {
        return Some(Signal {
            kind: SignalKind::Executable,
            detail: "Mach-O binary — native macOS executable.".into(),
            weight: Verdict::Info,
        });
    }
    if elf {
        return Some(Signal {
            kind: SignalKind::Executable,
            detail: "ELF binary — unusual on macOS (Linux executable).".into(),
            weight: Verdict::Suspicious,
        });
    }
    if pe {
        return Some(Signal {
            kind: SignalKind::Executable,
            detail: "PE/DOS binary — a Windows executable sitting on macOS.".into(),
            weight: Verdict::Suspicious,
        });
    }

    // Shebang scripts: `#!...` and check the interpreter path is standard.
    if &hdr[..2] == b"#!" {
        // Re-read first line properly.
        let mut first_line = String::new();
        if let Ok(f) = std::fs::File::open(path) {
            use std::io::{BufRead, BufReader};
            let mut br = BufReader::new(f);
            let _ = br.read_line(&mut first_line);
        }
        let line = first_line.trim_start_matches("#!").trim().to_string();
        let interp = line.split_whitespace().next().unwrap_or("");
        let standard = [
            "/bin/sh", "/bin/bash", "/bin/zsh", "/bin/ksh",
            "/usr/bin/env", "/usr/bin/python3", "/usr/bin/perl",
            "/usr/bin/osascript",
        ];
        if !interp.is_empty() && !standard.iter().any(|s| interp == *s) {
            return Some(Signal {
                kind: SignalKind::UnusualScript,
                detail: format!("Script with non-standard interpreter: {interp}"),
                weight: Verdict::Suspicious,
            });
        }
    }

    None
}

// ---------------------------------------------------------------------------
// macOS: quarantine xattr
// ---------------------------------------------------------------------------

/// Read `com.apple.quarantine` via the native `getxattr(2)` syscall rather
/// than spawning `/usr/bin/xattr`. The subprocess version cost ~10–30 ms per
/// file on an M-series Mac (fork + exec + dyld + interpreter warmup) — at
/// thousands of files per scan that alone was the difference between a
/// 30-second scan and a 3-second scan.
///
/// Format of the attribute value is `flags;epoch_hex;agent;uuid` where the
/// agent hints where the file came from (Safari, Chrome, Mail, AirDrop…).
pub fn quarantine_signal(path: &Path) -> Option<Signal> {
    let raw = read_xattr(path, "com.apple.quarantine")?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let agent = raw.split(';').nth(2).unwrap_or("unknown");
    Some(Signal {
        kind: SignalKind::Quarantined,
        detail: format!("Downloaded via {agent} — carries Gatekeeper quarantine flag."),
        weight: Verdict::Info,
    })
}

/// Native `getxattr(2)` wrapper. Returns `None` when the attribute is
/// missing, unreadable, or the path can't be represented as a C string
/// (embedded NULs). Never spawns a subprocess.
///
/// macOS only — the `com.apple.quarantine` xattr is a Gatekeeper concept
/// that has no equivalent on Linux, and the libc signatures differ (macOS
/// `getxattr` takes 6 args including position + options; Linux takes 4).
/// Non-macOS builds get a stub that always returns `None`, which lets the
/// caller `quarantine_signal` compile and degrade gracefully on CI Linux.
#[cfg(target_os = "macos")]
fn read_xattr(path: &Path, name: &str) -> Option<String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let c_name = CString::new(name).ok()?;

    // Two-step: probe for size, then read. Most quarantine values are
    // <64 bytes, so a 256-byte stack buffer handles them inline without a
    // size probe in the common case — fall back to a heap alloc only if the
    // attribute is larger than that.
    let mut stack_buf = [0u8; 256];
    // macOS `getxattr` signature:
    //   ssize_t getxattr(const char *path, const char *name,
    //                    void *value, size_t size,
    //                    u_int32_t position, int options);
    let n = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            c_name.as_ptr(),
            stack_buf.as_mut_ptr() as *mut libc::c_void,
            stack_buf.len(),
            0,
            0,
        )
    };
    if n >= 0 {
        let slice = &stack_buf[..n as usize];
        return Some(String::from_utf8_lossy(slice).into_owned());
    }
    // ERANGE => attribute exists but is larger than our stack buffer.
    // Query the real size and heap-alloc a buffer. Any other errno (ENOATTR,
    // EACCES, ENOENT, …) means "no quarantine signal here".
    let errno = unsafe { *libc::__error() };
    if errno != libc::ERANGE {
        return None;
    }
    let need = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            c_name.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u8; need as usize];
    let got = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            c_name.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len(),
            0,
            0,
        )
    };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn read_xattr(_path: &Path, _name: &str) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// macOS: code signature verification
// ---------------------------------------------------------------------------

/// Run `codesign --verify --deep --strict` on the file. Fast fail-through
/// when the binary is trivially un-signable (non Mach-O, symlink, empty file).
///
/// `codesign` is the single most expensive per-file operation in the whole
/// scanner: each invocation is 50–300 ms because it has to mmap the binary,
/// walk the Mach-O load commands, verify the embedded signature against the
/// macOS CA chain, and recurse into every framework inside a .app bundle.
/// We therefore *never* run it on files that sit under Apple-owned roots —
/// every one of those is signed by Apple, has been verified at install time,
/// and wouldn't tell us anything new even if the signature were somehow
/// broken (malware doesn't live in `/System` on a sealed-system-volume Mac).
pub fn codesign_signal(path: &Path, is_executable: bool) -> Option<Signal> {
    // Only run codesign on files our magic-check already believes are binaries
    // or .app bundles. Running it on every text file is slow and noisy.
    if !is_executable && !is_app_bundle(path) {
        return None;
    }
    if is_apple_signed_path(path) {
        return None;
    }
    let out = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--deep")
        .arg("--strict")
        .arg(path)
        .output()
        .ok()?;
    if out.status.success() {
        return None;
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // Distinguish "unsigned" (info-level) from "tampered" (suspicious).
    let weight = if stderr.contains("not signed") || stderr.contains("code object is not signed") {
        Verdict::Info
    } else {
        Verdict::Suspicious
    };
    let short = stderr.lines().next().unwrap_or("code signature verification failed").to_string();
    Some(Signal {
        kind: SignalKind::Unsigned,
        detail: format!("codesign: {short}"),
        weight,
    })
}

fn is_app_bundle(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "app")
}

/// Paths whose contents are guaranteed Apple-signed and essentially
/// immutable on a modern sealed-system-volume Mac. Skipping codesign here
/// is safe and removes thousands of subprocess spawns from big scans.
fn is_apple_signed_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.starts_with("/System/")
        || s.starts_with("/usr/lib/")
        || s.starts_with("/usr/libexec/")
        || s.starts_with("/usr/bin/")
        || s.starts_with("/usr/sbin/")
        || s.starts_with("/Library/Apple/")
        || s.starts_with("/private/var/db/com.apple.xpc.roleaccountd.staging/")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve to a canonical absolute path. Used for dedup + display.
/// Parked — reserved for future dedup pass in the scan report.
#[allow(dead_code)]
pub fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
