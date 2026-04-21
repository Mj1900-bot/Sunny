/**
 * WindowList — filtered, sorted window list with per-row copy
 * and window geometry details. Extracted from InspectorPage.
 *
 * Upgraded with:
 *  - Window size visualization (width bar)
 *  - Staggered entrance animations
 *  - App grouping badges
 *  - Better focused window highlight
 */

import { useMemo, useState } from 'react';
import {
  Section, EmptyState, Chip, ScrollList,
  Toolbar, ToolbarButton, TabBar, FilterInput, useFlashMessage,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { windowInfoLineTsv, windowsTsv } from '../_shared/snapshots';
import type { WindowInfo, FocusedApp } from './api';

type WinSort = 'app' | 'title';

export function WindowList({
  windows,
  focused,
}: {
  windows: ReadonlyArray<WindowInfo>;
  focused: FocusedApp | null;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<WinSort>('app');
  const { message: copyHint, flash } = useFlashMessage();

  const sorted = useMemo(() => {
    const arr = [...windows];
    if (sort === 'app') {
      return arr.sort(
        (a, b) => a.app_name.localeCompare(b.app_name) || (a.title || '').localeCompare(b.title || ''),
      );
    }
    return arr.sort(
      (a, b) => (a.title || '').localeCompare(b.title || '') || a.app_name.localeCompare(b.app_name),
    );
  }, [windows, sort]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(w =>
      w.app_name.toLowerCase().includes(q) ||
      (w.title || '').toLowerCase().includes(q) ||
      String(w.pid).includes(q),
    );
  }, [sorted, query]);

  // Count unique apps
  const appCount = useMemo(
    () => new Set(windows.map(w => w.app_name)).size,
    [windows],
  );

  // Max window width for relative bar sizing
  const maxW = useMemo(
    () => Math.max(...windows.map(w => w.w ?? 0), 1),
    [windows],
  );

  return (
    <Section
      title="ALL WINDOWS"
      right={
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
            {filtered.length}{filtered.length !== sorted.length ? ` / ${sorted.length}` : ''} windows
          </span>
          <Chip tone="violet">{appCount} apps</Chip>
          <ToolbarButton
            tone="cyan"
            disabled={sorted.length === 0}
            title="Copy all windows as TSV"
            onClick={async () => {
              const ok = await copyToClipboard(windowsTsv(sorted));
              flash(ok ? 'Window list copied' : 'Copy failed');
            }}
          >
            COPY ALL
          </ToolbarButton>
          {copyHint && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
          )}
        </span>
      }
    >
      {sorted.length === 0 ? (
        <EmptyState title="No windows" hint="Accessibility may not be granted." />
      ) : (
        <>
          <Toolbar style={{ marginBottom: 4 }}>
            <FilterInput
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter by app, title, or pid…"
              aria-label="Filter windows"
              spellCheck={false}
            />
          </Toolbar>
          <TabBar
            value={sort}
            onChange={v => setSort(v as WinSort)}
            tabs={[
              { id: 'app', label: 'BY APP' },
              { id: 'title', label: 'BY TITLE' },
            ]}
          />
          {filtered.length === 0 ? (
            <EmptyState title="No matches" hint="Try a shorter query." />
          ) : (
            <ScrollList maxHeight={280}>
              {filtered.map((w, i) => {
                const isFocused = w.app_name === focused?.name;
                const widthPct = w.w != null ? Math.min(100, (w.w / maxW) * 100) : 0;
                return (
                  <div
                    key={`${w.pid}-${w.window_id ?? i}`}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 4,
                      padding: '8px 10px',
                      border: `1px solid ${isFocused ? 'var(--cyan)33' : 'var(--line-soft)'}`,
                      borderLeft: `3px solid ${isFocused ? 'var(--cyan)' : 'var(--line-soft)'}`,
                      background: isFocused
                        ? 'linear-gradient(90deg, rgba(57, 229, 255, 0.05), transparent 40%)'
                        : 'transparent',
                      transition: 'all 150ms ease',
                      animation: `fadeSlideIn 150ms ease ${i * 20}ms both`,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {isFocused && (
                        <span style={{
                          width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                          background: 'var(--cyan)',
                          boxShadow: '0 0 4px var(--cyan)',
                        }} />
                      )}
                      <Chip tone={isFocused ? 'cyan' : 'dim'}>{w.app_name}</Chip>
                      <span style={{
                        flex: 1, minWidth: 0, fontFamily: 'var(--label)', fontSize: 12,
                        color: 'var(--ink)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{w.title || '(no title)'}</span>
                      <ToolbarButton
                        tone="violet"
                        title="Copy this window row"
                        onClick={async () => {
                          const ok = await copyToClipboard(windowInfoLineTsv(w));
                          flash(ok ? 'Row copied' : 'Copy failed');
                        }}
                      >
                        ROW
                      </ToolbarButton>
                    </div>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
                      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                    }}>
                      <span>pid {w.pid}</span>
                      {w.x != null && w.w != null && (
                        <>
                          <span>pos {Math.round(w.x)},{Math.round(w.y ?? 0)}</span>
                          <span>size {Math.round(w.w)}×{Math.round(w.h ?? 0)}</span>
                          {/* Width bar */}
                          <div style={{
                            width: 40, height: 3,
                            background: 'rgba(255,255,255,0.04)',
                            overflow: 'hidden', flexShrink: 0,
                          }}>
                            <div style={{
                              height: '100%',
                              width: `${widthPct}%`,
                              background: isFocused ? 'var(--cyan)' : 'var(--ink-dim)',
                              transition: 'width 300ms ease',
                            }} />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </ScrollList>
          )}
        </>
      )}
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(3px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Section>
  );
}
