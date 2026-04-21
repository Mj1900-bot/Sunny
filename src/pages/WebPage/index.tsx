import type { ReactElement } from 'react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { ModuleView } from '../../components/ModuleView';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';
import { DownloadsPanel } from './DownloadsPanel';
import { PostureBar } from './PostureBar';
import { ProfileRail } from './ProfileRail';
import { ReaderContent } from './ReaderContent';
import { ResearchPanel } from './ResearchPanel';
import { TabStrip } from './TabStrip';
import { routeTag, profileColor } from './profiles';
import { hostOf, looksLikeUrl, searchUrl, useTabs } from './tabStore';
import type { Bookmark } from './types';

type HistoryEntry = { id: number; title: string; url: string; visited_at: number };

type Suggestion =
  | { kind: 'history'; title: string; url: string }
  | { kind: 'bookmark'; title: string; url: string }
  | { kind: 'search'; query: string };

const toolbarBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '0 10px',
  border: '1px solid var(--line-soft)',
  color: 'var(--cyan)',
  fontFamily: 'var(--display, var(--mono))',
  fontSize: 11,
  letterSpacing: '0.14em',
  textAlign: 'center',
  height: 26,
  lineHeight: '26px',
  boxSizing: 'border-box',
};

const toolbarBtnDisabled: CSSProperties = { ...toolbarBtn, cursor: 'not-allowed', opacity: 0.3 };

const addressBar: CSSProperties = {
  flex: 1,
  all: 'unset',
  fontFamily: "'JetBrains Mono', var(--mono)",
  fontSize: 12,
  color: 'var(--ink)',
  padding: '0 10px',
  border: '1px solid var(--line-soft)',
  height: 26,
  lineHeight: '26px',
  background: 'rgba(4, 10, 16, 0.5)',
  boxSizing: 'border-box',
};

const sidebarStyle: CSSProperties = {
  width: 220,
  flexShrink: 0,
  borderRight: '1px solid var(--line-soft)',
  padding: '8px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  overflowY: 'auto',
  boxSizing: 'border-box',
};

const contentArea: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  padding: '12px 22px 28px',
  background: 'linear-gradient(180deg, rgba(4, 10, 16, 0.98), rgba(4, 12, 20, 0.98))',
  boxSizing: 'border-box',
};

const READER_CSS = `
.sunny-web { word-break: break-word; overflow-wrap: anywhere; }
.sunny-web > :first-child { margin-top: 0; }
.sunny-web > :last-child { margin-bottom: 0; }
.sunny-web h1, .sunny-web h2, .sunny-web h3 { color: var(--cyan); font-family: 'Orbitron', var(--display, var(--mono)); letter-spacing: 0.04em; margin: 1.2em 0 0.4em; line-height: 1.25; }
.sunny-web h4, .sunny-web h5, .sunny-web h6 { color: var(--cyan); font-family: 'Orbitron', var(--display, var(--mono)); letter-spacing: 0.04em; margin: 1em 0 0.3em; font-size: 13px; }
.sunny-web h1 { font-size: 22px; }
.sunny-web h2 { font-size: 18px; }
.sunny-web h3 { font-size: 15px; }
.sunny-web p { margin: 0.9em 0; }
.sunny-web a { color: var(--cyan); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.sunny-web a:hover { color: #e6fbff; }
.sunny-web pre, .sunny-web code { font-family: 'JetBrains Mono', var(--mono); font-size: 12px; color: #b8e8ff; }
.sunny-web code { background: rgba(0, 220, 255, 0.06); padding: 1px 4px; border-radius: 2px; }
.sunny-web pre { background: rgba(0, 220, 255, 0.05); padding: 10px; border-left: 2px solid var(--cyan); overflow-x: auto; white-space: pre-wrap; }
.sunny-web pre code { background: none; padding: 0; }
.sunny-web blockquote { border-left: 2px solid var(--cyan); padding-left: 12px; color: var(--ink-dim); font-style: italic; margin: 1em 0; }
.sunny-web ul, .sunny-web ol { padding-left: 1.4em; margin: 0.8em 0; }
.sunny-web li { margin: 0.3em 0; }
.sunny-web img { display: inline-block; max-width: 100%; border: 1px dashed var(--line-soft); padding: 4px 6px; color: var(--ink-dim); font-size: 10px; font-family: var(--mono); letter-spacing: 0.04em; }
`;

type SideView = 'bookmarks' | 'downloads' | 'research' | 'history';

export function WebPage(): ReactElement {
  const tabs = useTabs(s => s.tabs);
  const profiles = useTabs(s => s.profiles);
  const activeTabId = useTabs(s => s.activeTabId);
  const hydrate = useTabs(s => s.hydrate);
  const navigate = useTabs(s => s.navigate);
  const goBack = useTabs(s => s.goBack);
  const goForward = useTabs(s => s.goForward);
  const reload = useTabs(s => s.reload);
  const setRenderMode = useTabs(s => s.setRenderMode);

  const tab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const profile = profiles.find(p => p.id === tab?.profileId) ?? profiles[0];

  const [draft, setDraft] = useState('');
  const [sideView, setSideView] = useState<SideView>('bookmarks');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [urlWarning, setUrlWarning] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setSandboxBounds = useTabs(s => s.setSandboxBounds);
  const setSandboxVisible = useTabs(s => s.setSandboxVisible);
  const zoom = useTabs(s => (tab ? s.zoomByProfile[tab.profileId] ?? 1.0 : 1.0));

  // Measure the content area and forward it to the store so any open
  // embedded sandbox webview follows the React layout. `ResizeObserver`
  // catches width/height; resize + scroll handle top/left drift.
  //
  // Important: ModuleView wraps the page in `.panel .body` with
  // `overflow: auto`. Scrolling that panel does not fire `window` scroll
  // — only the scroll target fires. Without listening on the document
  // (capture) and on every scrollable ancestor, sandbox bounds stay stale
  // and the native WKWebView overlaps the WEB toolbar / side rail.
  useEffect(() => {
    const push = () => {
      const el = contentRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setSandboxBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };

    const scrollCleanups: Array<() => void> = [];

    const bindAncestorScroll = () => {
      for (const c of scrollCleanups) c();
      scrollCleanups.length = 0;
      const el = contentRef.current;
      if (!el) return;
      let node: Element | null = el;
      while (node) {
        const target = node;
        const fn = () => push();
        target.addEventListener('scroll', fn, { passive: true });
        scrollCleanups.push(() => target.removeEventListener('scroll', fn));
        node = node.parentElement;
      }
    };

    push();
    bindAncestorScroll();

    const ro = new ResizeObserver(() => {
      push();
      bindAncestorScroll();
    });
    if (contentRef.current) ro.observe(contentRef.current);

    window.addEventListener('resize', push);
    document.addEventListener('scroll', push, true);

    let raf = 0;
    const schedulePostLayoutPush = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          push();
          bindAncestorScroll();
        });
      });
    };
    schedulePostLayoutPush();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', push);
      vv.addEventListener('scroll', push);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', push);
      document.removeEventListener('scroll', push, true);
      if (vv) {
        vv.removeEventListener('resize', push);
        vv.removeEventListener('scroll', push);
      }
      for (const c of scrollCleanups) c();
    };
  }, [setSandboxBounds]);

  // When the Web module itself unmounts (user clicks to Settings, Memory,
  // etc.), hide every embedded sandbox webview so it stops painting on
  // top of the other module's UI. Remount re-fires the measure-and-push
  // effect above, which will show the active tab's webview again.
  useEffect(() => {
    setSandboxVisible(true);
    return () => setSandboxVisible(false);
  }, [setSandboxVisible]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // ReaderContent's context menu emits this custom event when the user
  // picks "Open in new tab" so the component stays decoupled from the
  // store. We catch it here and route through the store normally.
  useEffect(() => {
    const onOpenNewTab = (ev: Event) => {
      const url = (ev as CustomEvent<{ url: string }>).detail?.url;
      if (!url || !tab) return;
      useTabs.getState().openTab(tab.profileId, url);
    };
    window.addEventListener('sunny:web:open-new-tab', onOpenNewTab as EventListener);
    return () =>
      window.removeEventListener('sunny:web:open-new-tab', onOpenNewTab as EventListener);
  }, [tab?.id, tab?.profileId]);

  useEffect(() => {
    if (!tab) return;
    setDraft(tab.url);
  }, [tab?.id, tab?.url]);

  // Switching to (or opening) a blank tab should park the caret in the URL
  // bar so the user can just start typing — matches Safari/Chrome.
  useEffect(() => {
    if (!tab) return;
    if (tab.url.length === 0) {
      const el = addressInputRef.current;
      el?.focus();
      el?.select();
    }
  }, [tab?.id, tab?.url]);

  useEffect(() => {
    if (!tab || !isTauri) return;
    let cancelled = false;
    void invokeSafe<Bookmark[]>('browser_bookmarks_list', { profileId: tab.profileId }, []).then(
      bs => {
        if (!cancelled) setBookmarks(bs ?? []);
      },
    );
    // Pull recent history for address-bar autocomplete. 150 rows is enough
    // to give strong recall without trashing memory; we filter client-side
    // on every keystroke so there's no per-key IPC.
    void invokeSafe<HistoryEntry[]>(
      'browser_history_list',
      { profileId: tab.profileId, limit: 150 },
      [],
    ).then(rows => {
      if (!cancelled) setHistory(rows ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [tab?.profileId, tab?.url]);

  // Recompute the autocomplete list whenever the draft or the source
  // data changes. Cheap even with hundreds of entries because it's a
  // single filter + slice.
  const suggestions = useMemo<Suggestion[]>(() => {
    const q = draft.trim().toLowerCase();
    if (q.length < 2) return [];
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    const match = (text: string) => text.toLowerCase().includes(q);
    for (const b of bookmarks) {
      if (out.length >= 5) break;
      if ((match(b.title) || match(b.url)) && !seen.has(b.url)) {
        seen.add(b.url);
        out.push({ kind: 'bookmark', title: b.title || hostOf(b.url), url: b.url });
      }
    }
    for (const h of history) {
      if (out.length >= 7) break;
      if ((match(h.title) || match(h.url)) && !seen.has(h.url)) {
        seen.add(h.url);
        out.push({ kind: 'history', title: h.title || hostOf(h.url), url: h.url });
      }
    }
    // A search suggestion always at the tail so the user sees an escape
    // hatch even when history has partial matches.
    if (!looksLikeUrl(draft.trim())) {
      out.push({ kind: 'search', query: draft.trim() });
    }
    return out;
  }, [draft, bookmarks, history]);

  const runSuggestion = useCallback(
    (s: Suggestion) => {
      if (!tab) return;
      setSuggestOpen(false);
      if (s.kind === 'search') {
        const url = searchUrl(s.query);
        setDraft(url);
        void navigate(tab.id, url);
      } else {
        setDraft(s.url);
        void navigate(tab.id, s.url);
      }
    },
    [navigate, tab],
  );

  const addressSubmit = useCallback(async () => {
    if (!tab) return;
    // If the user pressed Enter while a suggestion is highlighted and
    // the dropdown is open, commit the suggestion instead of the draft.
    if (suggestOpen && suggestions[suggestIdx]) {
      runSuggestion(suggestions[suggestIdx]);
      return;
    }
    setSuggestOpen(false);
    // Homograph / punycode guard. The backend returns the ASCII form of
    // the host when a URL looks deceptive; we pop a confirm so the user
    // sees exactly what they'd be navigating to before committing.
    if (isTauri) {
      try {
        const warning = await invokeSafe<string | null>(
          'browser_url_is_deceptive',
          { url: draft },
          null,
        );
        if (warning && typeof warning === 'string') {
          const ok = window.confirm(
            `This URL contains non-ASCII or punycode characters: ${warning}\n\nThat can hide a phishing attempt (e.g. "аpple.com" vs "apple.com"). Proceed anyway?`,
          );
          if (!ok) return;
          setUrlWarning(warning);
        } else {
          setUrlWarning(null);
        }
      } catch {
        /* ignore — safe to navigate if the check itself errors */
      }
    }
    void navigate(tab.id, draft);
  }, [draft, navigate, runSuggestion, suggestIdx, suggestOpen, suggestions, tab]);

  const addBookmark = useCallback(async () => {
    if (!tab || tab.url.length === 0) return;
    const b = await invoke<Bookmark>('browser_bookmarks_add', {
      profileId: tab.profileId,
      title: tab.title || hostOf(tab.url),
      url: tab.url,
    });
    setBookmarks(prev => [b, ...prev.filter(x => x.url !== b.url)]);
  }, [tab]);

  const removeBookmark = useCallback(
    async (url: string) => {
      if (!tab) return;
      await invoke('browser_bookmarks_delete', { profileId: tab.profileId, url });
      setBookmarks(prev => prev.filter(b => b.url !== url));
    },
    [tab],
  );


  const canBack = tab && tab.cursor > 0;
  const canForward = tab && tab.cursor >= 0 && tab.cursor < tab.history.length - 1;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setSuggestOpen(true);
      setSuggestIdx(i => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setSuggestOpen(true);
      setSuggestIdx(i => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Escape') {
      setSuggestOpen(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void addressSubmit();
    }
  };

  useEffect(() => {
    if (!tab) return;
    const onGlobalKey = (e: globalThis.KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      const active = document.activeElement;
      const typing =
        active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (k === 'l') {
        e.preventDefault();
        const el = addressInputRef.current;
        el?.focus();
        el?.select();
        return;
      }

      // Tab switching works even when typing — mirroring Safari / Chrome.
      // Cmd+1..8 picks that tab, Cmd+9 picks the last tab (Chrome's rule,
      // not the 9th tab). Cmd+Shift+{[,]} cycles prev/next.
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const all = useTabs.getState().tabs;
        const idx = e.key === '9' ? all.length - 1 : Math.min(parseInt(e.key, 10) - 1, all.length - 1);
        const target = all[idx];
        if (target) useTabs.getState().selectTab(target.id);
        return;
      }
      if (e.shiftKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}')) {
        e.preventDefault();
        const all = useTabs.getState().tabs;
        const idx = all.findIndex(t => t.id === tab.id);
        const dir = e.key === '[' || e.key === '{' ? -1 : 1;
        const next = all[(idx + dir + all.length) % all.length];
        if (next) useTabs.getState().selectTab(next.id);
        return;
      }

      if (typing) return;

      if (e.key === '[') {
        e.preventDefault();
        goBack(tab.id);
      } else if (e.key === ']') {
        e.preventDefault();
        goForward(tab.id);
      } else if (k === 'r') {
        e.preventDefault();
        void reload(tab.id);
      } else if (k === 'd') {
        e.preventDefault();
        void addBookmark();
      } else if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        useTabs.getState().openTab(tab.profileId);
      } else if (k === 't' && e.shiftKey) {
        // Cmd+Shift+T: reopen last closed tab — matches every other browser.
        e.preventDefault();
        useTabs.getState().reopenLastClosed();
      } else if (k === 'w') {
        e.preventDefault();
        useTabs.getState().closeTab(tab.id);
      } else if (k === 'f' && !e.shiftKey) {
        // Cmd+F in-page find — only wires when a reader tab is rendering.
        if (tab.renderMode === 'reader' && tab.load.kind === 'ready') {
          e.preventDefault();
          setFindOpen(true);
        }
      } else if (k === '=' || k === '+') {
        e.preventDefault();
        useTabs.getState().bumpZoom(tab.profileId, 0.1);
      } else if (k === '-') {
        e.preventDefault();
        useTabs.getState().bumpZoom(tab.profileId, -0.1);
      } else if (k === '0') {
        e.preventDefault();
        useTabs.getState().setZoom(tab.profileId, 1.0);
      } else if (k === 'j') {
        // Toggle reader <-> sandbox — mirrors DevTools-style chord.
        e.preventDefault();
        setRenderMode(tab.id, tab.renderMode === 'reader' ? 'sandbox' : 'reader');
      } else if (e.shiftKey && k === 'k') {
        // Shift-Cmd-K arms/disarms the kill switch. Loud enough that it's
        // unlikely to be hit accidentally.
        e.preventDefault();
        void useTabs.getState().setKillSwitch(!useTabs.getState().killSwitch);
      } else if (e.shiftKey && k === 'c') {
        // Shift-Cmd-C copies the current reader text as markdown so
        // agents / notes can ingest it. No-op for sandbox tabs.
        if (tab.renderMode === 'reader' && tab.load.kind === 'ready') {
          e.preventDefault();
          const r = tab.load.result;
          const md = `# ${r.extract.title || hostOf(r.final_url)}\nSource: ${r.final_url}\n\n${r.extract.description ? `> ${r.extract.description}\n\n` : ''}${r.extract.text}\n`;
          void navigator.clipboard.writeText(md).catch(() => {});
        }
      }
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [goBack, goForward, reload, addBookmark, tab, setRenderMode]);

  const badge = useMemo<string>(() => {
    if (!profile) return 'READY';
    return routeTag(profile);
  }, [profile]);

  if (!tab || !profile) {
    return (
      <ModuleView title="WEB" badge="READY">
        <div>Loading…</div>
      </ModuleView>
    );
  }

  const body = renderBody(
    tab,
    findOpen && tab.renderMode === 'reader' ? findQuery : '',
    () => void reload(tab.id),
    () => {
      const el = addressInputRef.current;
      el?.focus();
      el?.select();
    },
  );

  return (
    <ModuleView title="WEB" badge={badge}>
      <style>{READER_CSS}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 6,
        }}
      >
        <TabStrip />
        <PostureBar />

        {/* Address + nav controls */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          <button
            type="button"
            style={canBack ? toolbarBtn : toolbarBtnDisabled}
            onClick={() => goBack(tab.id)}
            disabled={!canBack}
            title="Back (Cmd+[)"
          >
            {'\u2039 BACK'}
          </button>
          <button
            type="button"
            style={canForward ? toolbarBtn : toolbarBtnDisabled}
            onClick={() => goForward(tab.id)}
            disabled={!canForward}
            title="Forward (Cmd+])"
          >
            {'FWD \u203A'}
          </button>
          <button
            type="button"
            style={tab.url.length > 0 ? toolbarBtn : toolbarBtnDisabled}
            onClick={() => void reload(tab.id)}
            disabled={tab.url.length === 0}
            title="Reload (Cmd+R)"
          >
            {'\u21BB RELOAD'}
          </button>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              ref={addressInputRef}
              type="text"
              value={draft}
              onChange={e => {
                setDraft(e.target.value);
                setSuggestOpen(true);
                setSuggestIdx(0);
              }}
              onFocus={() => {
                if (suggestions.length > 0) setSuggestOpen(true);
              }}
              onBlur={() => {
                // Delay so clicks on a suggestion land before the
                // dropdown unmounts. 120ms matches the click cadence
                // without feeling laggy when closing via keyboard.
                window.setTimeout(() => setSuggestOpen(false), 120);
              }}
              onKeyDown={onKey}
              placeholder="search the web or enter a URL"
              spellCheck={false}
              style={{ ...addressBar, width: '100%' }}
            />
            {suggestOpen && suggestions.length > 0 && (
              <SuggestionList
                suggestions={suggestions}
                active={suggestIdx}
                onPick={runSuggestion}
                onHover={setSuggestIdx}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => void addressSubmit()}
            style={{ ...toolbarBtn, color: profileColor(profile), borderColor: profileColor(profile) }}
            title="Go (Enter)"
          >
            GO
          </button>
          <button
            type="button"
            onClick={() => {
              const nextMode = tab.renderMode === 'reader' ? 'sandbox' : 'reader';
              setRenderMode(tab.id, nextMode);
              if (nextMode === 'sandbox' && tab.url.length > 0) {
                // Flipping to sandbox on an already-loaded URL should
                // materialise the live view right now rather than wait
                // for the next user navigation.
                void useTabs.getState().navigate(tab.id, tab.url);
              }
            }}
            style={{
              ...toolbarBtn,
              color: tab.renderMode === 'reader' ? 'var(--cyan)' : '#f5b042',
              borderColor: tab.renderMode === 'reader' ? 'var(--cyan)' : '#f5b042',
            }}
            title="Cmd+J · READER = safe extracted text · LIVE = real page rendered inline"
          >
            {tab.renderMode === 'reader' ? 'LIVE VIEW' : 'READER'}
          </button>
        </div>

        {/* Main split */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            border: '1px solid var(--line-soft)',
            background: 'rgba(4, 10, 16, 0.7)',
          }}
        >
          <ProfileRail />

          {/* Side panel picker */}
          <div style={sidebarStyle}>
            <SidePicker current={sideView} setCurrent={setSideView} />
            {sideView === 'bookmarks' ? (
              <BookmarksView
                bookmarks={bookmarks}
                onOpen={url => void navigate(tab.id, url)}
                onDelete={removeBookmark}
                onAddCurrent={addBookmark}
                canAdd={tab.url.length > 0}
                currentUrl={tab.url}
              />
            ) : sideView === 'history' ? (
              <HistoryView profileId={tab.profileId} onOpen={url => void navigate(tab.id, url)} />
            ) : sideView === 'downloads' ? (
              <DownloadsPanel />
            ) : (
              <ResearchPanel />
            )}
          </div>

          {/* Content */}
          <div ref={contentRef} style={{ ...contentArea, position: 'relative' }}>
            {tab.load.kind === 'loading' && <ProgressBar />}
            <div
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'top center',
                transition: 'transform 120ms ease-out',
              }}
            >
              {body}
            </div>
            {zoom !== 1.0 && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 10,
                  padding: '2px 6px',
                  border: '1px solid var(--line-soft)',
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: 'var(--ink-dim)',
                  background: 'rgba(4, 10, 16, 0.85)',
                  letterSpacing: '0.14em',
                }}
                title="Cmd+0 to reset"
              >
                {Math.round(zoom * 100)}%
              </div>
            )}
            {findOpen && tab.renderMode === 'reader' && (
              <FindBar
                query={findQuery}
                onChange={setFindQuery}
                onClose={() => {
                  setFindOpen(false);
                  setFindQuery('');
                }}
              />
            )}
            {urlWarning && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  padding: '4px 10px',
                  background: 'rgba(245, 176, 66, 0.12)',
                  borderBottom: '1px solid #f5b042',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: '#f5b042',
                  letterSpacing: '0.08em',
                }}
              >
                {`// WARNING: deceptive host "${urlWarning}" — verify before you trust this page`}
              </div>
            )}
          </div>
        </div>
      </div>
    </ModuleView>
  );
}

function renderBody(
  tab: import('./types').TabRecord,
  findQuery: string,
  onRetry: () => void,
  onFocusAddress: () => void,
): ReactElement {
  if (tab.url.length === 0) {
    return <EmptyState onFocusAddress={onFocusAddress} />;
  }
  if (tab.renderMode === 'sandbox') {
    if (tab.load.kind === 'loading') {
      return <LoadingState url={tab.url} />;
    }
    if (tab.load.kind === 'error') {
      return <ErrorState message={tab.load.message} url={tab.url} onRetry={onRetry} />;
    }
    const wasAutoEscalated = tab.lastSandboxEscalationUrl === tab.url;
    return <SandboxNotice autoEscalated={wasAutoEscalated} />;
  }
  if (tab.load.kind === 'loading') return <LoadingState url={tab.url} />;
  if (tab.load.kind === 'error')
    return <ErrorState message={tab.load.message} url={tab.url} onRetry={onRetry} />;
  if (tab.load.kind === 'ready') {
    const extract = tab.load.result.extract;
    return (
      <div
        style={{
          maxWidth: 780,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: '1px solid var(--line-soft)',
            paddingBottom: 8,
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: "'Orbitron', var(--display, var(--mono))",
              fontSize: 16,
              letterSpacing: '0.04em',
              color: 'var(--cyan)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {extract.title || hostOf(tab.load.result.final_url)}
          </div>
          <CopyMarkdownButton
            title={extract.title || hostOf(tab.load.result.final_url)}
            description={extract.description}
            text={extract.text}
            finalUrl={tab.load.result.final_url}
          />
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.12em',
            color: 'var(--ink-dim)',
          }}
        >
          {hostOf(tab.load.result.final_url)}
          {tab.load.result.final_url !== tab.url ? (
            <span style={{ marginLeft: 8, color: '#f5b042' }}>{'\u2192 redirected'}</span>
          ) : null}
          <span style={{ marginLeft: 8 }}>{`${tab.load.elapsedMs}ms`}</span>
        </div>
        {extract.description && (
          <div style={{ color: 'var(--ink-dim)', fontSize: 12, fontStyle: 'italic' }}>
            {extract.description}
          </div>
        )}
        <ReaderContent
          html={extract.body_html}
          baseUrl={tab.load.result.final_url || tab.url}
          highlightQuery={findQuery}
          onNavigate={url => void useTabs.getState().navigate(tab.id, url)}
          onExternal={url => {
            void invokeSafe<null>('open_url', { url });
          }}
        />
      </div>
    );
  }
  return <EmptyState onFocusAddress={onFocusAddress} />;
}

function SidePicker({
  current,
  setCurrent,
}: {
  current: SideView;
  setCurrent: (v: SideView) => void;
}): ReactElement {
  const tabs: { id: SideView; label: string }[] = [
    { id: 'bookmarks', label: 'BOOKMARKS' },
    { id: 'history', label: 'HISTORY' },
    { id: 'downloads', label: 'DOWNLOADS' },
    { id: 'research', label: 'RESEARCH' },
  ];
  return (
    <div style={{ display: 'flex', gap: 2, flexShrink: 0, flexWrap: 'wrap' }}>
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => setCurrent(t.id)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '4px 6px',
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.16em',
            border: '1px solid var(--line-soft)',
            color: current === t.id ? 'var(--cyan)' : 'var(--ink-dim)',
            background: current === t.id ? 'rgba(0,220,255,0.06)' : 'transparent',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function BookmarksView({
  bookmarks,
  onOpen,
  onDelete,
  onAddCurrent,
  canAdd,
  currentUrl,
}: {
  bookmarks: Bookmark[];
  onOpen: (url: string) => void;
  onDelete: (url: string) => void;
  onAddCurrent: () => void;
  canAdd: boolean;
  currentUrl: string;
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      <button
        type="button"
        onClick={onAddCurrent}
        disabled={!canAdd}
        style={{
          ...toolbarBtn,
          width: '100%',
          opacity: canAdd ? 1 : 0.4,
          cursor: canAdd ? 'pointer' : 'not-allowed',
          borderStyle: 'dashed',
        }}
      >
        {'+ BOOKMARK CURRENT'}
      </button>
      {bookmarks.length === 0 ? (
        <div style={{ color: 'var(--ink-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}>
          {'// no bookmarks yet'}
        </div>
      ) : (
        bookmarks.map(b => (
          <div
            key={b.url}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <button
              type="button"
              onClick={() => onOpen(b.url)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                flex: 1,
                padding: '4px 6px',
                border: '1px solid var(--line-soft)',
                fontFamily: "'JetBrains Mono', var(--mono)",
                fontSize: 10,
                color: b.url === currentUrl ? 'var(--cyan)' : 'var(--ink)',
                borderColor: b.url === currentUrl ? 'var(--cyan)' : 'var(--line-soft)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={b.url}
            >
              {b.title || hostOf(b.url)}
            </button>
            <button
              type="button"
              onClick={() => onDelete(b.url)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '0 6px',
                height: 22,
                border: '1px solid var(--line-soft)',
                color: 'var(--ink-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 9,
              }}
              aria-label="Delete bookmark"
            >
              DEL
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function HistoryView({
  profileId,
  onOpen,
}: {
  profileId: string;
  onOpen: (url: string) => void;
}): ReactElement {
  const [rows, setRows] = useState<import('./types').AuditRecord[]>([]);
  const [hist, setHist] = useState<
    { id: number; title: string; url: string; visited_at: number }[]
  >([]);
  useEffect(() => {
    if (!isTauri) return;
    void invokeSafe<
      { id: number; title: string; url: string; visited_at: number }[]
    >('browser_history_list', { profileId, limit: 200 }, []).then(h => setHist(h ?? []));
    void invokeSafe<import('./types').AuditRecord[]>(
      'browser_audit_recent',
      { limit: 40 },
      [],
    ).then(r => setRows((r ?? []).filter(x => x.profile_id === profileId)));
  }, [profileId]);

  if (profileId === 'tor') {
    return (
      <div style={{ fontFamily: 'var(--mono)', color: 'var(--ink-dim)', fontSize: 10, marginTop: 6 }}>
        {'// Tor profile never records history — by design.'}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      <div style={{ fontSize: 9, letterSpacing: '0.16em', color: 'var(--ink-dim)' }}>VISITS</div>
      {hist.length === 0 ? (
        <div style={{ color: 'var(--ink-dim)', fontSize: 10 }}>{'// none yet'}</div>
      ) : (
        hist.slice(0, 30).map(h => (
          <button
            key={h.id}
            type="button"
            onClick={() => onOpen(h.url)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              padding: '2px 4px',
              borderBottom: '1px dotted var(--line-soft)',
            }}
            title={h.url}
          >
            {h.title || hostOf(h.url)}
          </button>
        ))
      )}
      <div style={{ fontSize: 9, letterSpacing: '0.16em', color: 'var(--ink-dim)', marginTop: 6 }}>
        AUDIT · last {rows.length}
      </div>
      {rows.slice(0, 20).map(r => (
        <div
          key={r.id}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            color: r.blocked_by ? '#ff9b9b' : 'var(--ink-dim)',
            display: 'flex',
            gap: 6,
          }}
          title={r.blocked_by ?? `${r.duration_ms}ms · ${r.bytes_in}B in`}
        >
          <span style={{ minWidth: 32 }}>{r.method}</span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {r.host}:{r.port}
          </span>
          <span>{r.blocked_by ? 'BLK' : `${r.duration_ms}ms`}</span>
        </div>
      ))}
    </div>
  );
}

function SuggestionList({
  suggestions,
  active,
  onPick,
  onHover,
}: {
  suggestions: Suggestion[];
  active: number;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
}): ReactElement {
  return (
    <div
      role="listbox"
      aria-label="URL suggestions"
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        marginTop: 2,
        background: 'rgba(4, 12, 20, 0.98)',
        border: '1px solid var(--cyan)',
        boxShadow: '0 4px 18px rgba(0, 220, 255, 0.18)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'JetBrains Mono', var(--mono)",
        fontSize: 11,
      }}
    >
      {suggestions.map((s, i) => (
        <div
          key={`${s.kind}-${i}`}
          role="option"
          aria-selected={i === active}
          onMouseDown={e => {
            // Use mousedown so the blur-timeout doesn't eat the click.
            e.preventDefault();
            onPick(s);
          }}
          onMouseEnter={() => onHover(i)}
          style={{
            cursor: 'pointer',
            padding: '6px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: '1px solid var(--line-soft)',
            background:
              i === active ? 'rgba(0, 220, 255, 0.12)' : 'transparent',
            color: 'var(--ink)',
          }}
        >
          <span
            style={{
              fontSize: 8,
              letterSpacing: '0.18em',
              padding: '1px 4px',
              border: '1px solid var(--line-soft)',
              color:
                s.kind === 'search'
                  ? '#f5b042'
                  : s.kind === 'bookmark'
                    ? '#b388ff'
                    : 'var(--cyan)',
              borderColor:
                s.kind === 'search'
                  ? '#f5b042'
                  : s.kind === 'bookmark'
                    ? '#b388ff'
                    : 'var(--cyan)',
              flexShrink: 0,
            }}
          >
            {s.kind === 'search' ? 'SEARCH' : s.kind === 'bookmark' ? 'BOOK' : 'HIST'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--ink)',
              }}
            >
              {s.kind === 'search'
                ? `Search the web for: ${s.query}`
                : s.title || hostOf(s.url)}
            </div>
            {s.kind !== 'search' && (
              <div
                style={{
                  fontSize: 9,
                  color: 'var(--ink-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.url}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProgressBar(): ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 5,
      }}
      aria-hidden
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: '40%',
          background:
            'linear-gradient(90deg, transparent, var(--cyan), transparent)',
          animation: 'sunny-web-progress 1.1s linear infinite',
        }}
      />
      <style>
        {`@keyframes sunny-web-progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }`}
      </style>
    </div>
  );
}

function EmptyState({ onFocusAddress }: { onFocusAddress: () => void }): ReactElement {
  return (
    <div
      style={{
        padding: '32px 0',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--ink-dim)',
        letterSpacing: '0.05em',
        lineHeight: 1.7,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          fontFamily: "'Orbitron', var(--display, var(--mono))",
          fontSize: 14,
          letterSpacing: '0.22em',
          color: 'var(--cyan)',
        }}
      >
        READY
      </div>
      <div>
        {'// type a URL above, or pick bookmarks / research / downloads from the sidebar.'}
        <br />
        {'// reader mode is the default; switch to SANDBOX for JS-heavy sites.'}
      </div>
      <button
        type="button"
        onClick={onFocusAddress}
        style={{
          ...toolbarBtn,
          fontSize: 11,
          padding: '0 14px',
        }}
        title="Cmd+L"
      >
        {'\u2192 FOCUS URL BAR'}
      </button>
      <div style={{ fontSize: 10, color: 'var(--ink-dim)' }}>
        {'// shortcuts · Cmd+T new · Cmd+W close · Cmd+L url · Cmd+J toggle reader/live'}
      </div>
    </div>
  );
}

function LoadingState({ url }: { url: string }): ReactElement {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--cyan)',
        letterSpacing: '0.22em',
        padding: '40px 16px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        style={{
          width: 24,
          height: 24,
          border: '2px solid var(--line-soft)',
          borderTopColor: 'var(--cyan)',
          borderRadius: '50%',
          animation: 'sunny-tab-spin 0.9s linear infinite',
        }}
        aria-hidden
      />
      <div>LOADING…</div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--ink-dim)',
          letterSpacing: '0.12em',
          maxWidth: 420,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={url}
      >
        {host}
      </div>
    </div>
  );
}

function ErrorState({
  message,
  url,
  onRetry,
}: {
  message: string;
  url: string;
  onRetry: () => void;
}): ReactElement {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  return (
    <div
      role="alert"
      style={{
        border: '1px solid #f5b042',
        background: 'rgba(245, 176, 66, 0.08)',
        padding: 14,
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: '#f5b042',
        letterSpacing: '0.04em',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>{'// FETCH FAILED'}</div>
      <div style={{ color: '#ffd08a', fontSize: 10, letterSpacing: '0.1em' }} title={url}>
        {host}
      </div>
      <div style={{ color: '#ffd08a', fontSize: 11, lineHeight: 1.5 }}>{message}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button
          type="button"
          onClick={onRetry}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '0 12px',
            height: 24,
            lineHeight: '24px',
            border: '1px solid #f5b042',
            color: '#f5b042',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.16em',
          }}
          title="Retry (Cmd+R)"
        >
          {'\u21BB RETRY'}
        </button>
      </div>
    </div>
  );
}

function FindBar({
  query,
  onChange,
  onClose,
}: {
  query: string;
  onChange: (v: string) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        background: 'rgba(4, 12, 20, 0.96)',
        border: '1px solid var(--cyan)',
        boxShadow: '0 2px 10px rgba(0, 220, 255, 0.12)',
        zIndex: 10,
      }}
    >
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--cyan)', letterSpacing: '0.14em' }}>
        FIND
      </span>
      <input
        autoFocus
        type="text"
        value={query}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose();
        }}
        placeholder="search page"
        style={{
          all: 'unset',
          padding: '0 6px',
          height: 22,
          border: '1px solid var(--line-soft)',
          fontFamily: "'JetBrains Mono', var(--mono)",
          fontSize: 11,
          color: 'var(--ink)',
          background: 'rgba(4, 10, 16, 0.5)',
          minWidth: 220,
        }}
      />
      <button
        type="button"
        onClick={onClose}
        style={{
          all: 'unset',
          cursor: 'pointer',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          padding: '0 4px',
        }}
        title="Close find (Esc)"
      >
        {'\u00d7'}
      </button>
    </div>
  );
}

function CopyMarkdownButton({
  title,
  description,
  text,
  finalUrl,
}: {
  title: string;
  description: string;
  text: string;
  finalUrl: string;
}): ReactElement {
  const [state, setState] = useState<'idle' | 'copied'>('idle');
  const onClick = async () => {
    const md = `# ${title}\nSource: ${finalUrl}\n\n${description ? `> ${description}\n\n` : ''}${text}\n`;
    try {
      await navigator.clipboard.writeText(md);
      setState('copied');
      window.setTimeout(() => setState('idle'), 1200);
    } catch {
      /* clipboard API unavailable in some sandboxes — fail silently */
    }
  };
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      style={{
        ...toolbarBtn,
        fontSize: 10,
        height: 22,
        lineHeight: '22px',
        padding: '0 8px',
      }}
      title="Copy article as markdown (Cmd+Shift+C)"
    >
      {state === 'copied' ? 'COPIED' : 'COPY MD'}
    </button>
  );
}

function SandboxNotice({ autoEscalated = false }: { autoEscalated?: boolean }): ReactElement {
  // In the embedded-sandbox path this notice is never visible — the
  // child webview stacks on top of it. We keep it as a loud, empty-
  // state fallback for the rare cases where the webview can't attach
  // (main window missing, kill switch racing the handshake) so the
  // user understands what they're looking at.
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-dim)',
        letterSpacing: '0.1em',
        padding: 40,
        textAlign: 'center',
        lineHeight: 1.7,
        pointerEvents: 'none',
      }}
    >
      {autoEscalated
        ? '// live view · auto-escalated because the reader extract was empty'
        : '// live view · rendering real page inline · Cmd+J for reader'}
    </div>
  );
}
