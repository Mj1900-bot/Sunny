//! Active network connection snapshot for the Sunny process.
//!
//! Shells out to `lsof -iP -n -a -p <pid>` and parses the tabular
//! output into a structured list the SYSTEM tab can render.  The
//! call is cheap enough (~40 ms on an M-series Mac) to run on
//! demand; we don't poll — the UI re-fetches when the tab is visible.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct Connection {
    pub protocol: String,   // TCP / UDP
    pub local: String,      // 127.0.0.1:58321
    pub remote: String,     // api.anthropic.com:443  (or "*:*" for listen)
    pub state: String,      // ESTABLISHED / LISTEN / CLOSE_WAIT / ...
    pub fd: String,         // lsof FD column (e.g. 27u)
}

pub async fn snapshot() -> Vec<Connection> {
    let pid = std::process::id().to_string();
    let fat = crate::paths::fat_path().unwrap_or_default();
    let fut = Command::new("/usr/sbin/lsof")
        .args(["-iP", "-n", "-a", "-p", &pid])
        .env("PATH", fat)
        .output();
    let Ok(Ok(out)) = timeout(PROBE_TIMEOUT, fut).await else {
        return Vec::new();
    };
    if !out.status.success() && out.stdout.is_empty() {
        return Vec::new();
    }
    let body = String::from_utf8_lossy(&out.stdout);
    parse(&body)
}

fn parse(body: &str) -> Vec<Connection> {
    // lsof -iP -n -a -p <pid> output shape:
    // COMMAND   PID    USER   FD   TYPE  DEVICE  SIZE/OFF NODE  NAME
    // sunny      1234   me     24u  IPv4  …       0t0      TCP   127.0.0.1:58321->127.0.0.1:11434 (ESTABLISHED)
    let mut out = Vec::new();
    for line in body.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 { continue; }
        let fd = cols[3].to_string();
        let proto = cols[7].to_string(); // NODE column = TCP / UDP / IPv4
        let name_part = cols[8..].join(" ");
        let (endpoints, state) = split_name(&name_part);
        let (local, remote) = split_endpoints(&endpoints);
        out.push(Connection {
            protocol: proto,
            local,
            remote,
            state,
            fd,
        });
    }
    out
}

fn split_name(name: &str) -> (String, String) {
    // Format: "127.0.0.1:58321->api.anthropic.com:443 (ESTABLISHED)"
    // Listen sockets: "*:58321 (LISTEN)"
    if let Some(idx) = name.rfind(" (") {
        let endpoints = &name[..idx];
        let state = &name[idx + 2..];
        let state = state.trim_end_matches(')');
        return (endpoints.to_string(), state.to_string());
    }
    (name.to_string(), String::new())
}

fn split_endpoints(ep: &str) -> (String, String) {
    if let Some((l, r)) = ep.split_once("->") {
        (l.to_string(), r.to_string())
    } else {
        (ep.to_string(), "*:*".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_established_row() {
        let body = "COMMAND  PID USER FD TYPE DEVICE SIZE NODE NAME\n\
                    sunny    1234 me  24u IPv4 0x1    0t0  TCP  127.0.0.1:58321->127.0.0.1:11434 (ESTABLISHED)";
        let v = parse(body);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].protocol, "TCP");
        assert_eq!(v[0].local, "127.0.0.1:58321");
        assert_eq!(v[0].remote, "127.0.0.1:11434");
        assert_eq!(v[0].state, "ESTABLISHED");
    }

    #[test]
    fn parse_listen_row() {
        let body = "COMMAND  PID USER FD TYPE DEVICE SIZE NODE NAME\n\
                    sunny    1234 me   8u IPv6 0x2    0t0  TCP  *:58333 (LISTEN)";
        let v = parse(body);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].state, "LISTEN");
        assert_eq!(v[0].local, "*:58333");
    }
}
