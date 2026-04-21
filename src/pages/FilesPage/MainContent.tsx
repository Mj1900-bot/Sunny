import type React from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  EmptyState, FilterChip, SortHeader, ToolbarBtn,
} from './components';
import { GridTile } from './GridTile';
import { ListRow } from './ListRow';
import { PreviewPane } from './PreviewPane';
import { fmtRelative, fmtSize } from './utils';
import type {
  Entry, FsDirSize, FsReadText, KindFilter, SortDir, SortKey, ViewMode,
} from './types';

// ---------------------------------------------------------------------------
// MainContent — address bar, breadcrumb, search, list/grid, footer, preview
// ---------------------------------------------------------------------------

export function MainContent({
  // navigation
  path, setPath, draft, setDraft, submitDraft, segments,
  // listing
  err, loading, sorted, counts, nowSecs,
  setReloadTick,
  // search
  query, setQuery, recursiveResults, setRecursiveResults,
  recursiveBusy, runRecursiveSearch, searchRef,
  // filtering / sorting / view
  kindFilter, setKindFilter,
  viewMode, sortKey, setSortKey, sortDir, setSortDir,
  // selection
  selected, focusPath, selectedEntries, selectedSize,
  onRowClick, clearSelection,
  // preview
  preview, previewFor, dirMeta, dirMetaFor,
  // rename / create
  renaming, setRenaming, renameDraft, setRenameDraft,
  startRename, commitRename,
  creating, setCreating, createDraft, setCreateDraft, commitCreate,
  // actions
  onCopyPath, onReveal, onTrashMany, onDuplicate,
  // misc
  listRef,
  lastLoadedAt,
  showToast,
}: {
  path: string;
  setPath: (p: string) => void;
  draft: string;
  setDraft: (d: string) => void;
  submitDraft: () => void;
  segments: ReadonlyArray<{ label: string; path: string }>;
  err: string | null;
  loading: boolean;
  sorted: ReadonlyArray<Entry>;
  counts: { total: number; dir: number; file: number };
  nowSecs: number;
  setReloadTick: (fn: (t: number) => number) => void;
  query: string;
  setQuery: (q: string) => void;
  recursiveResults: ReadonlyArray<Entry> | null;
  setRecursiveResults: (r: ReadonlyArray<Entry> | null) => void;
  recursiveBusy: boolean;
  runRecursiveSearch: (q: string) => Promise<void>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  kindFilter: KindFilter;
  setKindFilter: (k: KindFilter) => void;
  viewMode: ViewMode;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  sortDir: SortDir;
  setSortDir: (d: SortDir) => void;
  selected: ReadonlySet<string>;
  focusPath: string | null;
  selectedEntries: ReadonlyArray<Entry>;
  selectedSize: number;
  onRowClick: (e: Entry, ev: React.MouseEvent) => void;
  clearSelection: () => void;
  preview: FsReadText | null;
  previewFor: string | null;
  dirMeta: FsDirSize | null;
  dirMetaFor: string | null;
  renaming: string | null;
  setRenaming: (v: string | null) => void;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  startRename: (e: Entry) => void;
  commitRename: () => void;
  creating: null | 'file' | 'folder';
  setCreating: (v: null | 'file' | 'folder') => void;
  createDraft: string;
  setCreateDraft: (v: string) => void;
  commitCreate: () => void;
  onCopyPath: (p: string | string[]) => Promise<void>;
  onReveal: (p: string) => Promise<void>;
  onTrashMany: (paths: ReadonlyArray<string>) => Promise<void>;
  onDuplicate: (e: Entry) => Promise<void>;
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Epoch millis of the last successful listing completion. */
  lastLoadedAt: number;
  showToast: (tone: 'ok' | 'err', msg: string) => void;
}) {
  // Derive a "REFRESHED Ns AGO" string from the listing stamp. `fmtRelative`
  // speaks Unix seconds; convert once per render (cheap).
  const lastLoadedLabel = fmtRelative(Math.floor(lastLoadedAt / 1000), nowSecs);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: selectedEntries.length === 1 ? 'minmax(0, 1fr) 340px' : '1fr',
        gap: 14,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Address bar */}
        <div
          className="section"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 8,
            alignItems: 'center',
            padding: 8,
            marginBottom: 8,
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitDraft(); }}
            placeholder="~/Documents"
            spellCheck={false}
            style={{ fontSize: 12, padding: '8px 10px', fontFamily: 'var(--mono)' }}
          />
          <button className="primary" onClick={submitDraft} style={{ padding: '8px 14px' }}>GO</button>
        </div>

        {/* Breadcrumb + selection toolbar */}
        <div
          className="section"
          style={{
            padding: '8px 10px',
            marginBottom: 8,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            fontFamily: 'var(--mono)',
            fontSize: 11,
          }}
        >
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;
            return (
              <span key={`${seg.path}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {i > 0 && <span style={{ color: 'var(--ink-dim)' }}>›</span>}
                <button
                  onClick={() => !isLast && setPath(seg.path)}
                  disabled={isLast}
                  style={{
                    all: 'unset',
                    cursor: isLast ? 'default' : 'pointer',
                    color: isLast ? 'var(--cyan)' : 'var(--ink-2)',
                    fontWeight: isLast ? 800 : 500,
                    letterSpacing: isLast ? '0.14em' : '0.08em',
                    padding: isLast ? '3px 10px' : '2px 6px',
                    border: isLast ? '1px solid var(--line-soft)' : '1px solid transparent',
                    borderLeft: isLast ? '2px solid var(--cyan)' : '1px solid transparent',
                    background: isLast ? 'rgba(57, 229, 255, 0.08)' : 'transparent',
                  }}
                >
                  {seg.label}
                </button>
              </span>
            );
          })}

          {selected.size > 0 && (
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
              }}
            >
              <span style={{ color: 'var(--ink-dim)' }}>
                {selected.size} SEL · {fmtSize(selectedSize)}
              </span>
              <ToolbarBtn onClick={() => void onCopyPath(Array.from(selected))}>COPY PATHS</ToolbarBtn>
              {selectedEntries[0] && (
                <ToolbarBtn onClick={() => void onReveal(selectedEntries[0].path)}>REVEAL</ToolbarBtn>
              )}
              <ToolbarBtn tone="red" onClick={() => void onTrashMany(Array.from(selected))}>
                TRASH
              </ToolbarBtn>
              <ToolbarBtn onClick={clearSelection}>CLEAR</ToolbarBtn>
            </div>
          )}
        </div>

        {/* Search + filters */}
        <div
          className="section"
          style={{
            padding: 8,
            marginBottom: 8,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setRecursiveResults(null); }}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                void runRecursiveSearch(query);
              } else if (e.key === 'Escape') {
                setQuery(''); setRecursiveResults(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="filter by name   /   ⌘↵ recursive"
            spellCheck={false}
            style={{ flex: 1, minWidth: 180, fontSize: 12, padding: '7px 10px', fontFamily: 'var(--mono)' }}
          />
          {(() => {
            const disabled = !query.trim() || recursiveBusy;
            return (
              <button
                onClick={() => void runRecursiveSearch(query)}
                disabled={disabled}
                style={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  padding: '7px 12px',
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  fontWeight: 700,
                  fontFamily: 'var(--mono)',
                  border: `1px solid ${disabled ? 'var(--line-soft)' : 'var(--cyan)'}`,
                  background: disabled ? 'rgba(6, 14, 22, 0.4)' : 'rgba(57, 229, 255, 0.14)',
                  color: disabled ? 'var(--ink-dim)' : 'var(--cyan)',
                  opacity: disabled ? 0.75 : 1,
                }}
              >
                {recursiveBusy ? 'SEARCHING' : 'DEEP SEARCH'}
              </button>
            );
          })()}
          {(['all', 'dir', 'code', 'doc', 'img', 'data', 'other'] as KindFilter[]).map(k => (
            <FilterChip
              key={k}
              label={k.toUpperCase()}
              active={kindFilter === k}
              onClick={() => setKindFilter(k)}
            />
          ))}
        </div>

        {/* Error banner */}
        {err && (
          <div
            className="section"
            style={{
              borderColor: 'rgba(255, 77, 94, 0.4)',
              background: 'rgba(255, 77, 94, 0.06)',
              color: 'var(--red)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              marginBottom: 8,
            }}
          >
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</span>
            <button className="primary" onClick={() => setReloadTick(t => t + 1)}>RETRY</button>
          </div>
        )}

        {/* Creation row */}
        {creating && (
          <div
            className="section"
            style={{
              padding: 8,
              marginBottom: 8,
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <input
              autoFocus
              type="text"
              value={createDraft}
              onChange={e => setCreateDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void commitCreate();
                else if (e.key === 'Escape') { setCreating(null); setCreateDraft(''); }
              }}
              placeholder={creating === 'folder' ? 'new folder name' : 'filename.ext'}
              spellCheck={false}
              style={{ fontSize: 12, padding: '7px 10px', fontFamily: 'var(--mono)' }}
            />
            <button className="primary" onClick={() => void commitCreate()} style={{ padding: '7px 12px' }}>
              CREATE {creating === 'folder' ? 'FOLDER' : 'FILE'}
            </button>
            <ToolbarBtn onClick={() => { setCreating(null); setCreateDraft(''); }}>CANCEL</ToolbarBtn>
          </div>
        )}

        {/* List header (list mode only) */}
        {viewMode === 'list' && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '22px 72px 1fr 110px 130px',
              gap: 12,
              padding: '8px 12px',
              borderBottom: '1px solid var(--line-soft)',
              fontFamily: 'var(--display)',
              fontSize: 10,
              letterSpacing: '0.22em',
              color: 'var(--cyan)',
              fontWeight: 700,
            }}
          >
            <span />
            <SortHeader label="KIND" k="kind" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }} />
            <SortHeader label="NAME" k="name" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }} />
            <SortHeader label="SIZE" k="size" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }} align="right" />
            <SortHeader label="MODIFIED" k="modified" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }} align="right" />
          </div>
        )}

        {/* List / grid body */}
        <div ref={listRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {loading && sorted.length === 0 && !err && (
            <EmptyState label="LOADING" />
          )}
          {!loading && !err && sorted.length === 0 && (
            <EmptyState
              label={
                query ? 'NO MATCHES' :
                recursiveResults ? 'NO RECURSIVE MATCHES' :
                kindFilter !== 'all' ? 'NO MATCHES FOR FILTER' :
                'EMPTY DIRECTORY'
              }
            />
          )}

          {viewMode === 'list' ? sorted.map((e, i) => (
            <ListRow
              key={e.path}
              entry={e}
              stripe={i % 2 === 0 ? 'even' : 'odd'}
              nowSecs={nowSecs}
              isSelected={selected.has(e.path)}
              isFocused={focusPath === e.path}
              isRenaming={renaming === e.path}
              renameDraft={renameDraft}
              onRenameDraft={setRenameDraft}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenaming(null)}
              onClick={onRowClick}
              onReveal={() => void onReveal(e.path)}
              onCopyPath={() => void onCopyPath(e.path)}
              onRename={() => startRename(e)}
              onTrash={() => void onTrashMany([e.path])}
              onDuplicate={() => void onDuplicate(e)}
              onOpen={() => void invokeSafe('open_path', { path: e.path })}
            />
          )) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                gap: 10,
                padding: 10,
              }}
            >
              {sorted.map(e => (
                <GridTile
                  key={e.path}
                  entry={e}
                  nowSecs={nowSecs}
                  isSelected={selected.has(e.path)}
                  onClick={onRowClick}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer status bar */}
        <div
          style={{
            padding: '6px 12px',
            borderTop: '1px solid var(--line-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            color: 'var(--ink-dim)',
          }}
        >
          <span>
            {sorted.length} / {counts.total} SHOWN
            {selected.size > 0 && ` · ${selected.size} SEL · ${fmtSize(selectedSize)}`}
          </span>
          <span style={{ flex: 1, textAlign: 'center', opacity: 0.6 }}>
            j/k MOVE · ↵ OPEN · r REVEAL · ⌫ TRASH · / FIND
          </span>
          <span style={{ color: 'var(--ink-dim)', opacity: 0.75 }}>
            REFRESHED {lastLoadedLabel.toUpperCase()}
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(path).then(
                () => showToast('ok', 'COPIED CURRENT PATH'),
                () => showToast('err', 'CLIPBOARD FAILED'),
              );
            }}
            style={{
              all: 'unset', cursor: 'pointer', flexShrink: 0,
              fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.2em',
              fontWeight: 700, color: 'var(--cyan)',
              padding: '4px 8px', border: '1px solid var(--cyan)',
            }}
            title="Copy this folder path"
          >COPY CWD</button>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '32%' }}>{path}</span>
        </div>
      </div>

      {/* ============================ PREVIEW PANE =========================== */}
      {selectedEntries.length === 1 && (
        <PreviewPane
          entry={selectedEntries[0]}
          preview={preview}
          previewFor={previewFor}
          dirMeta={dirMeta}
          dirMetaFor={dirMetaFor}
          nowSecs={nowSecs}
          onOpen={() => void invokeSafe('open_path', { path: selectedEntries[0].path })}
          onReveal={() => void onReveal(selectedEntries[0].path)}
          onCopyPath={() => void onCopyPath(selectedEntries[0].path)}
          onRename={() => startRename(selectedEntries[0])}
          onTrash={() => void onTrashMany([selectedEntries[0].path])}
          onDuplicate={() => void onDuplicate(selectedEntries[0])}
        />
      )}
    </div>
  );
}
