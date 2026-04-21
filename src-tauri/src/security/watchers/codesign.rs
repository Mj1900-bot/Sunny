//! Codesign tripwire.
//!
//! On-demand helper invoked by `control::open_path` / `run_shell` and
//! the scanner to verify that binaries the agent is launching are
//! signed.  Emits `SecurityEvent::UnsignedBinary` when `codesign
//! --verify` fails; callers are free to proceed — we only observe.
//!
//! Kept deliberately lightweight: one process spawn per call, a few
//! seconds' hard timeout, and a short cache so repeat calls to the
//! same binary (e.g. open the same app ten times) don't shell out
//! ten times.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::security::{self, SecurityEvent, Severity};

const CACHE_TTL: Duration = Duration::from_secs(300);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct CacheEntry {
    at: Instant,
    ok: bool,
    reason: String,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    use std::sync::OnceLock;
    static CELL: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Non-blocking check: if the path is already cached and the cached
/// verdict is "fails", emit an event and return. Otherwise spawn a
/// background task so the caller isn't slowed down waiting for
/// codesign.
pub fn probe(path: &str, initiator: &str) {
    if path.is_empty() {
        return;
    }
    // Skip obvious non-binary paths. codesign will reject them anyway
    // with a misleading "code object is not signed" message, which
    // would cause false positives for plain data files.
    if is_boring_path(path) {
        return;
    }

    let path_owned = path.to_string();
    let initiator_owned = initiator.to_string();
    tauri::async_runtime::spawn(async move {
        let verdict = check_cached(&path_owned).await;
        if !verdict.ok {
            security::emit(SecurityEvent::UnsignedBinary {
                at: security::now(),
                path: path_owned,
                initiator: initiator_owned,
                reason: verdict.reason,
                severity: Severity::Warn,
            });
        }
    });
}

async fn check_cached(path: &str) -> CacheEntry {
    {
        let guard = cache().lock();
        if let Ok(map) = guard {
            if let Some(entry) = map.get(path) {
                if entry.at.elapsed() < CACHE_TTL {
                    return entry.clone();
                }
            }
        }
    }
    let verdict = verify(path).await;
    if let Ok(mut map) = cache().lock() {
        map.insert(path.to_string(), verdict.clone());
        // Trim the cache if it grows unbounded. 2048 entries is plenty.
        if map.len() > 2048 {
            let to_drop: Vec<String> = map
                .iter()
                .filter(|(_, v)| v.at.elapsed() > CACHE_TTL)
                .map(|(k, _)| k.clone())
                .collect();
            for k in to_drop {
                map.remove(&k);
            }
        }
    }
    verdict
}

async fn verify(path: &str) -> CacheEntry {
    #[cfg(target_os = "macos")]
    {
        use tokio::process::Command;
        use tokio::time::timeout;

        let fut = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "--quiet", path])
            .output();
        match timeout(VERIFY_TIMEOUT, fut).await {
            Ok(Ok(out)) if out.status.success() => CacheEntry {
                at: Instant::now(),
                ok: true,
                reason: String::new(),
            },
            Ok(Ok(out)) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                CacheEntry {
                    at: Instant::now(),
                    ok: false,
                    reason: if stderr.is_empty() {
                        "codesign verify failed".into()
                    } else {
                        stderr
                    },
                }
            }
            Ok(Err(e)) => CacheEntry {
                at: Instant::now(),
                ok: true, // spawn failure — don't flag the binary, the tool is the problem.
                reason: format!("codesign spawn failed: {e}"),
            },
            Err(_) => CacheEntry {
                at: Instant::now(),
                ok: true,
                reason: "codesign timed out".into(),
            },
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        CacheEntry {
            at: Instant::now(),
            ok: true,
            reason: "codesign is macOS-only".into(),
        }
    }
}

fn is_boring_path(path: &str) -> bool {
    // Only .app, .pkg, .dmg, shebangless binaries, /usr/bin, /Applications.
    // Doc-ish extensions we never want to sic codesign on.
    let lower = path.to_lowercase();
    for ext in [
        ".txt", ".md", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".csv",
        ".json", ".yaml", ".yml", ".toml", ".ini", ".html", ".xml",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    false
}
