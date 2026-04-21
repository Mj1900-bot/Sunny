/**
 * PHOTOS — screenshot & screen-capture gallery.
 *
 * Indexes `~/Desktop` and `~/Pictures/Screenshots` for common image files
 * whose name contains "screenshot". Sunny can OCR any selected file via
 * the existing `ocr_region` path, or you can ask Sunny to describe it.
 *
 * UI: denser masonry-ish grid with real image thumbnails, day buckets,
 * keyboard navigation, and a lightbox overlay for full-size preview +
 * single-keystroke actions (open / reveal / analyze / copy path).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, EmptyState, StatBlock, Toolbar, ToolbarButton,
  ScrollList, usePoll, relTime,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { isTauri } from '../../lib/tauri';
import { useView, type PhotoRoot } from '../../store/view';
import { findScreenshots, openPath, revealInFinder, type FsEntry } from './api';

/** Map the settings enum to real filesystem roots. Keeps the MODULES
 *  tab chip labels short ("Desktop") while the fs_search command still
 *  receives an absolute-ish tilde path. */
const ROOT_PATHS: Record<PhotoRoot, string> = {
  Desktop:     '~/Desktop',
  Screenshots: '~/Pictures/Screenshots',
  Downloads:   '~/Downloads',
};

type Density = 'comfy' | 'dense';
const TILE_PX: Record<Density, number> = { comfy: 164, dense: 118 };

export function PhotosPage() {
  const enabledRoots = useView(s => s.settings.photosRoots);
  const rootsList = useMemo(
    () => enabledRoots.map(k => ROOT_PATHS[k]),
    [enabledRoots],
  );
  const [root, setRoot] = useState<string>(() => rootsList[0] ?? ROOT_PATHS.Desktop);
  useEffect(() => {
    if (!rootsList.includes(root) && rootsList.length > 0) {
      setRoot(rootsList[0]!);
    }
  }, [rootsList, root]);

  const { data: files, reload, loading, error } = usePoll(
    () => findScreenshots(root), 60_000, [root],
  );

  // Capture "now" in state and tick it every 60s so relative timestamps
  // stay fresh without calling Date.now() during render.
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const h = window.setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(h);
  }, []);

  const [density, setDensity] = useState<Density>('comfy');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<FsEntry | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState('');

  const flashCopy = useCallback((msg: string) => {
    setCopyToast(msg);
    window.setTimeout(() => setCopyToast(null), 2200);
  }, []);

  const grouped = useMemo(() => {
    let list = (files ?? []).slice().sort((a, b) => b.modified_secs - a.modified_secs);
    const q = nameFilter.trim().toLowerCase();
    if (q) list = list.filter(f => f.name.toLowerCase().includes(q));
    return list;
  }, [files, nameFilter]);

  // Group by local day so the grid gets "TODAY", "YESTERDAY", "MAR 14"
  // headers instead of an undifferentiated wall of thumbnails.
  const byDay = useMemo(() => {
    const now = new Date();
    const todayKey = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yestKey = todayKey - 86_400_000;
    type Bucket = { key: number; label: string; items: FsEntry[] };
    const buckets = new Map<number, Bucket>();
    for (const f of grouped) {
      const d = new Date(f.modified_secs * 1000);
      const k = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      let label: string;
      if (k === todayKey) label = 'TODAY';
      else if (k === yestKey) label = 'YESTERDAY';
      else label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
      const existing = buckets.get(k);
      if (existing) existing.items.push(f);
      else buckets.set(k, { key: k, label, items: [f] });
    }
    return Array.from(buckets.values()).sort((a, b) => b.key - a.key);
  }, [grouped]);

  // Flat ordering drives arrow-key navigation through the lightbox.
  const flatOrder = useMemo(() => byDay.flatMap(b => b.items), [byDay]);

  const toggleSelect = useCallback((path: string, additive: boolean) => {
    setSelected(prev => {
      const next = new Set(additive ? prev : []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Bulk actions operate on the current selection (or the lightbox
  // target if nothing is explicitly selected).
  const selectedList = useMemo(
    () => flatOrder.filter(f => selected.has(f.path)),
    [flatOrder, selected],
  );
  const bulkAnalyze = () => {
    const targets = selectedList.length > 0 ? selectedList : (lightbox ? [lightbox] : []);
    if (targets.length === 0) return;
    const bullets = targets.map(t => `• ${t.path}`).join('\n');
    askSunny(
      `Describe what's in these ${targets.length} screenshot${targets.length > 1 ? 's' : ''} and OCR any text:\n${bullets}`,
      'photos',
    );
  };

  // Lightbox keyboard handling: ←/→ to step, esc to close, o=open,
  // f=finder, c=copy path, a=analyze.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setLightbox(null); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = flatOrder.findIndex(f => f.path === lightbox.path);
        if (idx < 0) return;
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const nextIdx = (idx + step + flatOrder.length) % flatOrder.length;
        setLightbox(flatOrder[nextIdx] ?? null);
        return;
      }
      if (e.key.toLowerCase() === 'o') { e.preventDefault(); void openPath(lightbox.path); return; }
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); void revealInFinder(lightbox.path); return; }
      if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void navigator.clipboard?.writeText(lightbox.path).then(() => flashCopy('Path copied'));
        return;
      }
      if (e.key.toLowerCase() === 'a') {
        e.preventDefault();
        askSunny(`Describe what's in this screenshot and OCR any text: ${lightbox.path}`, 'photos');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, flatOrder, flashCopy]);

  return (
    <ModuleView title="PHOTOS · SCREENSHOTS">
      <style>{`
        @keyframes photos-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      <PageGrid>
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <StatBlock label="FILES" value={String(grouped.length)} tone="cyan" />
            <StatBlock
              label="LAST 24H"
              value={String(grouped.filter(g => (nowSecs - g.modified_secs) < 86_400).length)}
              tone="amber"
            />
            <StatBlock
              label="TOTAL SIZE"
              value={`${(grouped.reduce((n, g) => n + g.size, 0) / 1_048_576).toFixed(0)} MB`}
              tone="violet"
            />
          </div>
        </PageCell>

        <PageCell span={12}>
          <Toolbar>
            {rootsList.map(r => (
              <ToolbarButton key={r} active={r === root} onClick={() => setRoot(r)}>{r}</ToolbarButton>
            ))}
            <input
              value={nameFilter}
              onChange={e => setNameFilter(e.target.value)}
              placeholder="filter by filename…"
              style={{
                all: 'unset', flex: '1 1 200px', minWidth: 160, maxWidth: 320,
                padding: '6px 10px',
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                border: '1px solid var(--line-soft)',
                background: 'rgba(0, 0, 0, 0.3)',
              }}
            />
            <span style={{ flex: 1 }} />
            <ToolbarButton
              active={density === 'comfy'}
              onClick={() => setDensity('comfy')}
            >COMFY</ToolbarButton>
            <ToolbarButton
              active={density === 'dense'}
              onClick={() => setDensity('dense')}
            >DENSE</ToolbarButton>
            <ToolbarButton onClick={reload}>REFRESH</ToolbarButton>
          </Toolbar>
        </PageCell>

        {selected.size > 0 && (
          <PageCell span={12}>
            <div style={{
              border: '1px solid var(--line-soft)',
              borderLeft: '2px solid var(--cyan)',
              background: 'rgba(57, 229, 255, 0.05)',
              padding: '6px 12px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
                color: 'var(--cyan)', fontWeight: 700,
              }}>{selected.size} SELECTED</span>
              <span style={{ flex: 1 }} />
              <ToolbarButton tone="violet" onClick={bulkAnalyze}>ANALYZE</ToolbarButton>
              <ToolbarButton onClick={clearSelection}>CLEAR</ToolbarButton>
            </div>
          </PageCell>
        )}

        <PageCell span={12}>
          {error && grouped.length === 0 && (
            <EmptyState
              title="Search failed"
              hint={error.length > 0 ? error : 'fs_search returned no results. Grant Full Disk Access if needed.'}
            />
          )}
          {!error && loading && grouped.length === 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, padding: '4px 0' }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    aspectRatio: '4 / 3',
                    border: '1px solid var(--line-soft)',
                    background: 'linear-gradient(90deg, rgba(57,229,255,0.06) 0%, rgba(57,229,255,0.12) 50%, rgba(57,229,255,0.06) 100%)',
                    backgroundSize: '200% 100%',
                    animation: 'photos-shimmer 1.2s ease-in-out infinite',
                  }}
                />
              ))}
            </div>
          )}
          {!error && !loading && grouped.length === 0 && (
            <EmptyState title="No screenshots found" hint={`Nothing matches *screenshot* under ${root}.`} />
          )}
          {grouped.length > 0 && (
            <ScrollList maxHeight={620}>
              {byDay.map(bucket => (
                <div
                  key={bucket.key}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    borderBottom: '1px solid var(--line-soft)', paddingBottom: 4,
                    position: 'sticky', top: 0,
                    background: 'linear-gradient(180deg, rgba(6,14,22,0.96), rgba(6,14,22,0.86))',
                    backdropFilter: 'blur(6px)', zIndex: 1,
                  }}>
                    <span style={{
                      fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
                      color: 'var(--cyan)', fontWeight: 700,
                    }}>{bucket.label}</span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                    }}>{bucket.items.length}</span>
                    <button
                      type="button"
                      title="Select all in this day (for bulk analyze)"
                      onClick={() => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          for (const f of bucket.items.slice(0, 120)) next.add(f.path);
                          return next;
                        });
                      }}
                      style={{
                        all: 'unset', cursor: 'pointer', marginLeft: 'auto',
                        fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.2em',
                        color: 'var(--ink-dim)', fontWeight: 700,
                        padding: '2px 6px', border: '1px dashed var(--line-soft)',
                      }}
                    >SELECT DAY</button>
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_PX[density]}px, 1fr))`,
                    gap: 8,
                  }}>
                    {bucket.items.slice(0, 120).map(f => (
                      <PhotoTile
                        key={f.path}
                        file={f}
                        nowSecs={nowSecs}
                        isSelected={selected.has(f.path)}
                        onClick={(ev) => {
                          if (ev.metaKey || ev.shiftKey || ev.ctrlKey) toggleSelect(f.path, true);
                          else setLightbox(f);
                        }}
                        onDoubleClick={() => void openPath(f.path)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </ScrollList>
          )}
        </PageCell>
      </PageGrid>

      {copyToast && (
        <div
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 50,
            padding: '8px 14px',
            border: '1px solid var(--cyan)',
            background: 'rgba(6, 14, 22, 0.95)',
            color: 'var(--cyan)',
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
            fontWeight: 700,
            pointerEvents: 'none',
            boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
          }}
        >{copyToast}</div>
      )}

      {lightbox && (
        <Lightbox
          file={lightbox}
          onClose={() => setLightbox(null)}
          onCopyFlash={flashCopy}
          onPrev={() => {
            const idx = flatOrder.findIndex(f => f.path === lightbox.path);
            if (idx < 0) return;
            const next = flatOrder[(idx - 1 + flatOrder.length) % flatOrder.length];
            setLightbox(next ?? null);
          }}
          onNext={() => {
            const idx = flatOrder.findIndex(f => f.path === lightbox.path);
            if (idx < 0) return;
            const next = flatOrder[(idx + 1) % flatOrder.length];
            setLightbox(next ?? null);
          }}
        />
      )}
    </ModuleView>
  );
}

// ---- Tile --------------------------------------------------------------

function PhotoTile({
  file, nowSecs, isSelected, onClick, onDoubleClick,
}: {
  file: FsEntry;
  nowSecs: number;
  isSelected: boolean;
  onClick: (ev: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const diffSecs = nowSecs - file.modified_secs;
  const fresh = diffSecs < 86_400;

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        position: 'relative',
        border: isSelected ? '1px solid var(--cyan)' : '1px solid var(--line-soft)',
        background: isSelected ? 'rgba(57, 229, 255, 0.08)' : 'rgba(6, 14, 22, 0.55)',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        transition: 'border-color 140ms ease, transform 140ms ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--cyan)'; }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = isSelected ? 'var(--cyan)' : 'var(--line-soft)';
      }}
    >
      <div style={{
        aspectRatio: '4 / 3', width: '100%',
        background: 'rgba(0, 0, 0, 0.5)',
        position: 'relative', overflow: 'hidden',
      }}>
        {isTauri && !errored ? (
          <img
            src={convertFileSrc(file.path)}
            alt={file.name}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              opacity: loaded ? 1 : 0,
              transition: 'opacity 220ms ease',
            }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.24em',
            color: 'var(--ink-dim)',
          }}>IMG</div>
        )}
        {fresh && (
          <div style={{
            position: 'absolute', top: 6, left: 6,
            padding: '1px 5px',
            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
            color: 'var(--amber)', fontWeight: 700,
            background: 'rgba(0, 0, 0, 0.6)',
            border: '1px solid var(--amber)',
          }}>NEW</div>
        )}
        {isSelected && (
          <div style={{
            position: 'absolute', top: 6, right: 6,
            width: 16, height: 16,
            border: '1px solid var(--cyan)',
            background: 'var(--cyan)',
            color: '#001018',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--display)', fontSize: 10, fontWeight: 900,
          }}>✓</div>
        )}
      </div>
      <div style={{
        padding: '5px 8px',
        display: 'flex', flexDirection: 'column', gap: 1,
        borderTop: '1px solid var(--line-soft)',
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={file.name}>{file.name}</div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
          letterSpacing: '0.1em',
          display: 'flex', justifyContent: 'space-between', gap: 4,
        }}>
          <span>{(file.size / 1024).toFixed(0)} KB</span>
          <span>{relTime(file.modified_secs)}</span>
        </div>
      </div>
    </div>
  );
}

// ---- Lightbox -------------------------------------------------------------

function Lightbox({
  file, onClose, onPrev, onNext, onCopyFlash,
}: {
  file: FsEntry;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCopyFlash: (msg: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { dialogRef.current?.focus(); }, [file.path]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${file.name}`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 40,
        background: 'rgba(0, 4, 10, 0.88)',
        backdropFilter: 'blur(8px)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ outline: 'none', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {/* Top chrome */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid var(--line-soft)',
          background: 'rgba(6, 14, 22, 0.7)',
        }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.24em',
            color: 'var(--cyan)', fontWeight: 700,
          }}>PREVIEW</div>
          <div style={{
            fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
            fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{file.name}</div>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', letterSpacing: '0.12em',
          }}>{(file.size / 1024).toFixed(0)} KB · {relTime(file.modified_secs)}</span>
          <span style={{ flex: 1 }} />
          <Toolbar>
            <ToolbarButton tone="cyan" onClick={() => void openPath(file.path)}>OPEN [O]</ToolbarButton>
            <ToolbarButton onClick={() => void revealInFinder(file.path)}>FINDER [F]</ToolbarButton>
            <ToolbarButton
              onClick={() => void navigator.clipboard?.writeText(file.path).then(() => onCopyFlash('Path copied'))}
            >COPY [C]</ToolbarButton>
            <ToolbarButton
              tone="violet"
              onClick={() => askSunny(
                `Describe what's in this screenshot and OCR any text: ${file.path}`,
                'photos',
              )}
            >ANALYZE [A]</ToolbarButton>
            <ToolbarButton tone="red" onClick={onClose}>CLOSE [ESC]</ToolbarButton>
          </Toolbar>
        </div>

        {/* Image + side arrows */}
        <div style={{
          flex: 1, minHeight: 0,
          display: 'grid', gridTemplateColumns: '48px 1fr 48px',
          alignItems: 'stretch',
        }}>
          <NavArrow direction="prev" onClick={onPrev} />
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 0, padding: 18,
          }}>
            {isTauri ? (
              <img
                src={convertFileSrc(file.path)}
                alt={file.name}
                style={{
                  maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                  boxShadow: '0 10px 40px rgba(0, 0, 0, 0.6)',
                  border: '1px solid var(--line-soft)',
                }}
              />
            ) : (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
              }}>Preview unavailable outside the app.</div>
            )}
          </div>
          <NavArrow direction="next" onClick={onNext} />
        </div>

        {/* Footer path */}
        <div style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--line-soft)',
          background: 'rgba(6, 14, 22, 0.7)',
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
          letterSpacing: '0.12em', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={file.path}>{file.path}</div>
      </div>
    </div>
  );
}

function NavArrow({ direction, onClick }: { direction: 'prev' | 'next'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={direction === 'prev' ? 'Previous' : 'Next'}
      style={{
        all: 'unset', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--cyan)',
        fontFamily: 'var(--display)', fontSize: 18, fontWeight: 900,
        background: 'transparent',
        transition: 'background 140ms ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(57, 229, 255, 0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >{direction === 'prev' ? '‹' : '›'}</button>
  );
}
