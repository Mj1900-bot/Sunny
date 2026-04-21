import { ModuleView } from '../../components/ModuleView';
import { useFilesState } from './useFilesState';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';

// ---------------------------------------------------------------------------
// FilesPage — thin shell composing hook + sidebar + main content
// ---------------------------------------------------------------------------

export function FilesPage() {
  const s = useFilesState();

  return (
    <ModuleView title="FILES" badge={s.headerBadge}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '220px 1fr',
          gap: 14,
          height: '100%',
          minHeight: 0,
        }}
      >
        <Sidebar
          path={s.path}
          setPath={s.setPath}
          parent={s.parent}
          pinned={s.pinned}
          togglePin={s.togglePin}
          isPinned={s.isPinned}
          recents={s.recents}
          viewMode={s.viewMode}
          setViewMode={s.setViewMode}
          showHidden={s.showHidden}
          setShowHidden={s.setShowHidden}
          setCreating={s.setCreating}
          setCreateDraft={s.setCreateDraft}
          setReloadTick={s.setReloadTick}
        />

        <MainContent
          path={s.path}
          setPath={s.setPath}
          draft={s.draft}
          setDraft={s.setDraft}
          submitDraft={s.submitDraft}
          segments={s.segments}
          err={s.err}
          loading={s.loading}
          sorted={s.sorted}
          counts={s.counts}
          nowSecs={s.nowSecs}
          setReloadTick={s.setReloadTick}
          query={s.query}
          setQuery={s.setQuery}
          recursiveResults={s.recursiveResults}
          setRecursiveResults={s.setRecursiveResults}
          recursiveBusy={s.recursiveBusy}
          runRecursiveSearch={s.runRecursiveSearch}
          searchRef={s.searchRef}
          kindFilter={s.kindFilter}
          setKindFilter={s.setKindFilter}
          viewMode={s.viewMode}
          sortKey={s.sortKey}
          setSortKey={s.setSortKey}
          sortDir={s.sortDir}
          setSortDir={s.setSortDir}
          selected={s.selected}
          focusPath={s.focusPath}
          selectedEntries={s.selectedEntries}
          selectedSize={s.selectedSize}
          onRowClick={s.onRowClick}
          clearSelection={s.clearSelection}
          preview={s.preview}
          previewFor={s.previewFor}
          dirMeta={s.dirMeta}
          dirMetaFor={s.dirMetaFor}
          renaming={s.renaming}
          setRenaming={s.setRenaming}
          renameDraft={s.renameDraft}
          setRenameDraft={s.setRenameDraft}
          startRename={s.startRename}
          commitRename={s.commitRename}
          creating={s.creating}
          setCreating={s.setCreating}
          createDraft={s.createDraft}
          setCreateDraft={s.setCreateDraft}
          commitCreate={s.commitCreate}
          onCopyPath={s.onCopyPath}
          onReveal={s.onReveal}
          onTrashMany={s.onTrashMany}
          onDuplicate={s.onDuplicate}
          listRef={s.listRef}
          lastLoadedAt={s.lastLoadedAt}
          showToast={s.showToast}
        />
      </div>

      {/* Toast */}
      {s.toast && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 14,
            padding: '8px 14px',
            border: `1px solid ${s.toast.tone === 'err' ? 'rgba(255, 77, 94, 0.4)' : 'var(--line-soft)'}`,
            background: s.toast.tone === 'err' ? 'rgba(255, 77, 94, 0.08)' : 'rgba(6, 14, 22, 0.92)',
            color: s.toast.tone === 'err' ? 'var(--red)' : 'var(--cyan)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.18em',
            fontWeight: 700,
            pointerEvents: 'none',
          }}
        >
          {s.toast.msg}
        </div>
      )}
    </ModuleView>
  );
}
