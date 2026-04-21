// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_secs: number;
};

export type FsReadText = {
  content: string;
  truncated: boolean;
  total_size: number;
  is_binary: boolean;
};

export type FsDirSize = {
  size: number;
  files: number;
  dirs: number;
  truncated: boolean;
};

export type KindColor = 'cyan' | 'amber' | 'green' | 'violet' | 'red' | 'dim';
export type KindFilter = 'all' | 'dir' | 'code' | 'doc' | 'img' | 'data' | 'other';
export type ViewMode = 'list' | 'grid';
export type SortKey = 'name' | 'size' | 'modified' | 'kind';
export type SortDir = 'asc' | 'desc';
