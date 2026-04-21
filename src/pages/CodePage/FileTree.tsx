/**
 * FileTree — collapsible directory tree built from git ls-files output.
 *
 * Premium features:
 *  · File-type icons (unicode)
 *  · Dirty indicators (dot per modified/added/deleted file)
 *  · Dir child-count badges
 *  · Collapse all / expand all controls
 */

import { useCallback, useMemo, useState } from 'react';

type TreeNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'dir'; name: string; children: ReadonlyArray<TreeNode>; fileCount: number };

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

function buildTree(paths: ReadonlyArray<string>): ReadonlyArray<TreeNode> {
  const root: Map<string, TreeNode> = new Map();

  for (const p of paths) {
    const parts = p.split('/');
    let map = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      if (isFile) {
        map.set(part, { kind: 'file', name: part, path: p });
      } else {
        let existing = map.get(part);
        if (!existing || existing.kind !== 'dir') {
          const dir: TreeNode = { kind: 'dir', name: part, children: [], fileCount: 0 };
          map.set(part, dir);
          existing = dir;
        }
        const dir = existing as { kind: 'dir'; name: string; children: TreeNode[]; fileCount: number };
        const childMap = new Map<string, TreeNode>(dir.children.map(c => [c.name, c]));
        map = childMap as unknown as Map<string, TreeNode>;
        dir.children = [...childMap.values()];
      }
    }
  }

  return sortNodes(addCounts([...root.values()]));
}

function addCounts(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(n => {
    if (n.kind === 'dir') {
      const children = addCounts(n.children as TreeNode[]);
      const count = countFiles(children);
      return { ...n, children, fileCount: count };
    }
    return n;
  });
}

function countFiles(nodes: ReadonlyArray<TreeNode>): number {
  let c = 0;
  for (const n of nodes) {
    if (n.kind === 'file') c++;
    else c += (n as { fileCount: number }).fileCount;
  }
  return c;
}

function sortNodes(nodes: ReadonlyArray<TreeNode>): ReadonlyArray<TreeNode> {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// File type utils
// ---------------------------------------------------------------------------

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

const EXT_COLOR: Record<string, string> = {
  ts: 'var(--cyan)', tsx: 'var(--cyan)',
  js: 'var(--amber)', jsx: 'var(--amber)',
  rs: 'var(--gold)', toml: 'var(--violet)',
  json: 'var(--green)', md: 'var(--ink-2)',
  css: 'var(--teal)', html: 'var(--lime)',
  py: 'var(--amber)', sh: 'var(--green)',
  lock: 'var(--ink-dim)', yaml: 'var(--violet)', yml: 'var(--violet)',
  svg: 'var(--pink)', png: 'var(--pink)', jpg: 'var(--pink)',
  sql: 'var(--blue)', swift: 'var(--coral)',
};

const EXT_ICON: Record<string, string> = {
  ts: '⚡', tsx: '⚡', js: '☀', jsx: '☀',
  rs: '🦀', toml: '⚙', json: '{}', md: '📝',
  css: '🎨', html: '◇', py: '🐍', sh: '▶',
  lock: '🔒', yaml: '⚙', yml: '⚙',
  svg: '◈', png: '▣', jpg: '▣',
  sql: '⬡', swift: '🐦',
};

function fileColor(name: string): string {
  return EXT_COLOR[ext(name)] ?? 'var(--ink)';
}

function fileIcon(name: string): string {
  return EXT_ICON[ext(name)] ?? '·';
}

// ---------------------------------------------------------------------------
// Dirty file classification
// ---------------------------------------------------------------------------

type DirtyKind = 'modified' | 'added' | 'deleted' | 'untracked';

function parseDirtyFiles(statusLines: ReadonlyArray<string>): Map<string, DirtyKind> {
  const map = new Map<string, DirtyKind>();
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;
    if (code === '??') map.set(path, 'untracked');
    else if (code.includes('D')) map.set(path, 'deleted');
    else if (code.includes('A')) map.set(path, 'added');
    else if (code.includes('M')) map.set(path, 'modified');
  }
  return map;
}

const DIRTY_COLOR: Record<DirtyKind, string> = {
  modified: 'var(--amber)',
  added: 'var(--green)',
  deleted: 'var(--red)',
  untracked: 'var(--cyan)',
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function DirNode({
  node, selected, depth, onSelect, dirty, allOpen,
}: {
  node: { kind: 'dir'; name: string; children: ReadonlyArray<TreeNode>; fileCount: number };
  selected: string | null;
  depth: number;
  onSelect: (path: string) => void;
  dirty: Map<string, DirtyKind>;
  allOpen: boolean | null;
}) {
  const [open, setOpen] = useState(depth < 2);

  // Respond to collapse/expand all signals
  const isOpen = allOpen !== null ? allOpen : open;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
          width: '100%', paddingLeft: depth * 14,
          paddingTop: 3, paddingBottom: 3,
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
          letterSpacing: '0.04em',
          transition: 'background 100ms ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(57, 229, 255, 0.05)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ color: 'var(--ink-dim)', fontSize: 9, flexShrink: 0, width: 9, textAlign: 'center' }}>
          {isOpen ? '▾' : '▸'}
        </span>
        <span style={{ color: 'var(--violet)', fontWeight: 600 }}>{node.name}/</span>
        <span style={{
          marginLeft: 'auto',
          fontFamily: 'var(--mono)',
          fontSize: 9,
          color: 'var(--ink-dim)',
          paddingRight: 4,
        }}>
          {node.fileCount}
        </span>
      </button>
      {isOpen && (
        <div style={{ animation: 'fadeSlideIn 120ms ease-out' }}>
          {sortNodes(node.children).map(child =>
            child.kind === 'dir' ? (
              <DirNode
                key={child.name}
                node={child as { kind: 'dir'; name: string; children: ReadonlyArray<TreeNode>; fileCount: number }}
                selected={selected}
                depth={depth + 1}
                onSelect={onSelect}
                dirty={dirty}
                allOpen={allOpen}
              />
            ) : (
              <FileNode
                key={(child as { path: string }).path}
                node={child as { kind: 'file'; name: string; path: string }}
                selected={selected}
                depth={depth + 1}
                onSelect={onSelect}
                dirty={dirty}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({
  node, selected, depth, onSelect, dirty,
}: {
  node: { kind: 'file'; name: string; path: string };
  selected: string | null;
  depth: number;
  onSelect: (path: string) => void;
  dirty: Map<string, DirtyKind>;
}) {
  const active = selected === node.path;
  const dirtyKind = dirty.get(node.path);
  const icon = fileIcon(node.name);
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      style={{
        all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
        width: '100%', paddingLeft: depth * 14,
        paddingTop: 2, paddingBottom: 2,
        fontFamily: 'var(--mono)', fontSize: 11,
        color: active ? '#fff' : fileColor(node.name),
        background: active ? 'rgba(57, 229, 255, 0.12)' : 'transparent',
        borderLeft: active ? '2px solid var(--cyan)' : '2px solid transparent',
        letterSpacing: '0.04em',
        transition: 'background 100ms ease',
      }}
    >
      <span style={{ fontSize: 10, opacity: 0.7, width: 14, textAlign: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      {node.name}
      {dirtyKind && (
        <span
          title={dirtyKind}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: DIRTY_COLOR[dirtyKind],
            boxShadow: `0 0 4px ${DIRTY_COLOR[dirtyKind]}`,
            flexShrink: 0,
            marginLeft: 'auto',
            marginRight: 6,
          }}
        />
      )}
    </button>
  );
}

export function FileTree({
  paths, selected, onSelect, statusLines,
}: {
  paths: ReadonlyArray<string>;
  selected: string | null;
  onSelect: (path: string) => void;
  statusLines?: ReadonlyArray<string>;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const dirty = useMemo(() => parseDirtyFiles(statusLines ?? []), [statusLines]);
  const [allOpen, setAllOpen] = useState<boolean | null>(null);

  const collapseAll = useCallback(() => setAllOpen(false), []);
  const expandAll = useCallback(() => setAllOpen(true), []);
  const resetAll = useCallback(() => setAllOpen(null), []);

  if (paths.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Collapse / Expand controls */}
      <div style={{
        display: 'flex', gap: 6, marginBottom: 6,
        padding: '2px 0',
      }}>
        <button
          type="button"
          onClick={collapseAll}
          style={treeCtrlBtn}
          title="Collapse all directories"
        >⊟ COLLAPSE</button>
        <button
          type="button"
          onClick={expandAll}
          style={treeCtrlBtn}
          title="Expand all directories"
        >⊞ EXPAND</button>
        {allOpen !== null && (
          <button
            type="button"
            onClick={resetAll}
            style={{ ...treeCtrlBtn, color: 'var(--amber)' }}
            title="Reset to default"
          >↺ RESET</button>
        )}
      </div>
      {sortNodes(tree).map(node =>
        node.kind === 'dir' ? (
          <DirNode
            key={node.name}
            node={node as { kind: 'dir'; name: string; children: ReadonlyArray<TreeNode>; fileCount: number }}
            selected={selected}
            depth={0}
            onSelect={onSelect}
            dirty={dirty}
            allOpen={allOpen}
          />
        ) : (
          <FileNode
            key={(node as { path: string }).path}
            node={node as { kind: 'file'; name: string; path: string }}
            selected={selected}
            depth={0}
            onSelect={onSelect}
            dirty={dirty}
          />
        ),
      )}
    </div>
  );
}

const treeCtrlBtn = {
  all: 'unset' as const,
  cursor: 'pointer' as const,
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.18em',
  fontWeight: 700 as const,
  color: 'var(--ink-dim)',
  padding: '2px 6px',
  border: '1px solid var(--line-soft)',
  transition: 'color 100ms ease',
};
