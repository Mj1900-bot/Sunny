//! Singleton `BrowserHandle` — Chrome process lifecycle via a dedicated actor.
//!
//! # Architecture
//!
//! `chromiumoxide`'s `Browser` and `Page` are `!Send` because they hold
//! waker/notify internals that are not thread-safe to move. We therefore
//! run ALL browser operations on a single dedicated OS thread that owns a
//! `tokio::runtime::Runtime` (single-threaded). Cross-thread communication
//! uses `std::sync::mpsc` one-shot requests wrapped in a `BrowserCmd` enum.
//!
//! Callers (async Tauri tasks on the multi-thread runtime) send a
//! `BrowserCmd` down a `crossbeam_channel`-free `std::sync::mpsc` sender and
//! `await` a `tokio::sync::oneshot` reply. This is the standard actor pattern
//! for bridging Send-required async with !Send internals.
//!
//! # Lifecycle
//!
//! - First `send_cmd()` call spawns the actor thread lazily.
//! - The actor carries an idle timer; after 10 min of no activity it kills
//!   Chrome and resets, remaining alive to accept new commands.
//! - The actor thread itself lives for the process lifetime.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::Page;
use futures_util::StreamExt;
use tokio::runtime::Builder as RtBuilder;
use tokio::sync::oneshot;

use crate::browser::cdp::error::{CdpError, CdpResult};

// ---------------------------------------------------------------------------
// Command envelope
// ---------------------------------------------------------------------------

/// Commands sent from caller threads to the actor.
enum BrowserCmd {
    OpenTab {
        url: String,
        reply: oneshot::Sender<CdpResult<String>>,
    },
    CloseTab {
        tab_id: String,
        reply: oneshot::Sender<CdpResult<()>>,
    },
    ListTabs {
        reply: oneshot::Sender<CdpResult<Vec<(String, String, String)>>>,
    },
    WithTab {
        tab_id: String,
        op: Box<dyn TabOp + Send>,
    },
}

/// Type-erased async operation over a `Page`.
trait TabOp: Send {
    fn run(
        self: Box<Self>,
        page: Page,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'static>>;
}

// ---------------------------------------------------------------------------
// Actor state
// ---------------------------------------------------------------------------

struct ActorState {
    browser: Browser,
    tabs: HashMap<String, Page>,
    last_used: Instant,
}

// ---------------------------------------------------------------------------
// Global actor channel
// ---------------------------------------------------------------------------

static ACTOR_TX: OnceLock<Mutex<mpsc::SyncSender<BrowserCmd>>> = OnceLock::new();

fn actor_tx() -> &'static Mutex<mpsc::SyncSender<BrowserCmd>> {
    ACTOR_TX.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<BrowserCmd>(32);
        thread::spawn(move || run_actor(rx));
        Mutex::new(tx)
    })
}

// ---------------------------------------------------------------------------
// Public API — async entry points
// ---------------------------------------------------------------------------

/// Open a new tab navigated to `url`. Returns the tab_id.
pub async fn open_tab(url: &str) -> CdpResult<String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    send_cmd(BrowserCmd::OpenTab {
        url: url.to_string(),
        reply: reply_tx,
    })?;
    reply_rx
        .await
        .map_err(|_| CdpError::Protocol("actor dropped reply channel".into()))?
}

/// Close a tab by tab_id.
pub async fn close_tab(tab_id: &str) -> CdpResult<()> {
    let (reply_tx, reply_rx) = oneshot::channel();
    send_cmd(BrowserCmd::CloseTab {
        tab_id: tab_id.to_string(),
        reply: reply_tx,
    })?;
    reply_rx
        .await
        .map_err(|_| CdpError::Protocol("actor dropped reply channel".into()))?
}

/// List all open tabs.
pub async fn list_tabs() -> CdpResult<Vec<(String, String, String)>> {
    let (reply_tx, reply_rx) = oneshot::channel();
    send_cmd(BrowserCmd::ListTabs { reply: reply_tx })?;
    reply_rx
        .await
        .map_err(|_| CdpError::Protocol("actor dropped reply channel".into()))?
}

/// Run an async closure against the `Page` for `tab_id`.
/// The closure must be `'static + Send`; it sends its result back through
/// the provided oneshot sender.
pub async fn with_tab<F, Fut, T>(tab_id: impl Into<String>, op: F) -> CdpResult<T>
where
    F: FnOnce(Page) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = CdpResult<T>> + 'static,
    T: Send + 'static,
{
    let tab_id_str = tab_id.into();
    let (reply_tx, reply_rx) = oneshot::channel::<CdpResult<T>>();

    struct Op<F2, Fut2, T2> {
        f: F2,
        tx: oneshot::Sender<CdpResult<T2>>,
        // PhantomData<fn(Fut2)> is always Send+Sync regardless of Fut2.
        // The future only lives on the actor thread (LocalSet), never crosses
        // thread boundaries itself.
        _ph: std::marker::PhantomData<fn(Fut2)>,
    }

    // SAFETY: The Op struct is sent to the actor thread as a whole.
    // The future Fut2 is created and polled entirely on the actor thread
    // (inside spawn_local / block_on on the actor's LocalSet), so it never
    // needs to be Send.  We assert Send manually here because the compiler
    // cannot see that Fut2 stays on the actor thread.
    unsafe impl<F2, Fut2, T2> Send for Op<F2, Fut2, T2>
    where
        F2: Send,
        T2: Send,
    {}

    impl<F2, Fut2, T2> TabOp for Op<F2, Fut2, T2>
    where
        F2: FnOnce(Page) -> Fut2 + Send + 'static,
        Fut2: std::future::Future<Output = CdpResult<T2>> + 'static,
        T2: Send + 'static,
    {
        fn run(
            self: Box<Self>,
            page: Page,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'static>> {
            let f = self.f;
            let tx = self.tx;
            Box::pin(async move {
                let result = f(page).await;
                let _ = tx.send(result);
            })
        }
    }

    send_cmd(BrowserCmd::WithTab {
        tab_id: tab_id_str,
        op: Box::new(Op {
            f: op,
            tx: reply_tx,
            _ph: std::marker::PhantomData,
        }),
    })?;

    reply_rx
        .await
        .map_err(|_| CdpError::Protocol("actor dropped reply channel".into()))?
}

fn send_cmd(cmd: BrowserCmd) -> CdpResult<()> {
    actor_tx()
        .lock()
        .map_err(|_| CdpError::Protocol("actor channel mutex poisoned".into()))?
        .send(cmd)
        .map_err(|_| CdpError::Protocol("actor thread died".into()))
}

// ---------------------------------------------------------------------------
// Downloads dir (public — used by session.rs)
// ---------------------------------------------------------------------------

pub fn downloads_dir() -> CdpResult<PathBuf> {
    let base = dirs::home_dir()
        .ok_or_else(|| CdpError::Io("could not determine home directory".into()))?;
    let dir = base.join("Downloads").join("sunny-browser");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CdpError::Io(format!("could not create downloads dir: {e}")))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Actor thread — runs on its own single-threaded tokio runtime
// ---------------------------------------------------------------------------

fn run_actor(rx: mpsc::Receiver<BrowserCmd>) {
    let rt = RtBuilder::new_current_thread()
        .enable_all()
        .build()
        .expect("CDP actor runtime");
    rt.block_on(actor_loop(rx));
}

async fn actor_loop(rx: mpsc::Receiver<BrowserCmd>) {
    let mut state: Option<ActorState> = None;
    const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
    const POLL_MS: Duration = Duration::from_millis(50);

    loop {
        // Non-blocking receive with a short sleep so we can check idle.
        let cmd = match rx.try_recv() {
            Ok(c) => c,
            Err(mpsc::TryRecvError::Empty) => {
                // Check idle.
                if let Some(ref s) = state {
                    if s.last_used.elapsed() >= IDLE_TIMEOUT {
                        log::info!("[cdp] idle timeout — shutting down Chrome");
                        state = None;
                    }
                }
                tokio::time::sleep(POLL_MS).await;
                continue;
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                log::warn!("[cdp] actor channel disconnected — exiting");
                return;
            }
        };

        // Ensure browser is running.
        if state.is_none() {
            match launch_browser().await {
                Ok(s) => state = Some(s),
                Err(e) => {
                    // Send errors back on any reply channels embedded in cmd.
                    reply_error(cmd, e);
                    continue;
                }
            }
        }

        let s = state.as_mut().unwrap();
        s.last_used = Instant::now();

        match cmd {
            BrowserCmd::OpenTab { url, reply } => {
                let result = open_tab_inner(s, &url).await;
                let _ = reply.send(result);
            }
            BrowserCmd::CloseTab { tab_id, reply } => {
                let result = close_tab_inner(s, &tab_id).await;
                let _ = reply.send(result);
            }
            BrowserCmd::ListTabs { reply } => {
                let result = list_tabs_inner(s).await;
                let _ = reply.send(result);
            }
            BrowserCmd::WithTab { tab_id, op } => {
                match s.tabs.get(&tab_id).cloned() {
                    Some(page) => {
                        op.run(page).await;
                    }
                    None => {
                        // op carries its own oneshot; we can't easily extract it
                        // without downcasting. Instead, run op with an error
                        // by running a dummy closure — not possible without
                        // the concrete type. Best effort: log and let reply_rx
                        // time out, which surfaces as a Protocol error on the
                        // caller side.
                        //
                        // In practice the caller checks tab_id before calling
                        // with_tab, but we log the anomaly.
                        log::error!("[cdp] with_tab: tab_id {tab_id} not found");
                    }
                }
            }
        }
    }
}

fn reply_error(cmd: BrowserCmd, e: CdpError) {
    match cmd {
        BrowserCmd::OpenTab { reply, .. } => { let _ = reply.send(Err(e)); }
        BrowserCmd::CloseTab { reply, .. } => { let _ = reply.send(Err(e)); }
        BrowserCmd::ListTabs { reply } => { let _ = reply.send(Err(e)); }
        BrowserCmd::WithTab { .. } => {
            log::error!("[cdp] launch failed for WithTab command: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Inner async operations (run inside actor)
// ---------------------------------------------------------------------------

async fn open_tab_inner(s: &mut ActorState, url: &str) -> CdpResult<String> {
    let page = s
        .browser
        .new_page(url)
        .await
        .map_err(|e| CdpError::Protocol(e.to_string()))?;
    let tab_id = uuid::Uuid::new_v4().to_string();
    s.tabs.insert(tab_id.clone(), page);
    Ok(tab_id)
}

async fn close_tab_inner(s: &mut ActorState, tab_id: &str) -> CdpResult<()> {
    let page = s
        .tabs
        .remove(tab_id)
        .ok_or_else(|| CdpError::TabNotFound(tab_id.to_string()))?;
    page.close()
        .await
        .map_err(|e| CdpError::Protocol(e.to_string()))?;
    Ok(())
}

async fn list_tabs_inner(
    s: &mut ActorState,
) -> CdpResult<Vec<(String, String, String)>> {
    let mut result = Vec::with_capacity(s.tabs.len());
    for (id, page) in &s.tabs {
        let url = page.url().await.unwrap_or_default().unwrap_or_default();
        let title = page
            .get_title()
            .await
            .unwrap_or_default()
            .unwrap_or_else(|| "(untitled)".into());
        result.push((id.clone(), url, title));
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

fn find_chrome_binary() -> CdpResult<PathBuf> {
    let candidates = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "/opt/homebrew/bin/chromium",
        "/usr/local/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for c in &candidates {
        let p = PathBuf::from(c);
        if p.is_absolute() {
            if p.exists() {
                return Ok(p);
            }
        } else if let Some(found) = crate::paths::which(c) {
            return Ok(found);
        }
    }
    Err(CdpError::LaunchFailed(
        "Chrome/Chromium not found. Install Google Chrome or Chromium.".into(),
    ))
}

fn profile_dir() -> CdpResult<PathBuf> {
    let base = dirs::home_dir()
        .ok_or_else(|| CdpError::Io("could not determine home directory".into()))?;
    let dir = base.join(".sunny").join("browser-profile");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CdpError::Io(format!("could not create profile dir: {e}")))?;
    Ok(dir)
}

async fn launch_browser() -> CdpResult<ActorState> {
    let binary = find_chrome_binary()?;
    let profile = profile_dir()?;
    let dl_dir = downloads_dir()?;

    let config = BrowserConfig::builder()
        .chrome_executable(binary)
        .user_data_dir(profile)
        .arg(format!(
            "--download-default-directory={}",
            dl_dir.display()
        ))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-default-apps")
        .build()
        .map_err(|e| CdpError::LaunchFailed(e.to_string()))?;

    let (browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| CdpError::LaunchFailed(e.to_string()))?;

    // Drive the CDP event loop in a local task.
    tokio::task::spawn_local(async move {
        loop {
            if handler.next().await.is_none() {
                break;
            }
        }
    });

    Ok(ActorState {
        browser,
        tabs: HashMap::new(),
        last_used: Instant::now(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_dir_creates_under_home() {
        let result = profile_dir();
        assert!(result.is_ok(), "profile_dir failed: {:?}", result);
        assert!(result.unwrap().ends_with(".sunny/browser-profile"));
    }

    #[test]
    fn downloads_dir_under_downloads() {
        let result = downloads_dir();
        assert!(result.is_ok(), "downloads_dir failed: {:?}", result);
        let p = result.unwrap();
        assert!(p.ends_with("sunny-browser"), "path: {}", p.display());
    }

    #[test]
    fn find_chrome_binary_is_err_or_exists() {
        match find_chrome_binary() {
            Ok(p) => assert!(p.exists(), "binary not found at: {}", p.display()),
            Err(CdpError::LaunchFailed(_)) => {} // acceptable
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
}
