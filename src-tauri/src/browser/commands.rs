//! `#[tauri::command]` wrappers for the browser module. Kept thin — all
//! real logic is in the submodules.

use serde_json::Value;
use tauri::AppHandle;

use crate::browser::audit::{self, AuditRecord};
use crate::browser::dispatcher::{self, FetchOptions};
use crate::browser::downloads::{self, DownloadJob, ProbeResult};
use crate::browser::media::{self, ExtractResult};
use crate::browser::profile::{ProfileId, ProfilePolicy, Route};
use crate::browser::reader::{self, ReaderExtract};
use crate::browser::research::{self, ResearchBrief};
use crate::browser::sandbox::{self, EmbedBounds, SandboxTab};
use crate::browser::storage::{self, Bookmark, HistoryEntry};
use crate::browser::transport;

// ---------- Profiles ----------

#[tauri::command]
pub fn browser_profiles_list() -> Vec<ProfilePolicy> {
    dispatcher::global().list_profiles()
}

#[tauri::command]
pub fn browser_profiles_get(id: String) -> Option<ProfilePolicy> {
    dispatcher::global().get_profile(&ProfileId(id))
}

#[tauri::command]
pub fn browser_profiles_upsert(policy: ProfilePolicy) -> Result<ProfilePolicy, String> {
    // Validate embedded proxy URLs before we accept the policy.
    if let Route::Custom { url } = &policy.route {
        transport::validate_proxy_url(url)?;
    }
    dispatcher::global().upsert_profile(policy.clone());
    Ok(policy)
}

#[tauri::command]
pub fn browser_profiles_remove(id: String) {
    dispatcher::global().remove_profile(&ProfileId(id));
}

#[tauri::command]
pub fn browser_kill_switch(armed: bool) {
    dispatcher::global().set_kill_switch(armed);
}

#[tauri::command]
pub fn browser_kill_switch_status() -> bool {
    dispatcher::global().kill_switch_armed()
}

/// Homograph / punycode detection. Returns the ASCII form of the host
/// when the URL looks suspicious so the frontend can render a warning.
/// `None` means "probably fine — don't warn".
#[tauri::command]
pub fn browser_url_is_deceptive(url: String) -> Option<String> {
    crate::browser::dispatcher::looks_deceptive(&url)
}

// ---------- Reader-mode fetch (replaces web_fetch_readable's transport) ----------

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct BrowserFetchResult {
    #[ts(type = "number")]
    pub status: u16,
    pub ok: bool,
    pub final_url: String,
    pub url: String,
    pub extract: ReaderExtract,
}

#[tauri::command]
pub async fn browser_fetch_readable(
    profile_id: String,
    url: String,
    tab_id: Option<String>,
) -> Result<BrowserFetchResult, String> {
    let disp = dispatcher::global();
    let pid = ProfileId(profile_id);
    let (status, final_url, body) = disp.fetch_text(&pid, &url, tab_id).await?;
    let extract = reader::extract(&body, &final_url);
    Ok(BrowserFetchResult {
        status,
        ok: (200..400).contains(&status),
        final_url,
        url,
        extract,
    })
}

// ---------- Bookmarks / history ----------

#[tauri::command]
pub fn browser_bookmarks_list(profile_id: String) -> Result<Vec<Bookmark>, String> {
    storage::list_bookmarks(&profile_id)
}

#[tauri::command]
pub fn browser_bookmarks_add(
    profile_id: String,
    title: String,
    url: String,
) -> Result<Bookmark, String> {
    storage::add_bookmark(&profile_id, &title, &url)
}

#[tauri::command]
pub fn browser_bookmarks_delete(profile_id: String, url: String) -> Result<(), String> {
    storage::delete_bookmark(&profile_id, &url)
}

#[tauri::command]
pub fn browser_history_list(
    profile_id: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    storage::list_history(&profile_id, limit.unwrap_or(200))
}

#[tauri::command]
pub fn browser_history_push(
    profile_id: String,
    title: String,
    url: String,
) -> Result<HistoryEntry, String> {
    storage::push_history(&profile_id, &title, &url)
}

#[tauri::command]
pub fn browser_history_clear(profile_id: String) -> Result<usize, String> {
    storage::clear_history(&profile_id)
}

// ---------- Audit log ----------

#[tauri::command]
pub fn browser_audit_recent(limit: Option<usize>) -> Result<Vec<AuditRecord>, String> {
    audit::list_recent(limit.unwrap_or(200))
}

#[tauri::command]
pub fn browser_audit_clear_older(seconds: Option<i64>) -> Result<usize, String> {
    // Default: purge rows older than 30 days.
    audit::clear_older_than(seconds.unwrap_or(30 * 24 * 60 * 60))
}

// ---------- Sandbox tabs ----------

#[tauri::command]
pub async fn browser_sandbox_open(
    app: AppHandle,
    profile_id: String,
    tab_id: String,
    url: String,
) -> Result<SandboxTab, String> {
    sandbox::open(&app, ProfileId(profile_id), tab_id, url).await
}

#[tauri::command]
pub fn browser_sandbox_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    sandbox::close(&app, &tab_id)
}

/// Open (or navigate) an embedded sandbox webview pinned over the main
/// window's content area at the supplied logical rect. This is the path
/// the Web module uses by default so the live page renders inline
/// instead of in a second OS window.
#[tauri::command]
pub async fn browser_sandbox_open_embedded(
    app: AppHandle,
    profile_id: String,
    tab_id: String,
    url: String,
    bounds: EmbedBounds,
) -> Result<SandboxTab, String> {
    sandbox::open_embedded(&app, ProfileId(profile_id), tab_id, url, bounds).await
}

/// Push new bounds to a live embedded sandbox webview. Cheap; safe to
/// call at animation rate from a ResizeObserver.
#[tauri::command]
pub fn browser_sandbox_set_bounds(
    app: AppHandle,
    tab_id: String,
    bounds: EmbedBounds,
) -> Result<(), String> {
    sandbox::set_bounds(&app, &tab_id, bounds)
}

/// Show or hide a live embedded sandbox webview. Used when the Web
/// module swaps between tabs or when the user navigates to a different
/// SUNNY module entirely and we want the webview to stop painting on top
/// of the React UI.
#[tauri::command]
pub fn browser_sandbox_set_visible(
    app: AppHandle,
    tab_id: String,
    visible: bool,
) -> Result<(), String> {
    sandbox::set_visible(&app, &tab_id, visible)
}

#[tauri::command]
pub fn browser_sandbox_list() -> Vec<SandboxTab> {
    sandbox::global().list()
}

/// Read the current URL of a live sandbox tab. Returns `null` when the
/// tab is gone (window closed out-of-band). The React store polls this
/// every few seconds for each open sandbox tab so the tab strip + posture
/// bar reflect where the user has navigated inside the WebView.
#[tauri::command]
pub fn browser_sandbox_current_url(
    app: AppHandle,
    tab_id: String,
) -> Option<String> {
    let next = sandbox::current_url(&app, &tab_id);
    if let Some(ref url) = next {
        sandbox::set_url(&tab_id, url.clone());
    }
    next
}

// ---------- Tor (bundled or system) ----------

#[tauri::command]
pub async fn browser_tor_bootstrap() -> Result<Value, String> {
    #[cfg(feature = "bundled-tor")]
    {
        let s = crate::browser::tor::bootstrap().await?;
        return Ok(serde_json::to_value(s).unwrap_or(Value::Null));
    }
    #[cfg(not(feature = "bundled-tor"))]
    {
        // Try the system tor at the canonical port.
        let ok = tokio::net::TcpStream::connect("127.0.0.1:9050").await.is_ok();
        if !ok {
            return Err(
                "System Tor not running on 127.0.0.1:9050. Install + start via `brew install tor && brew services start tor`, or rebuild Sunny with `--features bundled-tor` to bundle arti."
                    .into(),
            );
        }
        Ok(serde_json::json!({
            "bootstrapped": true,
            "progress": 100,
            "socks_port": 9050,
            "source": "system",
        }))
    }
}

#[tauri::command]
pub async fn browser_tor_status() -> Value {
    #[cfg(feature = "bundled-tor")]
    {
        return serde_json::to_value(crate::browser::tor::status()).unwrap_or(Value::Null);
    }
    #[cfg(not(feature = "bundled-tor"))]
    {
        let ok = tokio::net::TcpStream::connect("127.0.0.1:9050").await.is_ok();
        serde_json::json!({
            "bootstrapped": ok,
            "progress": if ok { 100 } else { 0 },
            "socks_port": if ok { Some(9050) } else { None },
            "source": "system",
        })
    }
}

#[tauri::command]
pub async fn browser_tor_new_circuit() -> Result<(), String> {
    #[cfg(feature = "bundled-tor")]
    {
        return crate::browser::tor::new_circuit().await;
    }
    #[cfg(not(feature = "bundled-tor"))]
    {
        // System tor: NEWNYM via control port would work but requires auth
        // and is off by default. We surface a clear nudge.
        Err("New circuit requires bundled Tor (build with `--features bundled-tor`). System Tor NEWNYM needs ControlPort configuration.".into())
    }
}

// ---------- Downloads ----------

#[tauri::command]
pub async fn browser_downloads_probe() -> ProbeResult {
    downloads::probe_tools().await
}

#[tauri::command]
pub async fn browser_downloads_enqueue(
    app: AppHandle,
    profile_id: String,
    url: String,
) -> Result<DownloadJob, String> {
    downloads::enqueue(app, ProfileId(profile_id), url).await
}

#[tauri::command]
pub fn browser_downloads_list() -> Vec<DownloadJob> {
    downloads::global().list()
}

#[tauri::command]
pub fn browser_downloads_cancel(id: String) -> bool {
    downloads::global().cancel(&id)
}

#[tauri::command]
pub fn browser_downloads_get(id: String) -> Option<DownloadJob> {
    downloads::global().get(&id)
}

#[tauri::command]
pub async fn browser_downloads_reveal(id: String) -> Result<(), String> {
    let job = downloads::global()
        .get(&id)
        .ok_or_else(|| format!("no download job: {id}"))?;
    let path = job
        .file_path
        .ok_or_else(|| "download has no file on disk yet".to_string())?;
    // -R reveals the file itself rather than opening the enclosing folder.
    tokio::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .await
        .map_err(|e| format!("open -R: {e}"))?;
    Ok(())
}

// ---------- Media analysis ----------

#[tauri::command]
pub async fn browser_media_extract(
    job_id: String,
    path: String,
) -> Result<ExtractResult, String> {
    media::extract(&job_id, std::path::Path::new(&path)).await
}

// ---------- Deep research ----------

#[tauri::command]
pub async fn browser_research_run(
    profile_id: String,
    query: String,
    max_sources: Option<usize>,
) -> Result<ResearchBrief, String> {
    research::run(
        ProfileId(profile_id),
        query,
        max_sources.unwrap_or(8),
    )
    .await
}

// ---------- Arbitrary fetch (agent tool surface) ----------
//
// Used by tools.ts when an agent needs to call an arbitrary HTTP endpoint
// under a specific profile's posture. Returns the status + headers + body
// as base64 so the agent can handle binary responses too.

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct BrowserRawFetchArgs {
    pub profile_id: String,
    pub url: String,
    pub method: Option<String>,
    #[ts(type = "Array<[string, string]> | null")]
    pub headers: Option<Vec<(String, String)>>,
    pub body_b64: Option<String>,
    pub tab_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct BrowserRawFetchResult {
    #[ts(type = "number")]
    pub status: u16,
    pub final_url: String,
    #[ts(type = "Array<[string, string]>")]
    pub headers: Vec<(String, String)>,
    pub body_b64: String,
}

#[tauri::command]
pub async fn browser_fetch(
    args: BrowserRawFetchArgs,
) -> Result<BrowserRawFetchResult, String> {
    use base64::Engine;
    let method = args
        .method
        .as_deref()
        .map(|m| reqwest::Method::from_bytes(m.as_bytes()).unwrap_or(reqwest::Method::GET))
        .unwrap_or(reqwest::Method::GET);
    let body = match args.body_b64.as_deref() {
        Some(b64) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .map_err(|e| format!("body_b64 decode: {e}"))?,
        ),
        None => None,
    };
    let opts = FetchOptions {
        method,
        headers: args.headers.unwrap_or_default(),
        body,
        tab_id: args.tab_id,
    };
    let resp = dispatcher::global()
        .fetch(&ProfileId(args.profile_id), &args.url, opts)
        .await?;
    Ok(BrowserRawFetchResult {
        status: resp.status,
        final_url: resp.final_url,
        headers: resp.headers,
        body_b64: base64::engine::general_purpose::STANDARD.encode(&resp.body),
    })
}
