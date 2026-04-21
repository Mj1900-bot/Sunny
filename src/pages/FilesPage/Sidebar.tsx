import { QUICK_PATHS } from './constants';
import { NavButton, SectionHeader, SidebarButton } from './components';
import { DirTree } from './DirTree';
import { basename } from './utils';
import type { ViewMode } from './types';

// ---------------------------------------------------------------------------
// Sidebar — quick paths, pinned, recents, nav controls
// ---------------------------------------------------------------------------

export function Sidebar({
  path, setPath, parent,
  pinned, togglePin, isPinned,
  recents,
  viewMode, setViewMode,
  showHidden, setShowHidden,
  setCreating, setCreateDraft,
  setReloadTick,
}: {
  path: string;
  setPath: (p: string) => void;
  parent: string | null;
  pinned: ReadonlyArray<string>;
  togglePin: (p: string) => void;
  isPinned: (p: string) => boolean;
  recents: ReadonlyArray<string>;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  showHidden: boolean;
  setShowHidden: (fn: (prev: boolean) => boolean) => void;
  setCreating: (v: null | 'file' | 'folder') => void;
  setCreateDraft: (v: string) => void;
  setReloadTick: (fn: (t: number) => number) => void;
}) {
  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto' }}>
      <SectionHeader label="QUICK PATHS" />
      <div className="section" style={{ padding: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {QUICK_PATHS.map(q => (
            <SidebarButton
              key={q.path}
              label={q.label}
              active={path === q.path}
              onClick={() => setPath(q.path)}
            />
          ))}
        </div>
      </div>

      <DirTree currentPath={path} onNavigate={setPath} />

      {pinned.length > 0 && (
        <>
          <SectionHeader label="PINNED" />
          <div className="section" style={{ padding: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pinned.map(p => (
                <SidebarButton
                  key={p}
                  label={basename(p) || p}
                  sub={p}
                  active={path === p}
                  onClick={() => setPath(p)}
                  onRemove={() => togglePin(p)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {recents.length > 1 && (
        <>
          <SectionHeader label="RECENTS" />
          <div className="section" style={{ padding: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recents.filter(p => p !== path).slice(0, 5).map(p => (
                <SidebarButton
                  key={p}
                  label={basename(p) || p}
                  sub={p}
                  active={false}
                  onClick={() => setPath(p)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <SectionHeader label="NAV" />
      <div className="section" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <NavButton onClick={() => parent && setPath(parent)} disabled={!parent}>
          .. UP
        </NavButton>
        <NavButton onClick={() => setReloadTick(t => t + 1)}>RELOAD</NavButton>
        <NavButton onClick={() => togglePin(path)}>
          {isPinned(path) ? 'UNPIN' : 'PIN'} CURRENT
        </NavButton>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <NavButton onClick={() => { setCreating('file'); setCreateDraft('untitled.txt'); }}>
            NEW FILE
          </NavButton>
          <NavButton onClick={() => { setCreating('folder'); setCreateDraft('New Folder'); }}>
            NEW DIR
          </NavButton>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <NavButton
            onClick={() => setViewMode('list')}
            active={viewMode === 'list'}
          >
            LIST
          </NavButton>
          <NavButton
            onClick={() => setViewMode('grid')}
            active={viewMode === 'grid'}
          >
            GRID
          </NavButton>
        </div>
        <NavButton onClick={() => setShowHidden(s => !s)} active={showHidden}>
          {showHidden ? 'HIDE' : 'SHOW'} DOTFILES
        </NavButton>
      </div>
    </aside>
  );
}
