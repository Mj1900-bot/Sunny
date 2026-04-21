/**
 * captureTags — localStorage-backed per-capture tag store.
 * Tags are stored as sets of strings keyed by capture id.
 */

const KEY = 'sunny.screen.tags.v1';

type TagStore = Record<string, ReadonlyArray<string>>;

function load(): TagStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TagStore) : {};
  } catch {
    return {};
  }
}

function persist(store: TagStore): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* quota */ }
}

export function getCaptureTags(id: string): ReadonlyArray<string> {
  return load()[id] ?? [];
}

export function addCaptureTag(id: string, tag: string): void {
  const trimmed = tag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!trimmed) return;
  const store = load();
  const existing = store[id] ?? [];
  if (existing.includes(trimmed)) return;
  persist({ ...store, [id]: [...existing, trimmed] });
}

export function removeCaptureTag(id: string, tag: string): void {
  const store = load();
  const existing = store[id] ?? [];
  persist({ ...store, [id]: existing.filter(t => t !== tag) });
}

/** Search all captures by OCR text across the stored history.
 *  `texts` is a map from captureId → ocr text string. */
export function searchByText(
  texts: ReadonlyMap<string, string>,
  query: string,
): ReadonlyArray<string> {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const matches: string[] = [];
  for (const [id, text] of texts) {
    if (text.toLowerCase().includes(q)) matches.push(id);
  }
  return matches;
}
