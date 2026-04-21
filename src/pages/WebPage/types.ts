// ---------------- Shared types (frontend mirror of Rust browser::*) ----------------

export type ProfileId = string;

export type Route =
  | { kind: 'clearnet'; doh: 'cloudflare' | 'quad9' | 'google' | null }
  | { kind: 'bundled_tor' }
  | { kind: 'system_tor'; host: string; port: number }
  | { kind: 'custom'; url: string };

export type CookieJar = 'persistent' | 'ephemeral' | 'disabled';
export type JsMode = 'off' | 'off_by_default' | 'on';
export type UaMode = 'rotate' | 'pinned_safari' | 'pinned_tor_browser' | 'system';
export type SecurityLevel = 'standard' | 'safer' | 'safest';

export type ProfilePolicy = {
  id: ProfileId;
  label: string;
  route: Route;
  cookies: CookieJar;
  js_default: JsMode;
  ua_mode: UaMode;
  block_third_party_cookies: boolean;
  block_trackers: boolean;
  block_webrtc: boolean;
  deny_sensors: boolean;
  audit: boolean;
  kill_switch_bypass: boolean;
  https_only: boolean;
  security_level: SecurityLevel;
};

export type ReaderExtract = {
  title: string;
  description: string;
  body_html: string;
  text: string;
  favicon_url: string;
};

export type BrowserFetchResult = {
  status: number;
  ok: boolean;
  final_url: string;
  url: string;
  extract: ReaderExtract;
};

export type RenderMode = 'reader' | 'sandbox';

/// Logical-pixel rect used to pin an embedded sandbox webview over the
/// content area. `x/y` are measured with `getBoundingClientRect()` so
/// they're already in CSS-logical units relative to the main window's
/// viewport — exactly what Tauri's `LogicalPosition` expects.
export type EmbedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TabLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; startedAt: number }
  | { kind: 'ready'; result: BrowserFetchResult; elapsedMs: number }
  | { kind: 'error'; message: string };

export type TabRecord = {
  id: string;
  profileId: ProfileId;
  renderMode: RenderMode;
  url: string;
  title: string;
  history: readonly { url: string; title: string }[];
  cursor: number;
  load: TabLoadState;
  // Set to the URL we auto-escalated to sandbox for. If the user flips back
  // to reader on the same URL, we suppress re-escalation until they navigate
  // somewhere new. Cleared on each URL change.
  lastSandboxEscalationUrl?: string;
};

export type Bookmark = {
  id: number;
  profile_id: string;
  title: string;
  url: string;
  created_at: number;
};

export type AuditRecord = {
  id: number;
  ts: number;
  profile_id: string;
  tab_id: string | null;
  method: string;
  host: string;
  port: number;
  bytes_in: number;
  bytes_out: number;
  duration_ms: number;
  blocked_by: string | null;
};

export type DownloadState =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'post_process'
  | 'done'
  | 'failed'
  | 'cancelled';

export type DownloadJob = {
  id: string;
  profile_id: string;
  source_url: string;
  title: string | null;
  state: DownloadState;
  progress: number;
  file_path: string | null;
  mime: string | null;
  bytes_total: number | null;
  bytes_done: number;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type ProbeResult = {
  has_yt_dlp: boolean;
  yt_dlp_version: string | null;
  has_ffmpeg: boolean;
  ffmpeg_version: string | null;
  yt_dlp_path: string | null;
  ffmpeg_path: string | null;
};

export type TorStatus = {
  bootstrapped: boolean;
  progress: number;
  socks_port: number | null;
  source?: string;
  last_error?: string | null;
};

export type ResearchSource = {
  title: string;
  url: string;
  final_url: string;
  snippet: string;
  text: string;
  favicon_url: string;
  fetched_ok: boolean;
  ms: number;
};

export type ResearchBrief = {
  query: string;
  profile_id: string;
  sources: ResearchSource[];
  elapsed_ms: number;
};

export type HistoryEntry = { id: number; title: string; url: string; visited_at: number };

export type Suggestion =
  | { kind: 'history'; title: string; url: string }
  | { kind: 'bookmark'; title: string; url: string }
  | { kind: 'search'; query: string };

export type SideView = 'bookmarks' | 'downloads' | 'research' | 'history';
