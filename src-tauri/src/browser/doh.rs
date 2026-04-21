//! DNS-over-HTTPS resolver.
//!
//! `reqwest` normally asks the OS resolver (`getaddrinfo`) for every
//! hostname. On a coffee-shop Wi-Fi or a corporate network that leaks
//! every DNS lookup to whoever runs the resolver — ISP, sysadmin,
//! captive-portal operator. For profiles with DoH enabled we bypass the
//! system resolver entirely and POST a DNS wire-format query to a known
//! provider over TLS.
//!
//! This module implements the minimal DoH wire-format:
//!   * A single question (QNAME, QTYPE=A|AAAA, QCLASS=IN).
//!   * No EDNS, no authoritative section, no flags beyond RD=1.
//!   * HTTP POST with `Content-Type: application/dns-message`.
//!
//! We use a small-TTL LRU cache keyed by (host, want_v6) so a tab that
//! loads 50 images from the same host doesn't pay 50 round trips. The
//! cache is per-profile so separate profiles can't see each other's
//! lookups — this matters for the audit story as much as for correlation.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Client;

use crate::browser::profile::DohResolver;

/// One addressable resolution result. We keep `Vec<SocketAddr>` because
/// `hickory` and `reqwest::dns::Addrs` both prefer multi-address return
/// values — round-robin / happy-eyeballs happens upstream.
#[derive(Clone)]
struct Cached {
    addrs: Vec<SocketAddr>,
    expires_at: Instant,
}

/// Per-profile DoH cache. Keyed by `(profile_label, host, want_v6)` so
/// the same hostname resolved by two profiles doesn't cross-contaminate.
fn cache() -> &'static Mutex<HashMap<(String, String, bool), Cached>> {
    static CELL: OnceLock<Mutex<HashMap<(String, String, bool), Cached>>> =
        OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

const CACHE_MIN_TTL: Duration = Duration::from_secs(60);
const CACHE_MAX_TTL: Duration = Duration::from_secs(60 * 30);

pub async fn resolve(
    profile_label: &str,
    host: &str,
    port: u16,
    resolver: DohResolver,
) -> Result<Vec<SocketAddr>, String> {
    // Cache hit?
    let v4_key = (profile_label.to_string(), host.to_ascii_lowercase(), false);
    let v6_key = (profile_label.to_string(), host.to_ascii_lowercase(), true);
    {
        let g = cache().lock().expect("doh cache poisoned");
        let now = Instant::now();
        let mut out: Vec<SocketAddr> = Vec::new();
        if let Some(c) = g.get(&v4_key) {
            if c.expires_at > now {
                out.extend(c.addrs.iter().map(|a| {
                    SocketAddr::new(a.ip(), port)
                }));
            }
        }
        if let Some(c) = g.get(&v6_key) {
            if c.expires_at > now {
                out.extend(c.addrs.iter().map(|a| {
                    SocketAddr::new(a.ip(), port)
                }));
            }
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }

    // Bootstrap: the resolver itself is a URL we need to reach. We cannot
    // DoH-resolve the DoH endpoint (chicken/egg), so we hard-code the
    // provider's anycast IPs and pass them to reqwest via a pre-resolved
    // connector. Cloudflare / Quad9 / Google all publish stable IPs that
    // haven't moved in a decade.
    let (url, bootstrap_ip) = match resolver {
        DohResolver::Cloudflare => ("https://1.1.1.1/dns-query", "1.1.1.1:443"),
        DohResolver::Quad9 => ("https://9.9.9.9/dns-query", "9.9.9.9:443"),
        DohResolver::Google => ("https://8.8.8.8/dns-query", "8.8.8.8:443"),
    };

    let client = doh_bootstrap_client(bootstrap_ip)?;

    let mut merged: Vec<SocketAddr> = Vec::new();
    let mut min_ttl = CACHE_MAX_TTL;

    // Ask for both A and AAAA — happy-eyeballs prefers v6 when available.
    for want_v6 in [false, true] {
        let query = build_query(host, want_v6)?;
        let req = client
            .post(url)
            .header("accept", "application/dns-message")
            .header("content-type", "application/dns-message")
            .body(query);
        let resp = req
            .send()
            .await
            .map_err(|e| format!("doh query {host}: {e}"))?;
        if !resp.status().is_success() {
            continue;
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("doh read {host}: {e}"))?;
        let parsed = parse_response(&bytes, want_v6).unwrap_or_default();
        if parsed.is_empty() {
            continue;
        }
        let ttl = parsed
            .iter()
            .map(|(_, t)| *t)
            .min()
            .unwrap_or(Duration::from_secs(300));
        min_ttl = min_ttl.min(ttl.max(CACHE_MIN_TTL));
        let addrs: Vec<SocketAddr> = parsed
            .iter()
            .map(|(ip, _)| SocketAddr::new(*ip, port))
            .collect();
        merged.extend(addrs.iter().cloned());

        let key = (
            profile_label.to_string(),
            host.to_ascii_lowercase(),
            want_v6,
        );
        cache().lock().expect("doh cache poisoned").insert(
            key,
            Cached {
                addrs,
                expires_at: Instant::now() + min_ttl,
            },
        );
    }

    if merged.is_empty() {
        return Err(format!("DoH ({url}) returned no A/AAAA for {host}"));
    }
    Ok(merged)
}

/// Build a reqwest client that can reach the DoH provider itself without
/// recursing back through DoH. We pin the provider IP so this client
/// doesn't fall back to the system resolver.
fn doh_bootstrap_client(bootstrap_ip: &str) -> Result<Client, String> {
    let addr: SocketAddr = bootstrap_ip
        .parse()
        .map_err(|e| format!("bootstrap addr {bootstrap_ip}: {e}"))?;
    // reqwest exposes `resolve_to_addrs` — give it the provider host
    // pinned to this literal. All three providers accept the IP in the
    // URL so we also don't need DNS at all for this fetch.
    let host = bootstrap_ip.split(':').next().unwrap_or("1.1.1.1");
    Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .use_rustls_tls()
        .resolve_to_addrs(host, &[addr])
        .build()
        .map_err(|e| format!("doh bootstrap client: {e}"))
}

/// Construct a minimal DNS wire-format query.
fn build_query(host: &str, want_v6: bool) -> Result<Vec<u8>, String> {
    // Transaction id — a random-ish u16. DoH recommends 0 to maximize
    // cache-hit rate across users (no per-query entropy), but a few
    // servers dislike 0. We use 0 to follow RFC 8484 advice.
    let txid: u16 = 0;
    let flags: u16 = 0x0100; // RD=1
    let qdcount: u16 = 1;
    let ancount: u16 = 0;
    let nscount: u16 = 0;
    let arcount: u16 = 0;

    let mut q: Vec<u8> = Vec::with_capacity(32 + host.len());
    q.extend_from_slice(&txid.to_be_bytes());
    q.extend_from_slice(&flags.to_be_bytes());
    q.extend_from_slice(&qdcount.to_be_bytes());
    q.extend_from_slice(&ancount.to_be_bytes());
    q.extend_from_slice(&nscount.to_be_bytes());
    q.extend_from_slice(&arcount.to_be_bytes());

    for label in host.trim_end_matches('.').split('.') {
        if label.is_empty() {
            continue;
        }
        if label.len() > 63 {
            return Err(format!("label too long in {host}"));
        }
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0); // root terminator

    let qtype: u16 = if want_v6 { 28 } else { 1 }; // AAAA : A
    let qclass: u16 = 1; // IN
    q.extend_from_slice(&qtype.to_be_bytes());
    q.extend_from_slice(&qclass.to_be_bytes());
    Ok(q)
}

/// Parse the answer section. Returns `(IpAddr, TTL)` pairs whose RRTYPE
/// matches the expected family.
fn parse_response(
    bytes: &[u8],
    want_v6: bool,
) -> Result<Vec<(std::net::IpAddr, Duration)>, String> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    if bytes.len() < 12 {
        return Err("truncated DNS header".into());
    }
    // header: id(2), flags(2), qdcount(2), ancount(2), nscount(2), arcount(2)
    let ancount = u16::from_be_bytes([bytes[6], bytes[7]]) as usize;
    if ancount == 0 {
        return Ok(Vec::new());
    }

    // Skip the question section.
    let mut idx = 12usize;
    // question: QNAME, QTYPE(2), QCLASS(2)
    let after_qname = skip_name(bytes, idx)?;
    idx = after_qname + 4;

    let mut out = Vec::with_capacity(ancount);
    for _ in 0..ancount {
        if idx >= bytes.len() {
            break;
        }
        // NAME (compressed pointer or labels) + TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2)
        let after_name = skip_name(bytes, idx)?;
        if after_name + 10 > bytes.len() {
            break;
        }
        let rtype = u16::from_be_bytes([bytes[after_name], bytes[after_name + 1]]);
        let ttl = u32::from_be_bytes([
            bytes[after_name + 4],
            bytes[after_name + 5],
            bytes[after_name + 6],
            bytes[after_name + 7],
        ]);
        let rdlen = u16::from_be_bytes([bytes[after_name + 8], bytes[after_name + 9]])
            as usize;
        let rdstart = after_name + 10;
        if rdstart + rdlen > bytes.len() {
            break;
        }
        let rdata = &bytes[rdstart..rdstart + rdlen];
        let ttl_d = Duration::from_secs(ttl as u64);
        if !want_v6 && rtype == 1 && rdata.len() == 4 {
            out.push((
                IpAddr::V4(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3])),
                ttl_d,
            ));
        } else if want_v6 && rtype == 28 && rdata.len() == 16 {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(rdata);
            out.push((IpAddr::V6(Ipv6Addr::from(octets)), ttl_d));
        }
        idx = rdstart + rdlen;
    }
    Ok(out)
}

/// Walk a DNS name (length-prefixed labels, optionally terminated by a
/// compression pointer). Returns the offset immediately after the name.
fn skip_name(bytes: &[u8], mut idx: usize) -> Result<usize, String> {
    loop {
        if idx >= bytes.len() {
            return Err("name runs off end".into());
        }
        let b = bytes[idx];
        if b == 0 {
            return Ok(idx + 1);
        }
        // Top two bits set == compression pointer (2 bytes).
        if b & 0xC0 == 0xC0 {
            return Ok(idx + 2);
        }
        idx += 1 + b as usize;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_for_www_example_com_has_expected_shape() {
        let q = build_query("www.example.com", false).unwrap();
        // len(3) w w w len(7) e x a m p l e len(3) c o m 0
        // + txid(2) flags(2) qd(2) an(2) ns(2) ar(2) qtype(2) qclass(2)
        assert_eq!(q.len(), 12 + 1 + 3 + 1 + 7 + 1 + 3 + 1 + 4);
        // flags RD=1
        assert_eq!(q[2], 0x01);
        assert_eq!(q[3], 0x00);
        // qtype = A
        let qtype_off = q.len() - 4;
        assert_eq!(q[qtype_off + 1], 0x01);
    }

    #[test]
    fn query_for_aaaa_sets_qtype_28() {
        let q = build_query("example.com", true).unwrap();
        let qtype_off = q.len() - 4;
        assert_eq!(q[qtype_off], 0x00);
        assert_eq!(q[qtype_off + 1], 28);
    }

    #[test]
    fn rejects_oversized_label() {
        let big = "a".repeat(64);
        assert!(build_query(&big, false).is_err());
    }
}
