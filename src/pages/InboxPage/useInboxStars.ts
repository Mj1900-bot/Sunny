/**
 * Starred inbox rows — persisted in localStorage for quick follow-up.
 */

import { useCallback, useState } from 'react';

const LS_KEY = 'sunny:inbox:stars:v1';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function persist(next: Set<string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...next]));
  } catch {
    /* quota */
  }
}

export function useInboxStars() {
  const [starred, setStarred] = useState<Set<string>>(load);

  const toggleStar = useCallback((id: string) => {
    setStarred(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  }, []);

  const isStarred = useCallback((id: string) => starred.has(id), [starred]);

  return { starred, toggleStar, isStarred };
}
