//! SHA-256 file hashing.
//!
//! Streams files through a 64 KB buffer so we never hold large binaries in
//! memory. Callers supply a `&AtomicBool` cancellation token — scans that
//! are aborted mid-hash return early rather than waiting for an 800 MB DMG
//! to finish.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

/// Buffer size is a compromise between syscall overhead and memory pressure.
/// 64 KB is the macOS page size * 16 — large enough to hide syscall latency,
/// small enough to be invisible to the allocator.
const BUF_SIZE: usize = 64 * 1024;

/// Compute the SHA-256 hex digest of `path`, polling `cancel` between reads.
/// Returns `None` only if cancellation fired before the digest completed.
pub fn sha256_file(path: &Path, cancel: &AtomicBool) -> io::Result<Option<String>> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; BUF_SIZE];

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(Some(format!("{:x}", hasher.finalize())))
}
