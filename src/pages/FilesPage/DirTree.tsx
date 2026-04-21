/**
 * DirTree — lazy-loading directory tree for the Files sidebar.
 *
 * Mounted below QUICK PATHS. Children are fetched via `fs_list` on the
 * first expansion of a node, then cached in a Map keyed by path. Depth
 * is capped so accidentally expanding a deeply nested fixture tree won't
 * exhaust the listing budget.
 */

import { useCallback, useEffect, useState } from 'react';
import { invokeSafe } from '../../lib/tauri';
import type { Entry } from './types';
import { basename } from './utils';
import { SectionHeader } from './components';

const INDENT = 12;
const DEPTH_CAP = 5;

const ROOT_PATHS: ReadonlyArray<{ label: string; path: string }> = [
  { label: '~', path: '~' },
  { label: 'Documents', path: '~/Documents' },
  { label: 'Desktop', path: '~/Desktop' },
  { label: 'Downloads', path: '~/Downloads' },
];

export function DirTree({
  currentPath, onNavigate,
}: {
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['~']));
  const [children, setChildren] = useState<Map<string, ReadonlyArray<Entry>>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const loadChildren = useCallback(async (path: string) => {
    setLoading(prev => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    const result = await invokeSafe<ReadonlyArray<Entry>>('fs_list', { path });
    setChildren(prev => {
      const next = new Map(prev);
      next.set(path, (result ?? []).filter(e => e.is_dir && !e.name.startsWith('.')));
      return next;
    });
    setLoading(prev => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const toggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!children.has(path)) void loadChildren(path);
      }
      return next;
    });
  }, [children, loadChildren]);

  // Eager-load the root so it shows something on mount.
  useEffect(() => {
    for (const r of ROOT_PATHS) {
      if (expanded.has(r.path) && !children.has(r.path)) {
        void loadChildren(r.path);
      }
    }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <SectionHeader label="TREE" />
      <div
        className="section"
        style={{
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          maxHeight: 280,
          overflow: 'auto',
        }}
      >
        {ROOT_PATHS.map(root => (
          <TreeNode
            key={root.path}
            label={root.label}
            path={root.path}
            depth={0}
            expanded={expanded}
            children_={children}
            loading={loading}
            currentPath={currentPath}
            onToggle={toggle}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </>
  );
}

function TreeNode({
  label, path, depth, expanded, children_, loading,
  currentPath, onToggle, onNavigate,
}: {
  label: string;
  path: string;
  depth: number;
  expanded: Set<string>;
  children_: Map<string, ReadonlyArray<Entry>>;
  loading: Set<string>;
  currentPath: string;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
}) {
  const isOpen = expanded.has(path);
  const kids = children_.get(path);
  const isBusy = loading.has(path);
  const isActive = currentPath === path;
  const canExpand = depth < DEPTH_CAP;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 2,
          paddingLeft: depth * INDENT,
        }}
      >
        <button
          onClick={() => canExpand && onToggle(path)}
          disabled={!canExpand}
          style={{
            all: 'unset',
            cursor: canExpand ? 'pointer' : 'default',
            width: 14, textAlign: 'center',
            fontFamily: 'var(--mono)', fontSize: 9,
            color: 'var(--ink-dim)',
          }}
          aria-label={isOpen ? 'collapse' : 'expand'}
        >
          {canExpand ? (isOpen ? '▼' : '▶') : '·'}
        </button>
        <button
          onClick={() => onNavigate(path)}
          title={path}
          style={{
            all: 'unset',
            cursor: 'pointer',
            flex: 1,
            padding: '3px 6px',
            fontFamily: 'var(--mono)', fontSize: 11,
            letterSpacing: '0.08em',
            color: isActive ? 'var(--cyan)' : 'var(--ink-2)',
            fontWeight: isActive ? 700 : 500,
            background: isActive ? 'rgba(57, 229, 255, 0.1)' : 'transparent',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {label}
        </button>
      </div>
      {isOpen && (
        <div>
          {isBusy && !kids && (
            <div style={{
              paddingLeft: (depth + 1) * INDENT + 16,
              fontFamily: 'var(--mono)', fontSize: 9,
              color: 'var(--ink-dim)', letterSpacing: '0.14em',
              padding: '2px 0',
            }}>LOADING…</div>
          )}
          {kids && kids.length === 0 && (
            <div style={{
              paddingLeft: (depth + 1) * INDENT + 16,
              fontFamily: 'var(--mono)', fontSize: 9,
              color: 'var(--ink-dim)', letterSpacing: '0.14em',
              padding: '2px 0',
            }}>EMPTY</div>
          )}
          {kids && kids.map(k => (
            <TreeNode
              key={k.path}
              label={basename(k.path) || k.name}
              path={k.path}
              depth={depth + 1}
              expanded={expanded}
              children_={children_}
              loading={loading}
              currentPath={currentPath}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
