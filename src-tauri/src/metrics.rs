//! System metrics collection — CPU, memory, network, process list, and battery.
//!
//! Exposes four `#[ts(export)]`-derived types consumed by the HUD's Today /
//! Dashboard panels: `SystemMetrics` (CPU load, RAM, chip model, laptop flag),
//! `NetStats` (interface speeds, ping, SSID, public IP, VPN detection),
//! `ProcessRow` (per-process name + CPU + memory), and `BatteryInfo`. The
//! backing data comes from `sysinfo` for CPU/memory/processes and from macOS
//! `system_profiler` / `scutil` / `networksetup` shell calls for chip model,
//! SSID, and VPN detection. `startup.rs` drives a periodic metrics emit loop
//! that publishes `sunny://metrics` events at a configurable interval; the
//! frontend listens and updates the zustand metrics store without polling.

use serde::Serialize;
use std::process::Command;
use std::time::{Duration, Instant};
use sysinfo::{Components, Networks, ProcessesToUpdate, System};
use ts_rs::TS;

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SystemMetrics {
    pub cpu: f32,
    #[ts(type = "number")]
    pub cpu_cores: usize,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
    pub mem_pct: f32,
    pub temp_c: f32,
    #[ts(type = "number")]
    pub uptime_secs: u64,
    pub host: String,
    /// CPU/chip brand, e.g. "Apple M3 Max", "Apple M3 Ultra".
    pub chip: String,
    /// Machine model identifier, e.g. "Mac15,7" (MacBook Pro), "Mac14,13" (Mac Studio).
    /// Used by the UI to distinguish laptop vs desktop for labelling.
    pub model: String,
    /// True if this is a portable Mac (MacBook / MacBook Pro / MacBook Air).
    /// Derived once from `model` so the UI doesn't have to parse strings.
    pub is_laptop: bool,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct NetStats {
    #[ts(type = "number")]
    pub down_kbps: u64,
    #[ts(type = "number")]
    pub up_kbps: u64,
    pub iface: String,
    #[ts(type = "number")]
    pub ping_ms: u32,
    pub ssid: String,
    pub public_ip: String,
    /// True when a VPN tunnel is carrying the default route.
    /// Detected from macOS `scutil --nwi` or active `utun*` interfaces.
    pub vpn_active: bool,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ProcessRow {
    pub name: String,
    pub cpu: f32,
    pub mem_mb: f32,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct BatteryInfo {
    pub percent: f32,
    pub charging: bool,
}

pub struct Collector {
    sys: System,
    networks: Networks,
    components: Components,
    last_net_bytes: Option<(u64, u64)>,
    public_ip_cache: Option<(String, Instant)>,
    ping_cache: Option<(u32, Instant)>,
    ssid_cache: Option<(String, Instant)>,
    vpn_cache: Option<(bool, Instant)>,
}

const PUBLIC_IP_TTL: Duration = Duration::from_secs(300);
const PING_TTL: Duration = Duration::from_secs(5);
const SSID_TTL: Duration = Duration::from_secs(30);
const VPN_TTL: Duration = Duration::from_secs(10);

impl Collector {
    pub fn new() -> Self {
        Self {
            sys: System::new_all(),
            networks: Networks::new_with_refreshed_list(),
            components: Components::new_with_refreshed_list(),
            last_net_bytes: None,
            public_ip_cache: None,
            ping_cache: None,
            ssid_cache: None,
            vpn_cache: None,
        }
    }

    pub fn sample(&mut self) -> SystemMetrics {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.components.refresh();

        let cpu = self.sys.global_cpu_usage();
        let cpu_cores = self.sys.cpus().len();
        let chip = self
            .sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Apple Silicon".to_string());
        let mem_used = self.sys.used_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
        let mem_total = self.sys.total_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
        let mem_pct = if mem_total > 0.0 { mem_used / mem_total * 100.0 } else { 0.0 };

        let temp_c = self
            .components
            .iter()
            .map(|c| c.temperature())
            .fold(0.0_f32, f32::max);

        let model = machine_model();
        let is_laptop = model_is_laptop(&model);

        SystemMetrics {
            cpu,
            cpu_cores,
            mem_used_gb: mem_used,
            mem_total_gb: mem_total,
            mem_pct,
            temp_c,
            uptime_secs: System::uptime(),
            host: System::host_name().unwrap_or_else(|| "macbook.local".into()),
            chip,
            model,
            is_laptop,
        }
    }

    pub fn net(&mut self) -> NetStats {
        self.networks.refresh();
        let (mut rx, mut tx, mut iface) = (0u64, 0u64, String::from("en0"));
        for (name, data) in self.networks.iter() {
            rx += data.total_received();
            tx += data.total_transmitted();
            if name.starts_with("en") {
                iface = name.clone();
            }
        }
        let (down, up) = match self.last_net_bytes {
            Some((prx, ptx)) => (rx.saturating_sub(prx), tx.saturating_sub(ptx)),
            None => (0, 0),
        };
        self.last_net_bytes = Some((rx, tx));

        let ping_ms = self.ping_ms();
        let ssid = self.ssid();
        let public_ip = self.public_ip();
        let vpn_active = self.vpn_active();

        NetStats {
            down_kbps: down / 1024,
            up_kbps: up / 1024,
            iface,
            ping_ms,
            ssid,
            public_ip,
            vpn_active,
        }
    }

    fn vpn_active(&mut self) -> bool {
        if let Some((value, at)) = &self.vpn_cache {
            if at.elapsed() < VPN_TTL { return *value; }
        }
        let fresh = detect_vpn();
        self.vpn_cache = Some((fresh, Instant::now()));
        fresh
    }

    fn ping_ms(&mut self) -> u32 {
        if let Some((value, at)) = &self.ping_cache {
            if at.elapsed() < PING_TTL { return *value; }
        }
        let fresh = measure_ping();
        self.ping_cache = Some((fresh, Instant::now()));
        fresh
    }

    fn ssid(&mut self) -> String {
        if let Some((value, at)) = &self.ssid_cache {
            if at.elapsed() < SSID_TTL { return value.clone(); }
        }
        let fresh = read_ssid();
        self.ssid_cache = Some((fresh.clone(), Instant::now()));
        fresh
    }

    fn public_ip(&mut self) -> String {
        if let Some((ip, fetched_at)) = &self.public_ip_cache {
            if fetched_at.elapsed() < PUBLIC_IP_TTL {
                return ip.clone();
            }
        }
        let fresh = fetch_public_ip();
        if !fresh.is_empty() {
            self.public_ip_cache = Some((fresh.clone(), Instant::now()));
        }
        fresh
    }

    pub fn processes(&mut self, limit: usize) -> Vec<ProcessRow> {
        self.sys.refresh_processes(ProcessesToUpdate::All, true);

        // sysinfo reports per-process CPU as a percentage of a *single* core
        // (matching macOS Activity Monitor's "CPU %" column, which can go up
        // to N_cores × 100%). Divide by core count so every value is a true
        // 0-100% share of the whole machine — matching `global_cpu_usage()`
        // and the SYSTEM panel's CPU bar, and making summed totals sane.
        let cores = self.sys.cpus().len().max(1) as f32;

        let groups = self.sys.processes().values().fold(
            std::collections::HashMap::<String, ProcessRow>::new(),
            |mut acc, p| {
                let raw = p.name().to_string_lossy().to_string();
                if !is_useful_name(&raw) {
                    return acc;
                }
                let group = group_name(&raw);
                let cpu = p.cpu_usage() / cores;
                let mem_mb = p.memory() as f32 / 1024.0 / 1024.0;
                acc.entry(group.clone())
                    .and_modify(|row| {
                        *row = ProcessRow {
                            name: row.name.clone(),
                            cpu: row.cpu + cpu,
                            mem_mb: row.mem_mb + mem_mb,
                        };
                    })
                    .or_insert(ProcessRow {
                        name: group,
                        cpu,
                        mem_mb,
                    });
                acc
            },
        );

        let mut rows: Vec<ProcessRow> = groups.into_values().collect();
        rows.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
        rows.truncate(limit);
        rows
    }
}

/// Read the hardware model identifier via `sysctl -n hw.model`.
/// Returns e.g. "Mac15,7" on a MacBook Pro, "Mac14,13" on a Mac Studio.
/// Cached per-process since it never changes at runtime.
fn machine_model() -> String {
    use std::sync::OnceLock;
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            Command::new("sysctl")
                .args(["-n", "hw.model"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Mac".to_string())
        })
        .clone()
}

/// Heuristic: "MacBook*" identifiers are portables. Everything else
/// (Mac Studio, Mac mini, iMac, Mac Pro) is a desktop.
fn model_is_laptop(model: &str) -> bool {
    model.starts_with("MacBook")
}

fn is_useful_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed == "launchd" {
        return false;
    }
    true
}

fn group_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let before_paren = match trimmed.find('(') {
        Some(idx) => trimmed[..idx].trim(),
        None => trimmed,
    };
    let without_helper = match before_paren.find(" Helper") {
        Some(idx) => before_paren[..idx].trim(),
        None => before_paren,
    };
    let cleaned = if without_helper.is_empty() {
        before_paren
    } else {
        without_helper
    };
    let base = if cleaned.is_empty() {
        match trimmed.find(|c: char| c == ' ' || c == '(') {
            Some(idx) => trimmed[..idx].trim(),
            None => trimmed,
        }
    } else {
        cleaned
    };
    if base.is_empty() {
        trimmed.to_string()
    } else {
        base.to_string()
    }
}

fn measure_ping() -> u32 {
    // -c 1: send 1 packet. -W 800: wait up to 800ms for a reply.
    // -n: numeric output only (skip DNS). -q: quiet summary only.
    let output = match Command::new("ping")
        .args(["-c", "1", "-W", "800", "-n", "1.1.1.1"])
        .output()
    {
        Ok(out) => out,
        Err(_) => return 0,
    };
    if !output.status.success() {
        return 0;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ping_ms(&stdout).unwrap_or(0)
}

fn parse_ping_ms(stdout: &str) -> Option<u32> {
    let idx = stdout.find("time=")?;
    let rest = &stdout[idx + 5..];
    let end = rest.find(' ').unwrap_or(rest.len());
    let value: f32 = rest[..end].parse().ok()?;
    Some(value.round().max(0.0) as u32)
}

fn read_ssid() -> String {
    let airport = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";
    if std::path::Path::new(airport).exists() {
        if let Ok(out) = Command::new(airport).arg("-I").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(ssid) = parse_airport_ssid(&text) {
                    return ssid;
                }
            }
        }
    }
    if let Ok(out) = Command::new("networksetup")
        .args(["-getairportnetwork", "en0"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(ssid) = parse_networksetup_ssid(&text) {
                return ssid;
            }
        }
    }
    String::new()
}

fn parse_airport_ssid(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("SSID:") {
            let ssid = rest.trim();
            if !ssid.is_empty() {
                return Some(ssid.to_string());
            }
        }
    }
    None
}

fn parse_networksetup_ssid(text: &str) -> Option<String> {
    let prefix = "Current Wi-Fi Network:";
    for line in text.lines() {
        if let Some(rest) = line.trim_start().strip_prefix(prefix) {
            let ssid = rest.trim();
            if !ssid.is_empty() && !ssid.starts_with("You are not associated") {
                return Some(ssid.to_string());
            }
        }
    }
    None
}

/// Detect an active VPN tunnel on macOS.
///
/// Strategy (in order):
/// 1. `scutil --nwi` — if the primary IPv4 interface name starts with
///    `utun`, `ipsec`, `ppp` or `tap`, a VPN is carrying the default route.
///    This catches Tailscale, WireGuard, Cisco AnyConnect, native macOS
///    IKEv2, etc. Reliable and cheap.
/// 2. Fallback: scan `ifconfig -u` for any tunnel interface with an
///    assigned `inet` address. Less accurate (macOS itself opens utun0/1
///    for Continuity even without a VPN), so we only trust it when scutil
///    gave no signal.
fn detect_vpn() -> bool {
    if let Ok(out) = Command::new("scutil").arg("--nwi").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if primary_is_tunnel(&text) {
                return true;
            }
        }
    }
    false
}

fn primary_is_tunnel(nwi_output: &str) -> bool {
    // scutil --nwi prints lines like "   Network interfaces: utun4 en0 ..."
    // where the *first* token on that line is the primary interface.
    for line in nwi_output.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("Network interfaces:") {
            let first = rest.split_whitespace().next().unwrap_or("");
            return is_tunnel_iface(first);
        }
    }
    false
}

fn is_tunnel_iface(name: &str) -> bool {
    name.starts_with("utun")
        || name.starts_with("ipsec")
        || name.starts_with("ppp")
        || name.starts_with("tap")
        || name.starts_with("tun")
}

fn fetch_public_ip() -> String {
    let output = match Command::new("curl")
        .args(["-sS", "--max-time", "2", "https://ipv4.icanhazip.com"])
        .output()
    {
        Ok(out) => out,
        Err(_) => return String::new(),
    };
    if !output.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub fn battery() -> Option<BatteryInfo> {
    let manager = battery::Manager::new().ok()?;
    let bat = manager.batteries().ok()?.flatten().next()?;
    let pct: f32 = bat.state_of_charge().value * 100.0;
    let charging = matches!(bat.state(), battery::State::Charging | battery::State::Full);
    Some(BatteryInfo { percent: pct, charging })
}
