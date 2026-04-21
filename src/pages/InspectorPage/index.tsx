/**
 * INSPECTOR — peek at what Sunny sees when she automates the screen.
 *
 * Split into focused sub-components:
 *  - CursorMap: proportional screen miniature with live cursor dot
 *  - WindowList: filtered, sorted window list with geometry bars
 *  - OcrSection: screen OCR with search, stats, and AI actions
 *
 * This file owns the data hooks and distributes to sub-components.
 */

import { useEffect, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, Row, Chip, StatBlock,
  Toolbar, ToolbarButton, PageLead, useFlashMessage, usePoll,
} from '../_shared';
import {
  downloadTextFile,
  inspectorSessionJson,
  inspectorSnapshotText,
} from '../_shared/snapshots';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import { useView } from '../../store/view';
import {
  activeTitle, cursorPosition, focusedApp, listWindows, ocrFullScreen, screenSize,
  type OcrResult,
} from './api';
import { CursorMap } from './CursorMap';
import { WindowList } from './WindowList';
import { OcrSection } from './OcrSection';

export function InspectorPage() {
  const ocrCap = useView(s => s.settings.inspectorOcrMaxChars);
  const { data: focused, reload: reloadFocused } = usePoll(focusedApp, 2000);
  const { data: title, reload: reloadTitle } = usePoll(activeTitle, 2000);
  const { data: windows, reload: reloadWindows } = usePoll(listWindows, 3000);
  const { data: size, reload: reloadSize } = usePoll(screenSize, 10_000);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [ocring, setOcring] = useState(false);
  const { message: copyHint, flash } = useFlashMessage();

  // Fix 3: cursor polling (1 s) is gated to document visibility so it does
  // not fire when the tab is hidden. A visibility-change listener re-triggers
  // the poll only when the tab becomes visible again, keeping the readout
  // fresh on re-focus without stacking invokes while backgrounded.
  const [cursor, setCursor] = useState<Awaited<ReturnType<typeof cursorPosition>> | null>(null);
  const cursorTimerRef = useRef<number | null>(null);
  const reloadCursor = () => {
    if (document.visibilityState !== 'visible') return;
    void cursorPosition().then(pos => setCursor(pos)).catch(() => { /* best-effort */ });
  };

  useEffect(() => {
    reloadCursor();
    cursorTimerRef.current = window.setInterval(() => {
      if (document.visibilityState === 'visible') reloadCursor();
    }, 1000);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') reloadCursor();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (cursorTimerRef.current !== null) window.clearInterval(cursorTimerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allWindows = windows ?? [];
  const focusedWindow = allWindows.find(w => w.app_name === focused?.name);

  const refreshAll = () => {
    reloadFocused();
    reloadTitle();
    reloadWindows();
    reloadSize();
    reloadCursor();
    flash('Refreshed accessibility snapshot');
  };

  const runOcr = async () => {
    setOcring(true);
    try { const r = await ocrFullScreen(); setOcr(r); }
    finally { setOcring(false); }
  };

  return (
    <ModuleView title="INSPECTOR · ACCESSIBILITY">
      <PageGrid>
        {/* Row 1: Stats + Actions */}
        <PageCell span={12}>
          <PageLead>
            macOS accessibility readout: focused app, window geometry, cursor map, and optional full-screen OCR for automation context.
          </PageLead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <StatBlock label="FOCUSED" value={focused?.name ?? '—'} sub={focused?.bundle_id ?? undefined} tone="cyan" />
            <StatBlock label="TITLE" value={title ? (title.length > 24 ? `${title.slice(0, 22)}…` : title) : '—'} sub="active window" tone="violet" />
            <StatBlock label="WINDOWS" value={String(allWindows.length)} sub={`${new Set(allWindows.map(w => w.app_name)).size} apps`} tone="amber" />
            <StatBlock label="SCREEN" value={size ? `${size.width}×${size.height}` : '—'} sub="resolution" tone="green" />
            <StatBlock label="CURSOR" value={cursor ? `${cursor.x},${cursor.y}` : '—'} sub={cursor && size ? `${cursor.x < size.width / 2 ? 'left' : 'right'} ${cursor.y < size.height / 2 ? 'top' : 'bottom'}` : 'position'} tone="cyan" />
          </div>
          <Toolbar style={{ flexWrap: 'wrap', marginTop: 6 }}>
            <ToolbarButton tone="cyan" title="Re-fetch all accessibility data" onClick={refreshAll}>
              ◎ REFRESH ALL
            </ToolbarButton>
            <ToolbarButton
              tone="violet"
              title="Copy layout summary as plain text"
              onClick={async () => {
                const ok = await copyToClipboard(inspectorSnapshotText({
                  focused,
                  title: title ?? null,
                  size,
                  cursor,
                  windowCount: allWindows.length,
                }));
                flash(ok ? 'Layout summary copied' : 'Copy failed');
              }}
            >
              COPY LAYOUT
            </ToolbarButton>
            <ToolbarButton
              tone="amber"
              title="Download full snapshot JSON"
              onClick={() => {
                downloadTextFile(
                  `sunny-inspector-${Date.now()}.json`,
                  inspectorSessionJson({
                    focused: focused ?? null,
                    activeTitle: title ?? null,
                    screen: size ? { width: size.width, height: size.height } : null,
                    cursor,
                    windows: allWindows,
                    ocr,
                  }),
                  'application/json',
                );
                flash('Session JSON download started');
              }}
            >
              DOWNLOAD JSON
            </ToolbarButton>
            <ToolbarButton
              tone="green"
              title="Ask Sunny to analyze the current screen layout"
              onClick={() => {
                const summary = [
                  `Focused: ${focused?.name ?? 'unknown'} — "${title ?? 'no title'}"`,
                  `Screen: ${size ? `${size.width}×${size.height}` : 'unknown'}`,
                  `Cursor: ${cursor ? `${cursor.x},${cursor.y}` : 'unknown'}`,
                  `Windows: ${allWindows.length} open across ${new Set(allWindows.map(w => w.app_name)).size} apps`,
                  '',
                  ...allWindows.slice(0, 10).map(w =>
                    `  • ${w.app_name}: "${w.title || '(no title)'}" at ${w.x != null ? `${Math.round(w.x)},${Math.round(w.y ?? 0)}` : '?'} size ${w.w != null ? `${Math.round(w.w)}×${Math.round(w.h ?? 0)}` : '?'}`,
                  ),
                ].join('\n');
                askSunny(
                  `Here's my current screen layout:\n\n${summary}\n\nAnalyze the workspace and suggest any optimizations.`,
                  'inspector',
                );
              }}
            >
              ✦ ANALYZE LAYOUT
            </ToolbarButton>
            {copyHint && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
            )}
          </Toolbar>
        </PageCell>

        {/* Row 2: Focus + Cursor (6) | Windows (6) */}
        <PageCell span={6}>
          <Section
            title="FOCUS"
            right={focused ? (
              <Chip tone="cyan">{focused.name}</Chip>
            ) : 'no focus'}
          >
            <Row label="app" value={focused?.name ?? '—'} />
            <Row label="bundle" value={focused?.bundle_id ?? '—'} />
            <Row label="pid" value={focused ? String(focused.pid) : '—'} />
            <Row label="title" value={title ?? '—'} />
            {focusedWindow && (
              <>
                <Row
                  label="position"
                  value={focusedWindow.x != null
                    ? `${Math.round(focusedWindow.x)}, ${Math.round(focusedWindow.y ?? 0)}`
                    : '—'}
                />
                <Row
                  label="size"
                  value={focusedWindow.w != null
                    ? `${Math.round(focusedWindow.w)} × ${Math.round(focusedWindow.h ?? 0)}`
                    : '—'}
                />
              </>
            )}
          </Section>

          <Section title="CURSOR MAP" right={cursor ? `${cursor.x}, ${cursor.y}` : 'no cursor'}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <CursorMap cursor={cursor} screen={size} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {size && (
                  <>
                    <Row label="screen w" value={`${size.width}px`} />
                    <Row label="screen h" value={`${size.height}px`} />
                  </>
                )}
                {cursor && (
                  <>
                    <Row label="cursor x" value={String(cursor.x)} />
                    <Row label="cursor y" value={String(cursor.y)} />
                    {size && (
                      <Row
                        label="quadrant"
                        value={
                          <Chip tone="cyan">
                            {cursor.x < size.width / 2 ? 'LEFT' : 'RIGHT'} / {cursor.y < size.height / 2 ? 'TOP' : 'BOTTOM'}
                          </Chip>
                        }
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          </Section>
        </PageCell>

        <PageCell span={6}>
          <WindowList windows={allWindows} focused={focused ?? null} />
        </PageCell>

        {/* Row 3: OCR (full width) */}
        <PageCell span={12}>
          <OcrSection ocr={ocr} ocring={ocring} ocrCap={ocrCap} onRunOcr={runOcr} />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
