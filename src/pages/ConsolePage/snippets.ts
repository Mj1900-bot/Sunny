/**
 * Saved REPL snippets — persisted in localStorage.
 * The user can save any executed entry; snippets can be recalled into the editor.
 */

const KEY = 'sunny.console.snippets.v1';
const MAX = 50;

export type Snippet = {
  readonly id: string;
  readonly lang: 'py' | 'sh';
  readonly code: string;
  readonly savedAt: number;
  readonly label: string;
};

function load(): ReadonlyArray<Snippet> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Snippet[]) : [];
  } catch {
    return [];
  }
}

function persist(snippets: ReadonlyArray<Snippet>): void {
  try { localStorage.setItem(KEY, JSON.stringify(snippets)); } catch { /* quota */ }
}

export function getSnippets(): ReadonlyArray<Snippet> {
  return load();
}

export function saveSnippet(lang: 'py' | 'sh', code: string, label?: string): Snippet {
  const snippet: Snippet = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    lang,
    code,
    savedAt: Date.now(),
    label: label ?? (code.split('\n')[0].slice(0, 48) || '(snippet)'),
  };
  const existing = load().filter(s => s.id !== snippet.id);
  persist([snippet, ...existing].slice(0, MAX));
  return snippet;
}

export function deleteSnippet(id: string): void {
  persist(load().filter(s => s.id !== id));
}
