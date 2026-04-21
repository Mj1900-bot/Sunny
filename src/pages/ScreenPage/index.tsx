import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ModuleView } from '../../components/ModuleView';
import { useSunny } from '../../hooks/useSunny';
import { useClock } from '../../hooks/useClock';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';

import type { Capture, OcrResult, OcrOptions, FocusedApp, WindowInfo, ScreenSize, RegionInput, PermissionProbe, Activity, AutoCadence, CaptureSource, DragRect, ActivityKind, ScreenCache, PaneKey, PermissionState } from './types';
import { INITIAL_PROBE, WINDOW_LIST_INTERVAL_MS, SCREEN_POLL_INTERVAL_MS, HISTORY_LIMIT, SUNNY_BUNDLE_ID, SETTINGS_URLS, TINY_PNG_BASE64 } from './constants';
import { loadPrefs, savePrefs } from './prefs';
import { makeId, nowTime, fileTimestamp, kindColor, cadenceToMs, errMsg, escapeAppleScriptString, downloadPng, copyImageToClipboard, copyTextToClipboard, normalizeDrag, isScreenRecordingPermissionError, dataUrl } from './utils';

import { DiagnosticsCard } from './components/DiagnosticsCard';
import { LivePreview } from './components/LivePreview';
import { ActiveWindowCard } from './components/ActiveWindowCard';
import { RegionForm } from './components/RegionForm';
import { HistoryStrip } from './components/HistoryStrip';
import { CaptureTagsBar } from './components/CaptureTagsBar';
import { searchByText } from './captureTags';
import { CaptureDetails } from './components/CaptureDetails';
import { ToolbarGroup } from './components/ToolbarGroup';
import { sectionTitle, actionBtn, toggleOnBtn, toolbarCaption, toolbarDivider } from './styles';

const screenCache: ScreenCache = {
  capture: null,
  ocr: null,
  history: [],
  activity: [],
  probe: INITIAL_PROBE,
};

export function ScreenPage() {
  const { runShell } = useSunny();
  const { clock } = useClock();

  // Capture state — restored from the module-level cache so page navigation
  // doesn't wipe the last capture or its OCR.
  const [capture, setCapture] = useState<Capture | null>(screenCache.capture);
  const [history, setHistory] = useState<ReadonlyArray<Capture>>(screenCache.history);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [cadence, setCadence] = useState<AutoCadence>(() => loadPrefs().cadence);

  // Select-to-capture and OCR overlay
  const [selectMode, setSelectMode] = useState(false);
  const [showBoxes, setShowBoxes] = useState<boolean>(() => loadPrefs().showBoxes);
  const [ocrSearch, setOcrSearch] = useState('');
  const [ocrTextStore, setOcrTextStore] = useState<Map<string, string>>(new Map());
  const [tagsVersion, setTagsVersion] = useState(0);

  // OCR state
  const [ocr, setOcr] = useState<OcrResult | null>(screenCache.ocr);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrOptions, setOcrOptions] = useState<OcrOptions>(() => {
    const p = loadPrefs();
    return { psm: p.ocrPsm, minConf: p.ocrMinConf };
  });
  const [ocrPreserveLayout, setOcrPreserveLayout] = useState<boolean>(() => loadPrefs().ocrPreserveLayout);

  // Active window state
  const [focused, setFocused] = useState<FocusedApp | null>(null);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [windows, setWindows] = useState<ReadonlyArray<WindowInfo>>([]);

  // Screen size (points) for coordinate conversion
  const [screenSize, setScreenSize] = useState<ScreenSize | null>(null);

  // Region form (manual numeric)
  const [regionOpen, setRegionOpen] = useState(false);
  const [region, setRegion] = useState<RegionInput>({ x: '0', y: '0', w: '800', h: '600' });

  // Modal viewer
  const [viewerOpen, setViewerOpen] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Per-permission probe state, cached across navigations so the user
  // doesn't see a flash of UNKNOWN every time they re-enter the page.
  const [probe, setProbe] = useState<PermissionProbe>(screenCache.probe);
  const [relaunching, setRelaunching] = useState(false);

  // Activity timeline — restored from cache; seed only when this is the
  // first-ever mount in this tab.
  const [activity, setActivity] = useState<ReadonlyArray<Activity>>(() =>
    screenCache.activity.length > 0
      ? screenCache.activity
      : [{ id: makeId(), kind: 'SYS', time: nowTime(), text: 'Screen module online.' }],
  );

  // Ticking `now` drives relative age labels without calling Date.now() in render.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Mirror state → module cache so re-entering the page restores the view.
  useEffect(() => { screenCache.capture = capture; }, [capture]);
  useEffect(() => { screenCache.ocr = ocr; }, [ocr]);
  useEffect(() => { screenCache.history = history; }, [history]);
  useEffect(() => { screenCache.activity = activity; }, [activity]);
  useEffect(() => { screenCache.probe = probe; }, [probe]);

  // Persist UI preferences to localStorage across sessions.
  useEffect(() => {
    savePrefs({
      cadence,
      showBoxes,
      ocrPsm: ocrOptions.psm,
      ocrMinConf: ocrOptions.minConf,
      ocrPreserveLayout,
    });
  }, [cadence, showBoxes, ocrOptions, ocrPreserveLayout]);

  const flashToast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const pushActivity = useCallback((kind: ActivityKind, text: string) => {
    setActivity(prev => [{ id: makeId(), kind, time: nowTime(), text }, ...prev].slice(0, 80));
  }, []);

  // -- Polling: focused app, window list, screen size ---------------------

  const refreshFocused = useCallback(async () => {
    if (!isTauri) return;
    const [fa, t] = await Promise.all([
      invokeSafe<FocusedApp>('window_focused_app'),
      invokeSafe<string>('window_active_title'),
    ]);
    setFocused(prev => {
      if (fa && prev && (prev.name !== fa.name || prev.pid !== fa.pid)) {
        pushActivity('FOCUS', `Focus → ${fa.name}${fa.bundle_id ? ` · ${fa.bundle_id}` : ''}`);
      }
      return fa ?? prev;
    });
    setActiveTitle(t ?? null);
  }, [pushActivity]);

  const refreshWindows = useCallback(async () => {
    if (!isTauri) return;
    const list = await invokeSafe<WindowInfo[]>('window_list');
    if (list) setWindows(list);
  }, []);

  // Probe each permission with a tiny, cheap, read-only call. We run them
  // in parallel via Promise.allSettled so a single failure doesn't abort
  // the rest. Each rejection's message is surfaced to the user verbatim
  // so they can distinguish "permission denied" from other errors.
  const probePermissions = useCallback(async (opts?: { silent?: boolean }): Promise<PermissionProbe> => {
    if (!isTauri) {
      const unavailable: PermissionState = { status: 'missing', message: 'Tauri runtime unavailable' };
      const result: PermissionProbe = {
        screenRecording: unavailable,
        automation: unavailable,
        accessibility: unavailable,
        tesseract: unavailable,
        checkedAt: Date.now(),
      };
      setProbe(result);
      return result;
    }

    setProbe(prev => ({
      ...prev,
      screenRecording: { status: 'checking' },
      automation: { status: 'checking' },
      accessibility: { status: 'checking' },
      tesseract: { status: 'checking' },
    }));

    // Probe each permission with the cheapest authoritative call available:
    //   - Screen Recording → `CGPreflightScreenCaptureAccess` (no prompt,
    //     no capture).
    //   - Accessibility → `AXIsProcessTrusted` (no prompt, no event).
    //   - Automation → a minimal System Events bundle-id read. A timeout
    //     usually means a prompt is pending or System Events is slow; we
    //     annotate the message so the user doesn't read timeout as denial.
    //   - Tesseract → a tiny 1×1 PNG routed through `ocr_image_base64`.
    //     NOTE: Tauri v2 auto-converts the snake_case Rust arg `png_base64`
    //     into JS-side camelCase `pngBase64`; sending the snake_case key
    //     from JS raises "missing required key pngBase64" immediately.
    const [srAllowed, axAllowed, au, ts] = await Promise.allSettled([
      invoke<boolean>('permission_check_screen_recording'),
      invoke<boolean>('permission_check_accessibility'),
      invoke<boolean>('permission_check_automation'),
      // Probe tesseract with default options — any rejection here means the
      // binary itself is missing or broken, not a knob problem.
      invoke<OcrResult>('ocr_image_base64', { pngBase64: TINY_PNG_BASE64 }),
    ]);

    const boolToState = (r: PromiseSettledResult<boolean>): PermissionState => {
      if (r.status === 'rejected') {
        return { status: 'missing', message: errMsg(r.reason, 'TCC check failed') };
      }
      return r.value
        ? { status: 'granted' }
        : { status: 'missing', message: 'TCC reports not authorized — try RESET TCC GRANTS (signature may have changed)' };
    };

    const automationState: PermissionState = (() => {
      if (au.status === 'fulfilled') {
        if (au.value === true) return { status: 'granted' };
        return { status: 'missing', message: 'System Events reports not authorized — RESET TCC GRANTS and re-grant when prompted' };
      }
      const msg = errMsg(au.reason, 'automation check failed');
      if (/timed out|timeout/i.test(msg)) {
        return { status: 'missing', message: `${msg} · check for a pending macOS prompt, then RUN DIAGNOSTICS again` };
      }
      return { status: 'missing', message: msg };
    })();

    const tesseractState: PermissionState =
      ts.status === 'fulfilled'
        ? { status: 'granted' }
        : { status: 'missing', message: errMsg(ts.reason, 'tesseract check failed') };

    const next: PermissionProbe = {
      screenRecording: boolToState(srAllowed as PromiseSettledResult<boolean>),
      accessibility: boolToState(axAllowed as PromiseSettledResult<boolean>),
      automation: automationState,
      tesseract: tesseractState,
      checkedAt: Date.now(),
    };
    setProbe(next);

    if (!opts?.silent) {
      const keys: Array<keyof Pick<PermissionProbe, 'screenRecording' | 'automation' | 'accessibility' | 'tesseract'>> = ['screenRecording', 'automation', 'accessibility', 'tesseract'];
      const missing = keys
        .filter(k => next[k].status === 'missing');
      if (missing.length === 0) {
        flashToast('ALL PERMISSIONS GRANTED', 'ok');
        pushActivity('SYS', 'Diagnostics · all permissions OK');
      } else {
        flashToast(`MISSING · ${missing.join(', ')}`, 'err');
        pushActivity('ERR', `Diagnostics · missing: ${missing.join(', ')}`);
      }
    }

    return next;
  }, [flashToast, pushActivity]);

  useEffect(() => {
    if (!isTauri) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshFocused();
    void refreshWindows();
    // Screen size rarely changes; fetch once.
    void invokeSafe<[number, number]>('screen_size').then(sz => {
      if (sz) setScreenSize({ w: sz[0], h: sz[1] });
    });
    // Probe permissions silently on first mount so the Diagnostics card
    // reflects real state from the start. Skip re-probing on remount if
    // we already have a recent result cached in the module.
    if (screenCache.probe.checkedAt === 0) {
      void probePermissions({ silent: true });
    }
    const f = window.setInterval(() => { void refreshFocused(); }, SCREEN_POLL_INTERVAL_MS);
    const w = window.setInterval(() => { void refreshWindows(); }, WINDOW_LIST_INTERVAL_MS);
    return () => {
      window.clearInterval(f);
      window.clearInterval(w);
    };
  }, [refreshFocused, refreshWindows, probePermissions]);

  // -- Capture helpers ----------------------------------------------------

  const doCapture = useCallback(
    async (
      source: CaptureSource,
      cmd: string,
      args: Record<string, unknown> | undefined,
      regionArg?: { x: number; y: number; w: number; h: number },
      opts?: { silent?: boolean; appOverride?: string; titleOverride?: string },
    ): Promise<Capture | null> => {
      if (captureBusy) return null;
      if (!isTauri) {
        const msg = 'Tauri runtime unavailable — captures disabled in this mode';
        setCaptureError(msg);
        if (!opts?.silent) flashToast(msg, 'err');
        return null;
      }
      setCaptureBusy(true);
      setCaptureError(null);
      try {
        // Use direct `invoke` so we surface the real Rust error string instead
        // of the silent-null that invokeSafe would produce.
        const img = await invoke<import('./types').ScreenImage>(cmd, args);
        const cap: Capture = {
          id: makeId(),
          image: img,
          source,
          capturedAt: Date.now(),
          region: regionArg,
          app: opts?.appOverride ?? focused?.name,
          title: opts?.titleOverride ?? activeTitle ?? undefined,
        };
        setCapture(cap);
        setOcr(null);
        setOcrError(null);
        setOcrSearch('');
        setHistory(prev => [cap, ...prev.filter(c => c.id !== cap.id)].slice(0, HISTORY_LIMIT));
        // A successful capture implies Screen Recording is granted; reflect
        // that in the probe so stale MISSING badges clear immediately.
        setProbe(prev =>
          prev.screenRecording.status === 'granted'
            ? prev
            : { ...prev, screenRecording: { status: 'granted' }, checkedAt: Date.now() },
        );
        if (!opts?.silent) flashToast(`${source} · ${img.width}×${img.height}`, 'ok');
        pushActivity('SNAP', `${source} · ${img.width}×${img.height} · ${(img.bytes_len / 1024 / 1024).toFixed(2)} MB`);
        return cap;
      } catch (e) {
        const raw = errMsg(e, 'capture failed');
        setCaptureError(raw);

        // Screen-recording TCC failures are the #1 support issue here.
        // Mark the probe as MISSING and stop AUTO so we don't keep
        // retriggering the same error.
        if (isScreenRecordingPermissionError(raw)) {
          setProbe(prev => ({
            ...prev,
            screenRecording: { status: 'missing', message: raw },
            checkedAt: Date.now(),
          }));
          setCadence(prev => {
            if (prev !== 'OFF') {
              pushActivity('SYS', 'AUTO capture paused · waiting on Screen Recording permission');
            }
            return 'OFF';
          });
        }

        if (!opts?.silent) flashToast(`${source} · ${raw}`, 'err');
        pushActivity('ERR', `${source} · ${raw}`);
        return null;
      } finally {
        setCaptureBusy(false);
      }
    },
    [captureBusy, flashToast, pushActivity, focused, activeTitle],
  );

  const captureFull = useCallback(
    (opts?: { silent?: boolean }) => doCapture('FULL', 'screen_capture_full', undefined, undefined, opts),
    [doCapture],
  );

  const captureActiveWindow = useCallback(
    () => doCapture('ACTIVE WINDOW', 'screen_capture_active_window', undefined),
    [doCapture],
  );

  const captureRegionExplicit = useCallback(
    async (x: number, y: number, w: number, h: number, srcLabel: CaptureSource = 'REGION') => {
      await doCapture(srcLabel, 'screen_capture_region', { x, y, w, h }, { x, y, w, h });
    },
    [doCapture],
  );

  const captureRegionFromForm = useCallback(async () => {
    const x = Number.parseInt(region.x, 10);
    const y = Number.parseInt(region.y, 10);
    const w = Number.parseInt(region.w, 10);
    const h = Number.parseInt(region.h, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      flashToast('Invalid region — need integers and w,h ≥ 1', 'err');
      return;
    }
    await captureRegionExplicit(x, y, w, h);
    setRegionOpen(false);
  }, [captureRegionExplicit, region, flashToast]);

  const captureFromDrag = useCallback(
    async (r: DragRect) => {
      if (!capture) return;
      // Drag rect is in normalized image coords. Convert to screen points.
      // For FULL captures (which cover the whole logical screen) we use screenSize.
      // For ACTIVE WINDOW / REGION captures, we don't know the on-screen origin
      // from the image alone, so we bail with a helpful message.
      if (capture.source !== 'FULL' || !screenSize) {
        flashToast('SELECT REGION only works on a FULL-screen capture with a known screen size', 'err');
        return;
      }
      const n = normalizeDrag(r);
      const x = Math.round(n.u0 * screenSize.w);
      const y = Math.round(n.v0 * screenSize.h);
      const w = Math.max(1, Math.round((n.u1 - n.u0) * screenSize.w));
      const h = Math.max(1, Math.round((n.v1 - n.v0) * screenSize.h));
      await captureRegionExplicit(x, y, w, h, 'REGION');
      setSelectMode(false);
    },
    [capture, screenSize, captureRegionExplicit, flashToast],
  );

  // -- Auto-refresh timer -------------------------------------------------

  useEffect(() => {
    if (!isTauri) return;
    const ms = cadenceToMs(cadence);
    if (ms === null) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void captureFull({ silent: true });
      }
    }, ms);
    return () => window.clearInterval(id);
  }, [cadence, captureFull]);

  // -- OCR ---------------------------------------------------------------

  const runOcr = useCallback(async () => {
    if (!capture || ocrBusy) return;
    setOcrBusy(true);
    setOcrError(null);
    try {
      // Rust side expects camelCase field names via serde rename_all.
      const options = { psm: ocrOptions.psm, minConf: ocrOptions.minConf };
      const r = await invokeSafe<OcrResult>('ocr_image_base64', {
        pngBase64: capture.image.base64,
        options,
      });
      if (!r) {
        const msg = 'OCR failed — is `tesseract` installed? `brew install tesseract`';
        setOcrError(msg);
        pushActivity('ERR', msg);
        return;
      }
      setOcr(r);
      if (capture) {
        setOcrTextStore(prev => {
          const next = new Map(prev);
          next.set(capture.id, r.text);
          return next;
        });
      }
      pushActivity(
        'OCR',
        `OCR · psm${r.psm} · ${r.boxes.length} boxes · ${r.text.split(/\s+/).filter(Boolean).length} words · ${r.avg_confidence.toFixed(0)}% avg`,
      );
    } catch (e) {
      const msg = errMsg(e, 'OCR failed');
      setOcrError(msg);
      pushActivity('ERR', msg);
    } finally {
      setOcrBusy(false);
    }
  }, [capture, ocrBusy, ocrOptions, pushActivity]);

  const downloadOcrText = useCallback(() => {
    const txt = ocr?.text.trim() ?? '';
    if (!txt) {
      flashToast('No OCR text to save', 'err');
      return;
    }
    try {
      const blob = new Blob([ocr?.text ?? ''], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sunny-ocr-${fileTimestamp()}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flashToast(`OCR TEXT SAVED · ${txt.length} chars`, 'ok');
      pushActivity('OCR', `Saved OCR transcript (${txt.length} chars)`);
    } catch (e) {
      const msg = errMsg(e, 'download failed');
      flashToast(`SAVE FAILED · ${msg}`, 'err');
    }
  }, [ocr, flashToast, pushActivity]);

  const copyOcrText = useCallback(async () => {
    if (!ocr) return;
    const txt = ocr.text.trim();
    if (!txt) {
      flashToast('No OCR text to copy', 'err');
      return;
    }
    const ok = await copyTextToClipboard(txt);
    if (ok) {
      flashToast(`OCR TEXT COPIED · ${txt.length} chars`, 'ok');
      pushActivity('OCR', `Copied OCR text (${txt.length} chars)`);
    } else {
      flashToast('Clipboard unavailable', 'err');
    }
  }, [ocr, flashToast, pushActivity]);

  // OCR box click: if FULL capture + screenSize known, click on screen; else copy word.
  const onOcrBoxClick = useCallback(
    async (b: import('./types').OcrBox) => {
      if (!capture) return;
      const word = b.text.trim();
      if (capture.source === 'FULL' && screenSize && capture.image.width > 0) {
        // Convert from image pixel coords to logical screen point coords.
        const scale = capture.image.width / screenSize.w;
        const px = Math.round((b.x + b.w / 2) / scale);
        const py = Math.round((b.y + b.h / 2) / scale);
        const err = await invokeSafe<void>('mouse_click_at', { x: px, y: py, button: 'left', count: 1 });
        // invokeSafe returns null on success (void command) or on error.
        // We treat any non-exception as success since errors flow through the console logger.
        void err;
        flashToast(`CLICKED "${word.slice(0, 24)}" @ (${px},${py})`, 'ok');
        pushActivity('CLICK', `Clicked OCR box "${word.slice(0, 40)}" at (${px},${py})`);
      } else {
        const ok = await copyTextToClipboard(word);
        if (ok) {
          flashToast(`COPIED "${word.slice(0, 24)}"`, 'ok');
          pushActivity('OCR', `Copied word "${word.slice(0, 40)}"`);
        } else {
          flashToast('Clipboard unavailable', 'err');
        }
      }
    },
    [capture, screenSize, flashToast, pushActivity],
  );

  // -- Shell-backed actions ----------------------------------------------

  const runShellAction = useCallback(
    async (cmd: string, ok: string, fail: string, kind: ActivityKind, okText: string) => {
      try {
        const result = await runShell(cmd);
        if (result.code === 0) {
          flashToast(ok, 'ok');
          pushActivity(kind, okText);
        } else {
          const msg = result.stderr?.trim() || `exit ${result.code}`;
          flashToast(`${fail} · ${msg}`, 'err');
          pushActivity('ERR', `${fail} · ${msg}`);
        }
      } catch (e) {
        const msg = errMsg(e, 'shell offline');
        flashToast(`${fail} · ${msg}`, 'err');
        pushActivity('ERR', `${fail} · ${msg}`);
      }
    },
    [runShell, flashToast, pushActivity],
  );

  const screenshotToFile = useCallback(() => {
    const path = `~/Desktop/sunny-shot-${fileTimestamp()}.png`;
    void runShellAction(
      `screencapture -x ${path}`,
      `SHOT → ${path}`,
      'SHOT FAILED',
      'SNAP',
      `Saved · ${path}`,
    );
  }, [runShellAction]);

  const screenshotToClipboardShell = useCallback(() => {
    void runShellAction(
      'screencapture -c',
      'SHOT → CLIPBOARD',
      'CLIPBOARD SHOT FAILED',
      'SNAP',
      'Screenshot → system clipboard (shell)',
    );
  }, [runShellAction]);

  const toggleDarkMode = useCallback(async () => {
    // Using the dedicated `applescript` Tauri command instead of the
    // generic `runShell` path. runShell spawns a sidecar shell with its
    // own 30s watchdog and no Automation TCC entitlement, so the
    // `tell application "System Events"` event used to land in a
    // permission prompt that timed out before the user could tap Allow.
    // `applescript` runs osascript in the main app process, which is
    // the identity macOS already asked the user to approve for the
    // window_list probes, so dark-mode toggles go through instantly.
    if (!isTauri) {
      flashToast('Dark mode toggle requires Tauri runtime', 'err');
      return;
    }
    const script =
      'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode';
    try {
      await invoke<string>('applescript', { script });
      flashToast('DARK MODE TOGGLED', 'ok');
      pushActivity('SYS', 'Dark mode toggled');
    } catch (e) {
      const msg = errMsg(e, 'osascript failed');
      flashToast(`DARK MODE FAILED · ${msg}`, 'err');
      pushActivity('ERR', `Dark mode · ${msg}`);
    }
  }, [flashToast, pushActivity]);

  const lockScreen = useCallback(() => {
    void runShellAction(
      'pmset displaysleepnow',
      'DISPLAY SLEEP',
      'LOCK FAILED',
      'IDLE',
      'Display sleep invoked',
    );
  }, [runShellAction]);

  // -- Permission recovery (open settings / relaunch) --------------------

  const openSettingsPane = useCallback(
    (pane: PaneKey) => {
      const url = SETTINGS_URLS[pane];
      const label =
        pane === 'screenRecording' ? 'Screen Recording'
        : pane === 'automation' ? 'Automation'
        : 'Accessibility';
      void runShellAction(
        `open '${url}'`,
        `SETTINGS · ${label.toUpperCase()}`,
        `COULD NOT OPEN ${label.toUpperCase()}`,
        'SYS',
        `Opened Privacy · ${label}`,
      );
    },
    [runShellAction],
  );

  const relaunchSunny = useCallback(async () => {
    if (!isTauri) {
      flashToast('Relaunch requires the Tauri runtime', 'err');
      return;
    }
    setRelaunching(true);
    pushActivity('SYS', 'Relaunch requested — Sunny will quit and reopen');
    try {
      // `relaunch_app` never returns (process restart), so the await here
      // effectively blocks until the process dies.
      await invoke<void>('relaunch_app');
    } catch (e) {
      const msg = errMsg(e, 'relaunch failed');
      flashToast(`RELAUNCH FAILED · ${msg}`, 'err');
      pushActivity('ERR', `Relaunch failed · ${msg}`);
      setRelaunching(false);
    }
  }, [flashToast, pushActivity]);

  const resetTccGrants = useCallback(async () => {
    if (!isTauri) {
      flashToast('TCC reset requires the Tauri runtime', 'err');
      return;
    }
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      'Reset Sunny\'s TCC grants?\n\n' +
      'This runs `tccutil reset` on Sunny\'s bundle id for Screen Recording, ' +
      'Accessibility, AppleEvents, and Full Disk Access. macOS will re-prompt for each permission ' +
      'the next time it\'s needed — that\'s the canonical fix when a rebuild ' +
      'has changed the binary signature and the old grant no longer applies.\n\n' +
      'After OK, click RELAUNCH SUNNY, re-enable Full Disk Access for Sunny in System Settings if needed, ' +
      'then perform a capture / click / window query to trigger each fresh prompt.'
    );
    if (!ok) return;
    try {
      const r = await invoke<{ bundle_id: string; ok: string[]; failed: string[] }>(
        'tcc_reset_sunny',
        { bundleId: SUNNY_BUNDLE_ID },
      );
      const okMsg = r.ok.length > 0 ? `cleared ${r.ok.join(' + ')}` : 'no services cleared';
      const failMsg = r.failed.length > 0 ? ` · failed: ${r.failed.join(' · ')}` : '';
      flashToast(`TCC · ${okMsg}${failMsg}`, r.failed.length > 0 ? 'err' : 'ok');
      pushActivity('SYS', `TCC reset · ${okMsg}${failMsg}`);
      // Re-probe so the UI reflects the new (likely fresh MISSING) state.
      void probePermissions({ silent: true });
    } catch (e) {
      const msg = errMsg(e, 'tcc_reset_sunny failed');
      flashToast(`TCC RESET FAILED · ${msg}`, 'err');
      pushActivity('ERR', `TCC reset failed · ${msg}`);
    }
  }, [flashToast, pushActivity, probePermissions]);


  // -- Window list actions (activate / capture specific app) -------------

  const activateApp = useCallback(
    async (appName: string) => {
      if (!isTauri) return;
      const script = `tell application "${escapeAppleScriptString(appName)}" to activate`;
      try {
        await invokeSafe<string>('applescript', { script });
        flashToast(`FOCUS → ${appName}`, 'ok');
        pushActivity('FOCUS', `Activated ${appName}`);
        // Give the app a moment to come to the front, then refresh focus.
        setTimeout(() => { void refreshFocused(); }, 300);
      } catch (e) {
        const msg = errMsg(e, 'activate failed');
        flashToast(`FOCUS FAILED · ${msg}`, 'err');
        pushActivity('ERR', `Activate ${appName} · ${msg}`);
      }
    },
    [flashToast, pushActivity, refreshFocused],
  );

  const captureSpecificApp = useCallback(
    async (appName: string) => {
      if (!isTauri) return;
      const script = `tell application "${escapeAppleScriptString(appName)}" to activate`;
      try {
        await invokeSafe<string>('applescript', { script });
      } catch {
        // best-effort; still try the capture
      }
      // Small delay so the window actually becomes frontmost before screencapture fires.
      await new Promise(r => setTimeout(r, 250));
      await doCapture(
        'ACTIVE WINDOW',
        'screen_capture_active_window',
        undefined,
        undefined,
        { appOverride: appName },
      );
    },
    [doCapture],
  );

  // -- Capture-level actions ---------------------------------------------

  const onDownload = useCallback(async () => {
    if (!capture) return;
    await downloadPng(
      capture.image,
      `sunny-${capture.source.toLowerCase().replace(/\s+/g, '-')}-${fileTimestamp()}.png`,
    );
    pushActivity('SNAP', 'Downloaded PNG to browser downloads');
    flashToast('PNG DOWNLOADED', 'ok');
  }, [capture, flashToast, pushActivity]);

  const onCopyImage = useCallback(async () => {
    if (!capture) return;
    const ok = await copyImageToClipboard(capture.image);
    if (ok) {
      flashToast('IMAGE → CLIPBOARD', 'ok');
      pushActivity('SNAP', 'Image copied to clipboard (browser)');
    } else {
      flashToast('Clipboard image write unsupported — falling back to shell', 'err');
      screenshotToClipboardShell();
    }
  }, [capture, flashToast, pushActivity, screenshotToClipboardShell]);

  const onClearCapture = useCallback(() => {
    setCapture(null);
    setOcr(null);
    setOcrError(null);
    setCaptureError(null);
    setSelectMode(false);
    setShowBoxes(false);
    setOcrSearch('');
  }, []);

  const restoreFromHistory = useCallback((c: Capture) => {
    setCapture(c);
    setOcr(null);
    setOcrError(null);
    setOcrSearch('');
    setSelectMode(false);
    pushActivity('SNAP', `Restored ${c.source} from history · ${c.image.width}×${c.image.height}`);
  }, [pushActivity]);

  // -- Keyboard shortcuts ------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase();
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;

      if (e.key === 'Escape') {
        if (viewerOpen) {
          setViewerOpen(false);
          e.preventDefault();
          return;
        }
        if (selectMode) {
          setSelectMode(false);
          e.preventDefault();
          return;
        }
        return;
      }
      // ⌘R / Ctrl+R — recapture (re-run the same source as the current capture,
      // or full-screen when nothing is on deck). macOS's default ⌘R reload
      // would wipe the whole HUD, so we intercept it here even inside inputs.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (capture?.source === 'ACTIVE WINDOW') {
          void captureActiveWindow();
        } else if (capture?.source === 'REGION' && capture.region) {
          const { x, y, w, h } = capture.region;
          void captureRegionExplicit(x, y, w, h, 'REGION');
        } else {
          void captureFull();
        }
        return;
      }

      if (isEditable) return;

      if (e.code === 'Space') {
        e.preventDefault();
        void captureFull();
        return;
      }
      if (e.key.toLowerCase() === 'o') {
        if (capture) {
          e.preventDefault();
          void runOcr();
        }
        return;
      }
      if (e.key.toLowerCase() === 'd') {
        if (capture) {
          e.preventDefault();
          void onDownload();
        }
        return;
      }
      if (e.key.toLowerCase() === 'c') {
        if (capture) {
          e.preventDefault();
          void onCopyImage();
        }
        return;
      }
      if (e.key.toLowerCase() === 'b') {
        if (capture) {
          e.preventDefault();
          setShowBoxes(v => !v);
        }
        return;
      }
      if (e.key.toLowerCase() === 's') {
        if (capture) {
          e.preventDefault();
          setSelectMode(v => !v);
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capture, selectMode, viewerOpen, captureFull, captureActiveWindow, captureRegionExplicit, runOcr, onDownload, onCopyImage]);

  // -- UI assembly -------------------------------------------------------

  const toastStyle: CSSProperties = {
    position: 'absolute',
    top: 10,
    right: 16,
    padding: '6px 12px',
    border: `1px solid ${toast?.kind === 'err' ? 'rgba(255,77,94,0.6)' : 'var(--line)'}`,
    background: toast?.kind === 'err' ? 'rgba(255,77,94,0.12)' : 'rgba(57, 229, 255, 0.1)',
    color: toast?.kind === 'err' ? 'var(--red)' : 'var(--cyan)',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    letterSpacing: '0.16em',
    zIndex: 6,
    boxShadow: '0 0 10px rgba(57, 229, 255, 0.2)',
  };

  const badge = useMemo(() => {
    const parts = [`${windows.length} WINDOWS`];
    if (capture) parts.push(`${capture.image.width}×${capture.image.height}`);
    if (screenSize) parts.push(`${screenSize.w}×${screenSize.h}pt`);
    parts.push(`${activity.length} EVENTS`);
    return parts.join(' · ');
  }, [windows.length, capture, screenSize, activity.length]);

  const boxesClickable = !!capture && capture.source === 'FULL' && !!screenSize;

  return (
    <ModuleView title="SCREEN" badge={badge}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {toast && <div style={toastStyle}>{toast.text}</div>}

        <DiagnosticsCard
          probe={probe}
          onProbe={() => { void probePermissions(); }}
          onOpenPane={openSettingsPane}
          onRelaunch={() => { void relaunchSunny(); }}
          onResetTcc={() => { void resetTccGrants(); }}
          relaunching={relaunching}
          now={now}
        />

        {/* TOP: preview + active window */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 12 }}>
          <LivePreview
            capture={capture}
            busy={captureBusy}
            error={captureError}
            cadence={cadence}
            onCadenceChange={setCadence}
            onRefresh={() => { void captureFull(); }}
            onOpenInViewer={() => setViewerOpen(true)}
            now={now}
            selectMode={selectMode}
            onToggleSelect={() => setSelectMode(v => !v)}
            onCaptureSelection={r => { void captureFromDrag(r); }}
            showBoxes={showBoxes}
            onToggleBoxes={() => setShowBoxes(v => !v)}
            ocr={ocr}
            boxesClickable={boxesClickable}
            onBoxClick={b => { void onOcrBoxClick(b); }}
            searchTerm={ocrSearch}
            onSearchTerm={setOcrSearch}
            screenRecordingMissing={probe.screenRecording.status === 'missing'}
            onOpenScreenRecordingSettings={() => openSettingsPane('screenRecording')}
          />
          <ActiveWindowCard
            focused={focused}
            title={activeTitle}
            windows={windows}
            onCaptureActive={() => { void captureActiveWindow(); }}
            onRefreshList={() => { void refreshWindows(); void refreshFocused(); }}
            onActivateApp={name => { void activateApp(name); }}
            onCaptureApp={name => { void captureSpecificApp(name); }}
            busy={captureBusy}
          />
        </div>

        {/* ACTION STRIP — grouped toolbar. CAPTURE lives inside the preview
            cards; this strip hosts ancillary shell commands and the shortcut
            legend so the page has a single "command bar" feel instead of a
            wrapping row of unlabeled buttons. */}
        <div
          className="section"
          style={{
            padding: '8px 12px',
            margin: 0,
            display: 'flex',
            alignItems: 'flex-end',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              paddingRight: 4,
            }}
          >
            <span style={toolbarCaption}>STATUS</span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.18em',
                color: 'var(--cyan)',
                fontWeight: 700,
              }}
            >
              LIVE · {clock}
            </span>
          </div>

          <div style={toolbarDivider} aria-hidden />

          <ToolbarGroup caption="CAPTURE">
            <button
              onClick={() => { void captureFull(); }}
              disabled={captureBusy || !isTauri}
              style={actionBtn}
              title="Capture the full logical screen (hotkey: SPACE)"
            >
              FULL SCREEN
            </button>
            <button
              onClick={() => { void captureActiveWindow(); }}
              disabled={captureBusy || !isTauri}
              style={actionBtn}
              title="Capture just the frontmost window"
            >
              ACTIVE WINDOW
            </button>
            <button
              onClick={() => setRegionOpen(o => !o)}
              disabled={!isTauri}
              style={regionOpen ? toggleOnBtn : { ...actionBtn, color: 'var(--cyan-2)' }}
              title="Open / close the numeric region form below"
            >
              {regionOpen ? 'REGION · OPEN' : 'REGION · MANUAL'}
            </button>
          </ToolbarGroup>

          <div style={toolbarDivider} aria-hidden />

          <ToolbarGroup caption="EXPORT · SHELL">
            <button
              onClick={screenshotToFile}
              style={{ ...actionBtn, color: 'var(--green)', borderColor: 'rgba(125,255,154,0.45)' }}
              title="Silent screencapture → ~/Desktop PNG"
            >
              SHOT → FILE
            </button>
            <button
              onClick={screenshotToClipboardShell}
              style={{ ...actionBtn, color: 'var(--green)', borderColor: 'rgba(125,255,154,0.45)' }}
              title="Silent screencapture → system clipboard"
            >
              SHOT → CLIP
            </button>
          </ToolbarGroup>

          <div style={toolbarDivider} aria-hidden />

          <ToolbarGroup caption="SYSTEM">
            <button
              onClick={() => { void toggleDarkMode(); }}
              style={{ ...actionBtn, color: 'var(--violet)', borderColor: 'rgba(180,140,255,0.5)' }}
              title="Toggle macOS appearance (light/dark)"
            >
              TOGGLE DARK
            </button>
            <button
              onClick={lockScreen}
              style={{ ...actionBtn, color: 'var(--amber)', borderColor: 'rgba(255,179,71,0.5)' }}
              title="Put the display to sleep (pmset displaysleepnow)"
            >
              DISPLAY SLEEP
            </button>
          </ToolbarGroup>

          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              minWidth: 0,
            }}
          >
            <span style={toolbarCaption}>SHORTCUTS</span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.18em',
                color: 'var(--ink-2)',
              }}
            >
              SPACE · ⌘R · O · B · S · D · C · ESC
            </span>
          </div>
        </div>

        {regionOpen && (
          <RegionForm
            value={region}
            onChange={setRegion}
            onSubmit={() => { void captureRegionFromForm(); }}
            onCancel={() => setRegionOpen(false)}
            busy={captureBusy}
            screenSize={screenSize}
          />
        )}

        {/* HISTORY */}
        <HistoryStrip
          history={history}
          currentId={capture?.id ?? null}
          onRestore={restoreFromHistory}
          now={now}
          ocrMatchIds={ocrSearch.trim() ? new Set(searchByText(ocrTextStore, ocrSearch)) : undefined}
          tagsVersion={tagsVersion}
        />

        {/* CAPTURE + OCR */}
        <CaptureDetails
          capture={capture}
          ocr={ocr}
          ocrBusy={ocrBusy}
          ocrError={ocrError}
          ocrOptions={ocrOptions}
          preserveLayout={ocrPreserveLayout}
          onSetOcrOptions={setOcrOptions}
          onSetPreserveLayout={setOcrPreserveLayout}
          onRunOcr={() => { void runOcr(); }}
          onCopyOcr={() => { void copyOcrText(); }}
          onDownloadOcr={downloadOcrText}
          onDownload={() => { void onDownload(); }}
          onCopyImage={() => { void onCopyImage(); }}
          onCopyToClipboardShell={screenshotToClipboardShell}
          onClear={onClearCapture}
        />

        {/* CAPTURE TAGS */}
        {capture && (
          <div className="section" style={{ padding: '8px 12px', margin: 0 }}>
            <CaptureTagsBar captureId={capture.id} onChanged={() => setTagsVersion(v => v + 1)} />
          </div>
        )}

        {/* TIMELAPSE MODE */}
        <div className="section" style={{ padding: '8px 12px', margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.16em', color: 'var(--ink-dim)', flexShrink: 0 }}>TIMELAPSE</span>
          {(['OFF', '5s', '15s', '60s'] as const).map(opt => (
            <button
              key={opt}
              onClick={() => setCadence(opt)}
              style={{
                all: 'unset', cursor: 'pointer',
                padding: '3px 10px',
                border: `1px solid ${cadence === opt ? 'var(--cyan)' : 'var(--line-soft)'}`,
                background: cadence === opt ? 'rgba(57,229,255,0.14)' : 'rgba(0,0,0,0.25)',
                color: cadence === opt ? 'var(--cyan)' : 'var(--ink-2)',
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
                transition: 'background 120ms ease',
              }}
            >{opt}</button>
          ))}
          {cadence !== 'OFF' && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', letterSpacing: '0.1em' }}>
              AUTO · every {cadence}
            </span>
          )}
        </div>

        {/* ACTIVITY TIMELINE */}
        <div className="section" style={{ padding: 12, margin: 0 }}>
          <div style={sectionTitle}>
            <span>ACTIVITY TIMELINE</span>
            <span style={{ color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 10 }}>
              {activity.length} EVENT{activity.length === 1 ? '' : 'S'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 240, overflow: 'auto' }}>
            {activity.map(a => (
              <div
                key={a.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '56px 58px 1fr',
                  gap: 12,
                  padding: '7px 6px',
                  borderBottom: '1px dashed rgba(57, 229, 255, 0.08)',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--cyan)' }}>
                  {a.time}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.15em',
                    color: kindColor(a.kind),
                    fontWeight: 600,
                  }}
                >
                  {a.kind}
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modal viewer */}
      {viewerOpen && capture && (
        <div
          onClick={() => setViewerOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2,6,10,0.88)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 30,
            cursor: 'zoom-out',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 16,
              right: 20,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.18em',
              color: 'var(--cyan)',
              padding: '4px 10px',
              border: '1px solid var(--line)',
            }}
          >
            ESC · CLOSE
          </div>
          <img
            src={dataUrl(capture.image)}
            alt="full capture"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              boxShadow: '0 0 40px rgba(57,229,255,0.25)',
              border: '1px solid var(--line-soft)',
            }}
          />
        </div>
      )}
    </ModuleView>
  );
}
