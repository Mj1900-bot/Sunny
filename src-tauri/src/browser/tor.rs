//! Bundled Tor via the `arti-client` Rust crate.
//!
//! Gated behind `--features bundled-tor`. Enabling it adds ~200 transitive
//! crates and roughly doubles cold-compile time; the default build uses
//! the lighter [`system-tor`](super::profile::Route::SystemTor) /
//! [`custom-proxy`](super::profile::Route::Custom) routes instead.
//!
//! When the feature is enabled the module:
//! 1. Boots an `arti-client` `TorClient` lazily on first use.
//! 2. Spawns a local SOCKS5 listener on `127.0.0.1:<ephemeral>` that
//!    dispatches every connection through the client.
//! 3. Stores the listening port in `BUNDLED_PORT` so
//!    [`super::transport::build_client`] finds it automatically.
//!
//! State (the Tor consensus, descriptor cache, guards) lives under
//! `~/.sunny/browser/tor/`. That keeps our footprint self-contained and
//! honours the "no traffic in ~/.sunny other than ours" principle.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

static BUNDLED_PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Debug, Clone, serde::Serialize)]
pub struct TorStatus {
    pub bootstrapped: bool,
    pub progress: u8,
    pub socks_port: Option<u16>,
    pub last_error: Option<String>,
    pub source: &'static str,
}

pub fn bundled_socks_port() -> Option<u16> {
    let p = BUNDLED_PORT.load(Ordering::Relaxed);
    if p == 0 {
        None
    } else {
        Some(p)
    }
}

#[cfg(feature = "bundled-tor")]
use arti_client::{TorClient, TorClientConfig};
#[cfg(feature = "bundled-tor")]
use tokio::net::TcpListener;
#[cfg(feature = "bundled-tor")]
use tor_rtcompat::PreferredRuntime;

#[cfg(feature = "bundled-tor")]
type ClientHandle = TorClient<PreferredRuntime>;

#[cfg(feature = "bundled-tor")]
fn client_slot() -> &'static tokio::sync::OnceCell<ClientHandle> {
    static CELL: OnceLock<tokio::sync::OnceCell<ClientHandle>> = OnceLock::new();
    CELL.get_or_init(tokio::sync::OnceCell::new)
}

#[cfg(feature = "bundled-tor")]
fn state_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    let dir = home.join(".sunny").join("browser").join("tor");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir tor state: {e}"))?;
    Ok(dir)
}

pub async fn bootstrap() -> Result<TorStatus, String> {
    #[cfg(feature = "bundled-tor")]
    {
        if let Some(port) = bundled_socks_port() {
            return Ok(TorStatus {
                bootstrapped: true,
                progress: 100,
                socks_port: Some(port),
                last_error: None,
                source: "arti",
            });
        }

        let state = state_dir()?;
        let cache = state.join("cache");
        std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir tor cache: {e}"))?;

        let mut cfg = TorClientConfig::builder();
        cfg.storage()
            .state_dir(arti_client::config::CfgPath::new_literal(state.clone()))
            .cache_dir(arti_client::config::CfgPath::new_literal(cache));
        let cfg = cfg
            .build()
            .map_err(|e| format!("arti config: {e}"))?;

        let client = TorClient::create_bootstrapped(cfg)
            .await
            .map_err(|e| format!("arti bootstrap: {e}"))?;

        // Intentionally fail loudly if another task beat us to
        // initialization — we should only boot arti once per process.
        client_slot()
            .set(client.clone())
            .map_err(|_| "arti client already initialized".to_string())?;

        let listener = TcpListener::bind(("127.0.0.1", 0u16))
            .await
            .map_err(|e| format!("arti socks bind: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("arti socks addr: {e}"))?
            .port();
        BUNDLED_PORT.store(port, Ordering::Relaxed);

        // Spawn the SOCKS5 acceptor. The loop hands each connection to a
        // per-task handler that talks to the Tor client directly. The
        // handler is minimal — a full SOCKS5 implementation lives in
        // the `arti` binary crate, but for our reqwest use case we only
        // need CONNECT + user/password-less auth.
        let client_for_loop = client.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((sock, _)) => {
                        let c = client_for_loop.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_socks_connection(c, sock).await {
                                log::debug!("arti socks conn: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        log::warn!("arti socks accept: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                }
            }
        });

        log::info!("bundled Tor ready on 127.0.0.1:{port}");
        Ok(TorStatus {
            bootstrapped: true,
            progress: 100,
            socks_port: Some(port),
            last_error: None,
            source: "arti",
        })
    }

    #[cfg(not(feature = "bundled-tor"))]
    {
        Err("bundled Tor is a cargo feature. Rebuild with `--features bundled-tor`, or use the system Tor route (install via `brew install tor && brew services start tor`).".into())
    }
}

#[cfg(feature = "bundled-tor")]
async fn handle_socks_connection(
    client: ClientHandle,
    mut sock: tokio::net::TcpStream,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = [0u8; 512];

    // SOCKS5 greeting: VER=5, NMETHODS, METHODS[..]
    let n = sock
        .read(&mut buf)
        .await
        .map_err(|e| format!("read greeting: {e}"))?;
    if n < 2 || buf[0] != 0x05 {
        return Err("not SOCKS5".into());
    }
    // No auth.
    sock.write_all(&[0x05, 0x00])
        .await
        .map_err(|e| format!("write method: {e}"))?;

    // Request: VER=5, CMD=1 (CONNECT), RSV=0, ATYP, DST.ADDR, DST.PORT
    let n = sock
        .read(&mut buf)
        .await
        .map_err(|e| format!("read req: {e}"))?;
    if n < 7 || buf[0] != 0x05 || buf[1] != 0x01 {
        let _ = sock.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err("unsupported SOCKS request".into());
    }

    let atyp = buf[3];
    let (host, port_offset): (String, usize) = match atyp {
        0x01 => {
            // IPv4
            if n < 10 {
                return Err("truncated ipv4 request".into());
            }
            (
                format!("{}.{}.{}.{}", buf[4], buf[5], buf[6], buf[7]),
                8,
            )
        }
        0x03 => {
            // Domain: length-prefixed
            let len = buf[4] as usize;
            if n < 5 + len + 2 {
                return Err("truncated domain request".into());
            }
            let host = std::str::from_utf8(&buf[5..5 + len])
                .map_err(|e| format!("utf8 host: {e}"))?
                .to_string();
            (host, 5 + len)
        }
        0x04 => {
            // IPv6 — arti handles it, but synthesize a literal for the
            // dial string.
            if n < 22 {
                return Err("truncated ipv6 request".into());
            }
            use std::net::Ipv6Addr;
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&buf[4..20]);
            (Ipv6Addr::from(octets).to_string(), 20)
        }
        _ => {
            let _ = sock.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err(format!("bad atyp: {atyp}"));
        }
    };

    if n < port_offset + 2 {
        return Err("truncated port".into());
    }
    let port = u16::from_be_bytes([buf[port_offset], buf[port_offset + 1]]);

    // Connect via Tor.
    let stream = match client.connect((host.as_str(), port)).await {
        Ok(s) => s,
        Err(e) => {
            let _ = sock.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err(format!("tor connect {host}:{port}: {e}"));
        }
    };

    // Success reply. We lie about the bound address — it's only informational.
    sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| format!("write reply: {e}"))?;

    // Splice.
    let (mut sock_r, mut sock_w) = sock.into_split();
    let (mut tor_r, mut tor_w) = tokio::io::split(stream);
    let c2t = tokio::io::copy(&mut sock_r, &mut tor_w);
    let t2c = tokio::io::copy(&mut tor_r, &mut sock_w);
    let _ = tokio::join!(c2t, t2c);
    Ok(())
}

pub fn status() -> TorStatus {
    TorStatus {
        bootstrapped: bundled_socks_port().is_some(),
        progress: if bundled_socks_port().is_some() { 100 } else { 0 },
        socks_port: bundled_socks_port(),
        last_error: None,
        source: if cfg!(feature = "bundled-tor") {
            "arti"
        } else {
            "system"
        },
    }
}

pub async fn new_circuit() -> Result<(), String> {
    #[cfg(feature = "bundled-tor")]
    {
        if let Some(c) = client_slot().get() {
            // arti exposes circuit isolation via retire_all_circs().
            c.retire_all_circs();
            return Ok(());
        }
        return Err("bundled Tor not bootstrapped yet".into());
    }
    #[cfg(not(feature = "bundled-tor"))]
    {
        Err("new_circuit requires --features bundled-tor".into())
    }
}

pub fn shutdown() {
    BUNDLED_PORT.store(0, Ordering::Relaxed);
}
