//! PTY agent — high-level operations on top of `PtyRegistry` for the AI
//! to drive a terminal: open, send a line, wait for a regex prompt,
//! read the accumulated buffer, then stop.
//!
//! Output is captured by subscribing to the `sunny://pty/{id}` event that
//! `pty::open` already emits and appending the decoded bytes into an
//! in-memory ring buffer (cap 512 KB, drops oldest 64 KB on overflow).

use crate::pty;
use crate::pty::PtyRegistry;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, EventId, Listener};

const BUFFER_CAP: usize = 512 * 1024; // 512 KB
const OVERFLOW_DROP: usize = 64 * 1024; // drop oldest 64 KB when full
const POLL_INTERVAL_MS: u64 = 50;
const TAIL_SNIPPET: usize = 2 * 1024; // 2 KB
const TIMEOUT_MIN: u64 = 1;
const TIMEOUT_MAX: u64 = 600;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WaitResult {
    pub matched: bool,
    pub match_text: String,
    pub match_offset: usize,
    pub buffer_snippet: String,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReadBuffer {
    pub data: String,
    pub total_bytes: usize,
}

struct AgentBuffer {
    data: Vec<u8>,
    total_bytes_written: u64,
    last_wait_offset: usize,
    listener: Option<EventId>,
}

impl AgentBuffer {
    fn new() -> Self {
        Self {
            data: Vec::with_capacity(64 * 1024),
            total_bytes_written: 0,
            last_wait_offset: 0,
            listener: None,
        }
    }
}

fn buffers() -> &'static Mutex<HashMap<String, AgentBuffer>> {
    static BUFFERS: OnceLock<Mutex<HashMap<String, AgentBuffer>>> = OnceLock::new();
    BUFFERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Append bytes into the ring-buffer. On overflow drops the oldest 64 KB.
/// Returns nothing — pure side-effect on the buffer.
fn append_to_buffer(buf: &mut AgentBuffer, bytes: &[u8]) {
    buf.total_bytes_written = buf.total_bytes_written.saturating_add(bytes.len() as u64);
    buf.data.extend_from_slice(bytes);
    while buf.data.len() > BUFFER_CAP {
        let drop_n = OVERFLOW_DROP.min(buf.data.len());
        buf.data.drain(0..drop_n);
        // Slide the last_wait_offset so that it still points at a sensible
        // position after the truncation. If it was inside the dropped prefix
        // snap it to zero.
        buf.last_wait_offset = buf.last_wait_offset.saturating_sub(drop_n);
    }
}

pub async fn open_agent_pty(
    registry: &PtyRegistry,
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
    {
        let map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
        if map.contains_key(&id) {
            return Err(format!("agent pty '{id}' already open"));
        }
    }

    pty::open(registry, app.clone(), id.clone(), cols, rows, shell)?;

    {
        let mut map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
        map.insert(id.clone(), AgentBuffer::new());
    }

    let event = format!("sunny://pty/{id}");
    let id_for_listener = id.clone();
    let listener_id = app.listen(event, move |ev| {
        // The payload is a JSON string like {"id":"...","data":"..."}.
        // We only need the `data` field. Parse defensively — on error, skip.
        let payload = ev.payload();
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(payload);
        let data_str = match parsed {
            Ok(v) => match v.get("data").and_then(|d| d.as_str()).map(str::to_owned) {
                Some(s) => s,
                None => return,
            },
            Err(_) => return,
        };
        let mut map = match buffers().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        if let Some(buf) = map.get_mut(&id_for_listener) {
            append_to_buffer(buf, data_str.as_bytes());
        }
    });

    {
        let mut map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
        if let Some(buf) = map.get_mut(&id) {
            buf.listener = Some(listener_id);
        }
    }

    Ok(())
}

pub async fn send_line(
    registry: &PtyRegistry,
    id: String,
    text: String,
    press_enter: bool,
) -> Result<(), String> {
    let mut payload = text.into_bytes();
    if press_enter {
        payload.push(b'\n');
    }
    pty::write(registry, &id, &payload)
}

pub async fn wait_for(
    id: String,
    pattern: String,
    timeout_sec: u64,
    since_offset: Option<usize>,
) -> Result<WaitResult, String> {
    let re = Regex::new(&pattern).map_err(|e| format!("invalid regex: {e}"))?;
    let timeout = timeout_sec.clamp(TIMEOUT_MIN, TIMEOUT_MAX);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let started = std::time::Instant::now();

    loop {
        // Snapshot the buffer under the lock, then release before sleeping.
        let snapshot = {
            let map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
            let buf = map
                .get(&id)
                .ok_or_else(|| format!("unknown agent pty '{id}'"))?;
            let start = since_offset.unwrap_or(buf.last_wait_offset).min(buf.data.len());
            (buf.data.clone(), start)
        };
        let (data, start) = snapshot;

        let haystack = String::from_utf8_lossy(&data[start..]);
        if let Some(m) = re.find(&haystack) {
            let abs_start = start + m.start();
            let abs_end = start + m.end();
            let tail_start = abs_end.saturating_sub(TAIL_SNIPPET);
            let buffer_snippet = String::from_utf8_lossy(&data[tail_start..abs_end]).to_string();

            // Advance last_wait_offset so the next call doesn't re-report.
            {
                let mut map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
                if let Some(buf) = map.get_mut(&id) {
                    buf.last_wait_offset = abs_end;
                }
            }

            return Ok(WaitResult {
                matched: true,
                match_text: m.as_str().to_string(),
                match_offset: abs_start,
                buffer_snippet,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }

        if std::time::Instant::now() >= deadline {
            let tail_start = data.len().saturating_sub(TAIL_SNIPPET);
            let buffer_snippet = String::from_utf8_lossy(&data[tail_start..]).to_string();
            return Ok(WaitResult {
                matched: false,
                match_text: String::new(),
                match_offset: 0,
                buffer_snippet,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }

        tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

pub async fn read_buffer(
    id: String,
    from_offset: Option<usize>,
) -> Result<ReadBuffer, String> {
    let map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
    let buf = map
        .get(&id)
        .ok_or_else(|| format!("unknown agent pty '{id}'"))?;
    let start = from_offset.unwrap_or(0).min(buf.data.len());
    let data = String::from_utf8_lossy(&buf.data[start..]).to_string();
    Ok(ReadBuffer { data, total_bytes: buf.data.len() })
}

pub async fn clear_buffer(id: String) -> Result<(), String> {
    let mut map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
    let buf = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown agent pty '{id}'"))?;
    buf.data.clear();
    buf.last_wait_offset = 0;
    Ok(())
}

pub async fn stop_agent_pty(registry: &PtyRegistry, id: String) -> Result<(), String> {
    // Remove the buffer first so any in-flight listener callback becomes a
    // no-op (it won't find the entry).
    let listener = {
        let mut map = buffers().lock().map_err(|e| format!("lock: {e}"))?;
        map.remove(&id).and_then(|b| b.listener)
    };
    // The Tauri AppHandle needed to unlisten lives behind the listener id;
    // the listener handle itself is dropped when the buffer entry drops —
    // but Tauri's `listen` returns an id that requires AppHandle to unlisten.
    // Since we don't have AppHandle here, we rely on the fact that the
    // callback checks for buffer presence and becomes a no-op. This is a
    // deliberate simplification: the reader thread in `pty::close` still
    // emits final events, but they land on a now-absent entry and are
    // discarded. If a future version wants explicit `unlisten` it will need
    // to thread `AppHandle` through this function.
    let _ = listener;

    pty::close(registry, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_ring_truncates_at_cap() {
        let mut buf = AgentBuffer::new();
        // Fill to cap exactly — should stay at cap.
        let chunk = vec![b'A'; BUFFER_CAP];
        append_to_buffer(&mut buf, &chunk);
        assert_eq!(buf.data.len(), BUFFER_CAP);
        assert_eq!(buf.total_bytes_written, BUFFER_CAP as u64);

        // Push 1 KB more — should drop 64 KB oldest (bringing len to cap-63K)
        // then still be under cap. Then next chunk lands.
        let extra = vec![b'B'; 1024];
        append_to_buffer(&mut buf, &extra);
        assert!(buf.data.len() <= BUFFER_CAP);
        // The newest bytes must still be present at the tail.
        assert_eq!(&buf.data[buf.data.len() - 1024..], &extra[..]);
        assert_eq!(buf.total_bytes_written, (BUFFER_CAP + 1024) as u64);
    }

    #[test]
    fn regex_compile_error_surfaces() {
        // `wait_for` compiles the regex first — run the Regex::new check
        // directly (sync) so we don't need a tokio runtime here.
        let bad = Regex::new("(unclosed");
        assert!(bad.is_err(), "expected regex compile failure");
    }

    #[test]
    fn wait_for_instant_hit_on_existing_data() {
        // Pre-seed a buffer under a known id, then call wait_for.
        let id = "test-instant-hit".to_string();
        {
            let mut map = buffers().lock().unwrap();
            let mut b = AgentBuffer::new();
            append_to_buffer(&mut b, b"preamble READY > $ ");
            map.insert(id.clone(), b);
        }

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let res = rt
            .block_on(wait_for(id.clone(), r"READY".to_string(), 5, None))
            .expect("wait_for returns Ok");
        assert!(res.matched);
        assert_eq!(res.match_text, "READY");
        // offset points to where the 'R' landed.
        assert_eq!(res.match_offset, "preamble ".len());
        // last_wait_offset should now sit just past the match so a re-call
        // with None for since_offset would not re-hit the same substring.
        let res2 = rt
            .block_on(wait_for(id.clone(), r"READY".to_string(), 1, None))
            .expect("wait_for returns Ok");
        assert!(!res2.matched, "second call must not re-report the same match");

        // Cleanup.
        buffers().lock().unwrap().remove(&id);
    }
}

// === REGISTER IN lib.rs ===
// mod pty_agent;
// #[tauri::command]s: pty_agent_open, pty_agent_send_line, pty_agent_wait_for, pty_agent_read_buffer, pty_agent_clear_buffer, pty_agent_stop
// invoke_handler: same names
// Cargo deps: regex = "1"
// === END REGISTER ===
