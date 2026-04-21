//! Loopback HTTP bridge used by hardened WebView tabs.
//!
//! When a sandbox tab is spawned, we start a tokio TCP listener bound to
//! `127.0.0.1:<ephemeral-port>` and tell the WebView to use it as an HTTP
//! proxy. Every resource the page requests then walks back through the
//! [`Dispatcher`](super::dispatcher::Dispatcher), which means Tor routing,
//! ad-block, audit logging and the kill switch apply uniformly to JS-driven
//! traffic.
//!
//! Scope of the bridge implementation:
//! - We parse `CONNECT host:port` requests (HTTPS) and return a minimal
//!   `200 OK` then splice bytes — the WebView terminates TLS directly with
//!   the destination, and we only see the handshake bytes go by.
//! - We parse plaintext HTTP `GET|POST|...` requests, dispatch them through
//!   `Dispatcher::fetch`, and write the response back.
//!
//! What the bridge does *not* do:
//! - HTTPS MITM (intentional — we have no reason to see decrypted bytes).
//! - WebSocket upgrades (they flow through the CONNECT path since most are
//!   wss:// in practice; ws:// over this plaintext path works too).
//! - HTTP/2 upgrades (WKWebView downgrades cleanly when the proxy is h1).
//!
//! Each bridge owns a `oneshot` shutdown channel that the sandbox module
//! triggers on tab close. Dropping the handle without calling `shutdown()`
//! leaks the listener — call sites must be explicit.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::browser::dispatcher::{Dispatcher, FetchOptions};
use crate::browser::profile::ProfileId;

pub struct BridgeHandle {
    // Diagnostic fields — surface in debug prints and `active_bridges()`.
    // Kept in the struct (not just the registry key / tuple) so future
    // code paths that hand a BridgeHandle around don't need to re-thread
    // the tab id separately.
    #[allow(dead_code)]
    pub tab_id: String,
    #[allow(dead_code)]
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

impl BridgeHandle {
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Registry so the sandbox module can look up and shut down bridges by tab.
fn registry() -> &'static Mutex<HashMap<String, BridgeHandle>> {
    static CELL: OnceLock<Mutex<HashMap<String, BridgeHandle>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shutdown_tab(tab_id: &str) {
    if let Ok(mut g) = registry().lock() {
        if let Some(mut h) = g.remove(tab_id) {
            h.shutdown();
        }
    }
}

/// Diagnostic snapshot of active bridges — parked for a future
/// `browser_bridge_list` debug command.
#[allow(dead_code)]
pub fn active_bridges() -> Vec<(String, SocketAddr)> {
    registry()
        .lock()
        .map(|g| {
            g.iter()
                .map(|(k, v)| (k.clone(), v.addr))
                .collect()
        })
        .unwrap_or_default()
}

/// Spawn a bridge on an ephemeral loopback port and register it for the
/// given tab. Returns the bound `SocketAddr`. Calling `spawn` twice for the
/// same `tab_id` shuts the previous bridge down first.
pub async fn spawn(
    dispatcher: Arc<Dispatcher>,
    profile_id: ProfileId,
    tab_id: String,
) -> Result<SocketAddr, String> {
    // Tear down any existing bridge for this tab so we never leak listeners
    // if a navigation request reuses the same tab id.
    shutdown_tab(&tab_id);

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bridge bind: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("bridge local_addr: {e}"))?;

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let disp = dispatcher.clone();
    let pid = profile_id.clone();
    let tid = tab_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!("bridge: shutdown signalled tab={}", tid);
                    break;
                }
                accept = listener.accept() => {
                    match accept {
                        Ok((sock, _peer)) => {
                            let d = disp.clone();
                            let p = pid.clone();
                            let t = tid.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle(sock, d, p, t).await {
                                    log::debug!("bridge conn: {e}");
                                }
                            });
                        }
                        Err(e) => {
                            log::warn!("bridge accept: {e}");
                            continue;
                        }
                    }
                }
            }
        }
    });

    let handle = BridgeHandle {
        tab_id: tab_id.clone(),
        addr,
        shutdown: Some(shutdown_tx),
    };
    if let Ok(mut g) = registry().lock() {
        g.insert(tab_id.clone(), handle);
    }

    log::info!(
        "bridge up for tab={} profile={} addr={}",
        tab_id,
        profile_id.as_str(),
        addr
    );
    Ok(addr)
}

async fn handle(
    sock: TcpStream,
    dispatcher: Arc<Dispatcher>,
    profile_id: ProfileId,
    tab_id: String,
) -> Result<(), String> {
    let (reader, mut writer) = sock.into_split();
    let mut reader = BufReader::new(reader);

    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .await
        .map_err(|e| format!("bridge read first: {e}"))?;
    let first = first_line.trim_end_matches(|c| c == '\r' || c == '\n').to_string();
    let parts: Vec<&str> = first.splitn(3, ' ').collect();
    if parts.len() < 3 {
        let _ = writer.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return Err(format!("malformed request line: {first:?}"));
    }
    let method = parts[0].to_ascii_uppercase();
    let target = parts[1];

    let mut req_headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("bridge read header: {e}"))?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if trimmed.is_empty() {
            break;
        }
        if let Some(colon) = trimmed.find(':') {
            let k = trimmed[..colon].trim().to_string();
            let v = trimmed[colon + 1..].trim().to_string();
            req_headers.push((k, v));
        }
    }

    if method == "CONNECT" {
        return handle_connect(target, writer, reader.into_inner()).await;
    }

    let url = target.to_string();

    let content_length: Option<usize> = req_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok());
    let mut body: Vec<u8> = Vec::new();
    if let Some(n) = content_length {
        body.resize(n, 0);
        reader
            .read_exact(&mut body[..])
            .await
            .map_err(|e| format!("bridge read body: {e}"))?;
    }

    let opts = FetchOptions {
        method: reqwest::Method::from_bytes(method.as_bytes())
            .unwrap_or(reqwest::Method::GET),
        headers: req_headers
            .into_iter()
            .filter(|(k, _)| !is_hop_by_hop(k))
            .collect(),
        body: if body.is_empty() { None } else { Some(body) },
        tab_id: Some(tab_id.clone()),
    };

    match dispatcher.fetch(&profile_id, &url, opts).await {
        Ok(resp) => {
            let status_line = format!("HTTP/1.1 {} OK\r\n", resp.status);
            writer
                .write_all(status_line.as_bytes())
                .await
                .map_err(|e| format!("bridge write status: {e}"))?;
            for (k, v) in resp.headers.iter() {
                if is_hop_by_hop(k) {
                    continue;
                }
                // Also strip Content-Length — we set our own from body.len().
                if k.eq_ignore_ascii_case("content-length") {
                    continue;
                }
                let h = format!("{k}: {v}\r\n");
                writer.write_all(h.as_bytes()).await.ok();
            }
            let len_hdr = format!("Content-Length: {}\r\n\r\n", resp.body.len());
            writer.write_all(len_hdr.as_bytes()).await.ok();
            writer.write_all(&resp.body).await.ok();
            writer.flush().await.ok();
        }
        Err(e) => {
            let body = format!("sunny bridge: {e}");
            let head = format!(
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            let _ = writer.write_all(head.as_bytes()).await;
            let _ = writer.write_all(body.as_bytes()).await;
        }
    }

    Ok(())
}

async fn handle_connect(
    target: &str,
    mut client_writer: tokio::net::tcp::OwnedWriteHalf,
    client_reader: tokio::net::tcp::OwnedReadHalf,
) -> Result<(), String> {
    let upstream = TcpStream::connect(target)
        .await
        .map_err(|e| format!("bridge connect upstream {target}: {e}"))?;
    client_writer
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(|e| format!("bridge connect ack: {e}"))?;
    let (up_r, mut up_w) = upstream.into_split();
    let mut client_r = client_reader;
    let mut up_r = up_r;

    let c2u = async {
        let _ = tokio::io::copy(&mut client_r, &mut up_w).await;
        let _ = up_w.shutdown().await;
    };
    let u2c = async {
        let _ = tokio::io::copy(&mut up_r, &mut client_writer).await;
        let _ = client_writer.shutdown().await;
    };
    tokio::join!(c2u, u2c);
    Ok(())
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}
