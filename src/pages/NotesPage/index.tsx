/**
 * NOTES — Apple Notes bridge + AI writing partner.
 *
 * Depth additions:
 *   • FolderTree sidebar with per-folder note counts.
 *   • Recent notes section at the top of the list.
 *   • Split-view NoteEditor: editable left + markdown preview right.
 *   • Inline AI ops bar on text selection (EXPAND / SUMMARIZE / REWRITE).
 *   • Folder chip count badges in the folder selector.
 *   • Keyboard shortcuts: ⌘F search, ⌘N new note, ↑/↓ navigate list.
 *   • Richer 3-line previews with modified-time stripe.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, Chip, usePoll, useDebounced,
  Toolbar, ToolbarButton, EmptyState, ScrollList, relTime,
} from '../_shared';
import { useNotesStateSync } from '../../hooks/usePageStateSync';
import { NoteEditor } from './NoteEditor';
import { NewNoteForm } from './NewNoteForm';
import { FolderTree } from './FolderTree';
import {
  createNote, listFolders, listNotes, searchNotes, type Note,
} from './api';
import { useNoteFavorites } from './noteFavorites';

const RECENT_COUNT = 5;

export function NotesPage() {
  const [folder, setFolder] = useState<string>('');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 300);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const favorites = useNoteFavorites();

  const { data: folders } = usePoll(listFolders, 120_000);
  const { data: allNotes } = usePoll(() => listNotes(undefined, 200), 60_000);
  const { data: notesRaw, reload, loading, error } = usePoll(
    () => debounced.trim().length > 0
      ? searchNotes(debounced.trim(), 80)
      : listNotes(folder || undefined, 80),
    30_000,
    [folder, debounced],
  );

  const notes = useMemo(() => {
    const list = notesRaw ?? [];
    if (!favoritesOnly) return list;
    return list.filter(n => favorites.has(n.id));
  }, [notesRaw, favoritesOnly, favorites]);

  // Arrow-key navigation through the notes list.
  const navigate = useCallback((dir: 1 | -1) => {
    const list = notes ?? [];
    if (list.length === 0) return;
    const currentId = selectedId ?? list[0]?.id ?? null;
    const idx = Math.max(0, list.findIndex(n => n.id === currentId));
    const nextIdx = (idx + dir + list.length) % list.length;
    const next = list[nextIdx];
    if (next) setSelectedId(next.id);
  }, [notes, selectedId]);

  const selected = useMemo(
    () => (notes ?? []).find(n => n.id === selectedId) ?? (notes ?? [])[0] ?? null,
    [notes, selectedId],
  );

  // Push the Notes page's visible state to the Rust backend so the
  // agent's `page_state_notes` tool can answer "what note is open".
  const notesSnapshot = useMemo(() => ({
    selected_note_id: selected?.id ?? undefined,
    folder,
    search_query: debounced,
  }), [selected, folder, debounced]);
  useNotesStateSync(notesSnapshot);

  useEffect(() => {
    if (!favoritesOnly || !selectedId) return;
    if (!favorites.has(selectedId)) setSelectedId(notes[0]?.id ?? null);
  }, [favoritesOnly, selectedId, favorites, notes]);

  // Build per-folder counts from allNotes (the full unfiltered list).
  const noteCounts = useMemo((): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const n of allNotes ?? []) {
      counts[n.folder] = (counts[n.folder] ?? 0) + 1;
    }
    return counts;
  }, [allNotes]);

  // Recent notes = last RECENT_COUNT modified, from allNotes.
  const recentNotes = useMemo((): ReadonlyArray<Note> => {
    if (!allNotes) return [];
    return [...allNotes]
      .filter(n => n.modified)
      .sort((a, b) => {
        const ta = new Date(a.modified ?? 0).getTime();
        const tb = new Date(b.modified ?? 0).getTime();
        return tb - ta;
      })
      .slice(0, RECENT_COUNT);
  }, [allNotes]);

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') { e.preventDefault(); navigate(1); }
    else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') { e.preventDefault(); navigate(-1); }
  };

  // Global shortcuts while the page is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setComposerOpen(true);
      } else if (e.key === 'Escape') {
        if (composerOpen) { setComposerOpen(false); return; }
        if (query) setQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composerOpen, query]);

  useLayoutEffect(() => {
    if (!selectedId) return;
    const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(selectedId)
      : selectedId.replace(/["\\]/g, '');
    document.querySelector(`[data-note-id="${safe}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <ModuleView title="NOTES · WRITING">
      <PageGrid>
        {/* ── Top search + controls bar ── */}
        <PageCell span={12}>
          <Toolbar>
            <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
              <input
                ref={searchRef}
                aria-label="Search notes"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="search notes…"
                style={{
                  all: 'unset', width: '100%', boxSizing: 'border-box',
                  padding: '6px 58px 6px 10px',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                  border: '1px solid var(--line-soft)',
                  background: 'rgba(0, 0, 0, 0.3)',
                }}
              />
              <span style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
                letterSpacing: '0.14em', pointerEvents: 'none',
              }}>⌘F</span>
            </div>
            <ToolbarButton
              tone="violet"
              onClick={() => setComposerOpen(v => !v)}
              active={composerOpen}
            >NEW ⌘N</ToolbarButton>
            {favorites.size > 0 && (
              <ToolbarButton
                tone="amber"
                active={favoritesOnly}
                onClick={() => setFavoritesOnly(v => !v)}
              >★ ONLY ({favorites.size})</ToolbarButton>
            )}
            <ToolbarButton onClick={reload}>REFRESH</ToolbarButton>
            {loading && <Chip tone="dim">LOADING…</Chip>}
          </Toolbar>
        </PageCell>

        {composerOpen && (
          <PageCell span={12}>
            <NewNoteForm
              folders={folders ?? []}
              onCancel={() => setComposerOpen(false)}
              onCreate={async (title, body, f) => {
                const created = await createNote(title, body, f);
                reload();
                if (created?.id) setSelectedId(created.id);
                setComposerOpen(false);
              }}
            />
          </PageCell>
        )}

        {/* ── Left: folder tree ── */}
        <PageCell span={2}>
          <FolderTree
            folders={folders ?? []}
            noteCounts={noteCounts}
            totalCount={allNotes?.length ?? 0}
            selected={folder}
            onSelect={f => { setFolder(f); setSelectedId(null); }}
          />
        </PageCell>

        {/* ── Centre: recent + notes list ── */}
        <PageCell span={4}>
          {/* Recent notes */}
          {recentNotes.length > 0 && !query && (
            <Section title="RECENT">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {recentNotes.map(n => {
                  const active = n.id === selected?.id;
                  const modTs = n.modified ? new Date(n.modified).getTime() / 1000 : null;
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      style={{
                        all: 'unset', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 8px',
                        borderLeft: active ? '2px solid var(--cyan)' : '2px solid transparent',
                        background: active ? 'rgba(57,229,255,0.06)' : 'transparent',
                      }}
                    >
                      <span style={{
                        flex: 1, fontFamily: 'var(--label)', fontSize: 12,
                        color: active ? '#fff' : 'var(--ink-2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{n.name || '(untitled)'}</span>
                      {modTs && (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', flexShrink: 0 }}>
                          {relTime(modTs)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Note list */}
          <Section
            title={folder ? folder.toUpperCase() : 'ALL NOTES'}
            right={query ? `${notes?.length ?? 0} · "${query}"` : `${notes?.length ?? 0}`}
          >
            {error && !notesRaw && (
              <EmptyState
                title="Notes unavailable"
                hint={error.length > 0 ? error : 'Grant Automation → Notes in System Settings, then REFRESH.'}
              />
            )}
            {!error && loading && !notesRaw && (
              <EmptyState title="Loading notes…" hint="Reading from Notes.app" />
            )}
            {!error && (notesRaw || !loading) && (
              <div tabIndex={0} onKeyDown={handleKey} style={{ outline: 'none' }} role="listbox" aria-label="Notes">
                <ScrollList maxHeight={520} style={{ gap: 0 }}>
                  {(notes ?? []).length === 0 ? (
                    favoritesOnly
                      ? <EmptyState title="No starred notes here" hint="Star notes in the editor, or turn off ★ ONLY." />
                      : query
                        ? <EmptyState title="No matches" hint={`Nothing matches "${query}".`} />
                        : <EmptyState title="No notes" hint="Hit ⌘N to create one, or grant Notes.app access." />
                  ) : (
                    (notes ?? []).map(n => {
                      const active = n.id === selected?.id;
                      const modTs = n.modified ? new Date(n.modified).getTime() / 1000 : null;
                      const firstLine = (n.body || '').split('\n').find(l => l.trim().length > 0) ?? '';
                      const preview = (n.body || '').replace(/\s+/g, ' ').slice(0, 180);
                      return (
                        <button
                          key={n.id}
                          data-note-id={n.id}
                          role="option"
                          aria-selected={active}
                          onClick={() => setSelectedId(n.id)}
                          style={{
                            all: 'unset', cursor: 'pointer',
                            display: 'flex', flexDirection: 'column', gap: 4,
                            padding: '10px 12px',
                            borderLeft: active ? '2px solid var(--violet)' : '2px solid transparent',
                            background: active
                              ? 'linear-gradient(90deg, rgba(180,140,255,0.14), transparent)'
                              : 'transparent',
                            borderBottom: '1px solid var(--line-soft)',
                            transition: 'background 120ms ease',
                          }}
                          onMouseEnter={e => {
                            if (!active) e.currentTarget.style.background = 'rgba(57, 229, 255, 0.04)';
                          }}
                          onMouseLeave={e => {
                            if (!active) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <div style={{
                            fontFamily: 'var(--label)', fontSize: 13,
                            color: active ? '#fff' : 'var(--ink)', fontWeight: 600,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{n.name || firstLine.slice(0, 60) || '(untitled)'}</div>
                          <div style={{
                            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-dim)',
                            lineHeight: 1.45,
                            display: '-webkit-box',
                            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}>{preview}</div>
                          <div style={{
                            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
                            color: 'var(--ink-dim)', fontWeight: 700,
                            display: 'flex', justifyContent: 'space-between', gap: 6,
                            paddingTop: 2,
                          }}>
                            <span style={{
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              color: active ? 'var(--violet)' : 'var(--ink-dim)',
                            }}>{n.folder}</span>
                            {modTs && <span>{relTime(modTs)}</span>}
                          </div>
                        </button>
                      );
                    })
                  )}
                </ScrollList>
              </div>
            )}
          </Section>
        </PageCell>

        {/* ── Right: editor ── */}
        <PageCell span={6}>
          <NoteEditor key={selected?.id ?? 'none'} note={selected} onChanged={reload} />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
