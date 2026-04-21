//! In-memory ring buffer + file-backed JSONL audit log for security events.
//!
//! Every event pushed to [`super::emit`] lands here. The ring keeps the
//! last N (default 2000) entries so the Security page can render a feed
//! without another IPC round-trip, and the JSONL file gives us a
//! persistent audit trail across restarts.
//!
//! The JSONL file is rotated when it exceeds `FILE_ROTATE_BYTES`. We
//! keep a single `.prev` generation and discard older history — the
//! ring buffer exists to be fast and bounded, not to be a compliance
//! log. Phase 2 adds hash-chaining + export.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::SecurityEvent;

/// Cap on the in-memory ring. Each event is small (few hundred bytes),
/// so 2000 costs ~500 KB worst-case — trivial next to the 100s of MB
/// the memory + scan caches already hold.
const RING_CAP: usize = 2000;

/// Roll the JSONL over at this size. 10 MB is enough for a couple of
/// full days of chatty agent runs without ever becoming a performance
/// problem on append.
const FILE_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

pub struct SecurityStore {
    data_dir: PathBuf,
    ring: Mutex<Vec<SecurityEvent>>,
    /// Append-only JSONL writer. We keep it in a mutex because every
    /// push synchronously flushes the line — the monitor's audit trail
    /// is of zero use if a crash can lose the last 30s of events.
    writer: Mutex<Option<BufWriter<File>>>,
    /// Tail of the hash chain. Each new JSONL line is written as
    /// `{"h":"<sha256(prev_h || body)>","e":<event>}` so a post-hoc
    /// edit can be detected by re-computing the chain.
    chain_head: Mutex<String>,
}

impl SecurityStore {
    pub fn new(data_dir: PathBuf) -> Self {
        // Tail-read the existing events file (if any) so the chain
        // head survives restarts.  Tolerant of corruption — if we
        // can't parse the last line we fall back to the empty seed.
        let head = recover_chain_head(&data_dir.join("events.jsonl")).unwrap_or_default();
        Self {
            data_dir,
            ring: Mutex::new(Vec::with_capacity(RING_CAP.min(256))),
            writer: Mutex::new(None),
            chain_head: Mutex::new(head),
        }
    }

    /// Parked — reserved for the forensic bundle writer in
    /// `security::incident` which needs the on-disk root.
    #[allow(dead_code)]
    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    pub fn events_file(&self) -> PathBuf {
        self.data_dir.join("events.jsonl")
    }

    /// Append one event to both sinks. Never panics; I/O errors are
    /// logged and the ring-buffer push still happens so live callers
    /// see the event.
    pub fn push(&self, ev: &SecurityEvent) {
        // Ring buffer first — cheap and lock-free'ish.
        if let Ok(mut ring) = self.ring.lock() {
            ring.push(ev.clone());
            if ring.len() > RING_CAP {
                let excess = ring.len() - RING_CAP;
                ring.drain(0..excess);
            }
        }

        // File next. Short-circuit on earlier IO failure to avoid
        // hammering a broken disk — we reset on rotation.
        let body = match serde_json::to_string(ev) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("security: serialize event failed: {e}");
                return;
            }
        };

        // Hash-chain the line: new_head = SHA256(prev_head || body).
        // This lets an auditor detect any post-hoc edit / deletion
        // of the JSONL file — recomputing the chain from the first
        // line will mismatch at the tampered row.  The chain is not
        // cryptographically signed (that's Phase 4 ed25519-in-
        // Keychain), but tamper-evidence without a key is still
        // strictly better than raw append.
        let new_head = {
            let prev = self.chain_head.lock().map(|g| g.clone()).unwrap_or_default();
            let mut h = Sha256::new();
            h.update(prev.as_bytes());
            h.update(body.as_bytes());
            format!("{:x}", h.finalize())
        };
        let serialized = format!("{{\"h\":\"{new_head}\",\"e\":{body}}}");
        if let Ok(mut g) = self.chain_head.lock() {
            *g = new_head;
        }

        let mut guard = match self.writer.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.is_none() {
            match self.open_writer() {
                Ok(w) => *guard = Some(w),
                Err(e) => {
                    log::warn!("security: open events.jsonl failed: {e}");
                    return;
                }
            }
        }
        // We wrote a line — check for rotation next tick.
        let needs_rotate = {
            let w = guard.as_ref().expect("writer just ensured");
            w.get_ref().metadata().map(|m| m.len() >= FILE_ROTATE_BYTES).unwrap_or(false)
        };
        if let Some(w) = guard.as_mut() {
            if let Err(e) = writeln!(w, "{}", serialized) {
                log::warn!("security: append events.jsonl failed: {e}");
                *guard = None;
                return;
            }
            if let Err(e) = w.flush() {
                log::warn!("security: flush events.jsonl failed: {e}");
            }
        }
        if needs_rotate {
            // Drop the writer before rotating so the old file handle is
            // released; reopen lazily on the next push.
            *guard = None;
            drop(guard);
            if let Err(e) = self.rotate() {
                log::warn!("security: rotate events.jsonl failed: {e}");
            }
        }
    }

    /// Read up to `limit` most recent events, optionally filtered to
    /// events at or after the given unix timestamp.
    pub fn recent(&self, limit: usize, since: Option<i64>) -> Vec<SecurityEvent> {
        let Ok(ring) = self.ring.lock() else {
            return Vec::new();
        };
        let iter = ring.iter().rev().filter(|e| match since {
            None => true,
            Some(s) => event_time(e) >= s,
        });
        let mut out: Vec<SecurityEvent> = iter.take(limit).cloned().collect();
        out.reverse(); // oldest → newest within the window
        out
    }

    /// Snapshot the whole ring (bounded — at most `RING_CAP` entries).
    pub fn snapshot(&self) -> Vec<SecurityEvent> {
        self.ring.lock().map(|r| r.clone()).unwrap_or_default()
    }

    /// Copy the current events.jsonl to an arbitrary path. Used by
    /// `security_audit_export`.
    pub fn export(&self, dst: &std::path::Path) -> std::io::Result<u64> {
        // Flush before copying so the copy reflects every event that
        // had hit the writer up to this call.
        if let Ok(mut guard) = self.writer.lock() {
            if let Some(w) = guard.as_mut() {
                let _ = w.flush();
            }
        }
        let src = self.events_file();
        if !src.exists() {
            return Ok(0);
        }
        std::fs::copy(src, dst)
    }

    fn open_writer(&self) -> std::io::Result<BufWriter<File>> {
        std::fs::create_dir_all(&self.data_dir)?;
        let f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.events_file())?;
        Ok(BufWriter::new(f))
    }

    fn rotate(&self) -> std::io::Result<()> {
        let src = self.events_file();
        if !src.exists() {
            return Ok(());
        }
        let dst = self.data_dir.join("events.jsonl.prev");
        // Best-effort: if rename fails (cross-device, etc.) fall back
        // to copy + truncate.
        match std::fs::rename(&src, &dst) {
            Ok(()) => Ok(()),
            Err(_) => {
                std::fs::copy(&src, &dst)?;
                std::fs::write(&src, b"")?;
                Ok(())
            }
        }
    }
}

fn event_time(ev: &SecurityEvent) -> i64 {
    ev.at()
}

/// Read the last line of the JSONL file and extract its `h` field so
/// the hash chain survives restarts.  Returns empty string for a
/// missing / empty / malformed file (new install).
fn recover_chain_head(path: &std::path::Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    // Walk from the end 4 KB at a time until we find a newline.
    let end = reader.get_ref().metadata().ok()?.len();
    let mut pos: i64 = end as i64;
    let chunk = 4096i64;
    let mut last_line = String::new();
    'outer: while pos > 0 {
        let read_from = (pos - chunk).max(0);
        reader.seek(SeekFrom::Start(read_from as u64)).ok()?;
        let mut buf = String::new();
        reader.read_to_string(&mut buf).ok()?;
        // Walk the buffer backwards to find the last non-empty line.
        let mut lines: Vec<&str> = buf.lines().collect();
        while let Some(line) = lines.pop() {
            let t = line.trim();
            if !t.is_empty() {
                last_line = t.to_string();
                break 'outer;
            }
        }
        pos = read_from;
    }
    if last_line.is_empty() {
        return None;
    }
    // Extract `h` field without pulling in serde_json parsing for
    // every candidate line — regex-light string scan is enough.
    let h_key = "\"h\":\"";
    let i = last_line.find(h_key)?;
    let rest = &last_line[i + h_key.len()..];
    let j = rest.find('"')?;
    Some(rest[..j].to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::Severity;

    fn tmp_dir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "sunny-sec-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn notice(msg: &str) -> SecurityEvent {
        SecurityEvent::Notice {
            at: 42,
            source: "test".into(),
            message: msg.into(),
            severity: Severity::Info,
        }
    }

    #[test]
    fn ring_caps_at_cap() {
        let dir = tmp_dir();
        let store = SecurityStore::new(dir);
        for i in 0..(RING_CAP + 250) {
            store.push(&notice(&format!("n-{i}")));
        }
        assert_eq!(store.snapshot().len(), RING_CAP);
    }

    #[test]
    fn recent_returns_newest_first_in_window() {
        let dir = tmp_dir();
        let store = SecurityStore::new(dir);
        store.push(&notice("a"));
        store.push(&notice("b"));
        store.push(&notice("c"));
        let got = store.recent(2, None);
        assert_eq!(got.len(), 2);
        // recent() reverses so that output is oldest→newest within the
        // last-N window.  That should put "b" before "c".
        if let SecurityEvent::Notice { message, .. } = &got[0] {
            assert_eq!(message, "b");
        } else { panic!("wrong kind"); }
    }

    #[test]
    fn events_file_gets_written() {
        let dir = tmp_dir();
        let store = SecurityStore::new(dir.clone());
        store.push(&notice("hello"));
        // Buffer flushes after each push so the file should exist.
        let path = store.events_file();
        assert!(path.exists(), "jsonl not created");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("hello"), "got: {body}");
        // Hash-chain envelope present.
        assert!(body.contains("\"h\":\""), "no chain head in line");
        assert!(body.contains("\"e\":"), "no event envelope");
    }

    #[test]
    fn chain_head_survives_new_store_on_same_dir() {
        let dir = tmp_dir();
        let s1 = SecurityStore::new(dir.clone());
        s1.push(&notice("first"));
        s1.push(&notice("second"));
        // Drop and re-open — the tail-read should recover the chain.
        drop(s1);
        let s2 = SecurityStore::new(dir.clone());
        s2.push(&notice("third"));
        let body = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
        let heads: Vec<&str> = body.lines().map(|l| {
            // Extract the "h":"..." prefix for a quick "three distinct heads" check.
            let i = l.find("\"h\":\"").unwrap();
            &l[i + 5..i + 5 + 64]
        }).collect();
        assert_eq!(heads.len(), 3);
        // Each row's head must differ — chain moves forward every
        // write even across restarts.
        assert_ne!(heads[0], heads[1]);
        assert_ne!(heads[1], heads[2]);
    }
}
