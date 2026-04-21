import { invokeSafe } from '../../lib/tauri';

export type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_secs: number;
};

export async function findScreenshots(root: string): Promise<ReadonlyArray<FsEntry>> {
  const hits = (await invokeSafe<FsEntry[]>('fs_search', {
    root, query: 'screenshot', maxResults: 400, maxVisited: 50_000,
  })) ?? [];
  return hits.filter(h => !h.is_dir && /\.(png|jpe?g|webp|heic)$/i.test(h.name));
}

export async function revealInFinder(path: string): Promise<void> {
  await invokeSafe('fs_reveal', { path });
}

export async function openPath(path: string): Promise<void> {
  await invokeSafe('open_path', { path });
}

// Reads a file as base64 for inlining into AI prompts. The backing Rust
// command `fs_read_base64` is not (yet) wired into the generate_handler! —
// we attempt it anyway so the UI is ready the moment it lands, and return
// null on failure so callers can fall back to passing the path.
export async function readImageBase64(path: string): Promise<string | null> {
  const result = await invokeSafe<string>('fs_read_base64', { path });
  if (!result) {
    // eslint-disable-next-line no-console
    console.warn('readImageBase64: fs_read_base64 unavailable, falling back to path-only');
  }
  return result;
}
