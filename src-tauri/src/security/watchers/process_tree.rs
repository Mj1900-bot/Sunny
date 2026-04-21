//! Sunny-descendant process tree watcher.
//!
//! Polls `sysinfo` every 10 s and maintains the set of PIDs that
//! descend from Sunny's root process.  Any new descendant we haven't
//! seen before is emitted as a `Notice`, and the codesign tripwire
//! is fired for its executable path so unsigned children land as
//! `UnsignedBinary` events.
//!
//! This is the live, hot-path complement to
//! `watchers/launch_agents.rs`: LaunchAgents catches disk-level
//! persistence, this catches in-memory process spawns (the classic
//! "agent shells out `curl | bash`" vector).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::AppHandle;
use ts_rs::TS;

use crate::security::{self, SecurityEvent, Severity};

const POLL_INTERVAL: Duration = Duration::from_secs(10);

fn state() -> &'static Mutex<ProcessWatcher> {
    static CELL: OnceLock<Mutex<ProcessWatcher>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(ProcessWatcher::default()))
}

#[derive(Default)]
struct ProcessWatcher {
    seen: HashSet<u32>,
    last_snapshot: Vec<DescendantProcess>,
    initialised: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct DescendantProcess {
    #[ts(type = "number")]
    pub pid: u32,
    #[ts(type = "number")]
    pub parent_pid: u32,
    pub name: String,
    pub exe: String,
    pub cmd: String,
}

pub fn start(_app: AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        loop {
            ticker.tick().await;
            poll_once();
        }
    });
}

fn poll_once() {
    let root = std::process::id();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    // Build parent → children map once so the DFS is cheap.
    let mut children_of: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        if let Some(ppid) = proc.parent() {
            children_of.entry(ppid.as_u32()).or_default().push(pid.as_u32());
        }
    }

    // DFS from root, collecting every descendant.
    let mut stack = vec![root];
    let mut seen_now: HashSet<u32> = HashSet::new();
    while let Some(pid) = stack.pop() {
        for &child in children_of.get(&pid).unwrap_or(&Vec::new()) {
            if seen_now.insert(child) {
                stack.push(child);
            }
        }
    }

    let mut descendants: Vec<DescendantProcess> = Vec::new();
    for pid_u in seen_now.iter().copied() {
        if let Some(proc) = sys.process(Pid::from_u32(pid_u)) {
            let parent = proc.parent().map(|p| p.as_u32()).unwrap_or(0);
            let name = proc.name().to_string_lossy().to_string();
            let exe = proc.exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let cmd: String = proc
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(" ");
            descendants.push(DescendantProcess { pid: pid_u, parent_pid: parent, name, exe, cmd });
        }
    }
    descendants.sort_by_key(|p| p.pid);

    let mut newly_seen: Vec<DescendantProcess> = Vec::new();
    let vanished: Vec<u32>;
    let initial_pass: bool;
    {
        let Ok(mut guard) = state().lock() else { return };
        initial_pass = !guard.initialised;
        for proc in descendants.iter() {
            if !guard.seen.contains(&proc.pid) {
                newly_seen.push(proc.clone());
            }
        }
        // Detect vanished = pids previously seen but not in current.
        let current_set: HashSet<u32> = descendants.iter().map(|p| p.pid).collect();
        vanished = guard
            .seen
            .iter()
            .copied()
            .filter(|pid| !current_set.contains(pid))
            .collect();

        guard.seen = current_set;
        guard.last_snapshot = descendants.clone();
        guard.initialised = true;
    }

    // First sweep establishes the baseline; don't emit per-proc
    // events for the set that was already running at app launch.
    if initial_pass {
        security::emit(SecurityEvent::Notice {
            at: security::now(),
            source: "process_tree".into(),
            message: format!("baseline: {} descendant process(es)", newly_seen.len()),
            severity: Severity::Info,
        });
        return;
    }

    for proc in newly_seen.iter() {
        security::emit(SecurityEvent::Notice {
            at: security::now(),
            source: "process_tree".into(),
            message: format!("spawned pid={} {} — {}", proc.pid, proc.name, short_cmd(&proc.cmd)),
            severity: Severity::Info,
        });
        // Fire the codesign tripwire on the executable if we have
        // one — unsigned binaries spawned by Sunny are interesting.
        if !proc.exe.is_empty() {
            security::watchers::codesign::probe(
                &proc.exe,
                &format!("process_tree:spawned pid={}", proc.pid),
            );
        }
    }
    for pid in vanished {
        security::emit(SecurityEvent::Notice {
            at: security::now(),
            source: "process_tree".into(),
            message: format!("vanished pid={pid}"),
            severity: Severity::Info,
        });
    }
}

fn short_cmd(s: &str) -> String {
    if s.len() <= 140 {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(137).collect();
        out.push('…');
        out
    }
}

/// Snapshot of currently-tracked descendants for the SYSTEM tab.
pub fn snapshot() -> Vec<DescendantProcess> {
    state().lock().map(|g| g.last_snapshot.clone()).unwrap_or_default()
}
