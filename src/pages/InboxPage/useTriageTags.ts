/**
 * Persistent triage tags written by SUNNY TRIAGE action.
 * Stored in localStorage keyed by item id so they survive refreshes.
 * Immutably updated — always returns a new map on write.
 */

import { useState, useCallback } from 'react';
import type { TriageLabel } from './triage';

const LS_KEY = 'sunny:inbox:triage-tags';

export type TriageTags = Readonly<Record<string, TriageLabel>>;

function load(): TriageTags {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as TriageTags;
  } catch {
    return {};
  }
}

function persist(tags: TriageTags): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(tags));
  } catch {
    // quota exceeded — silently skip
  }
}

export function useTriageTags() {
  const [tags, setTags] = useState<TriageTags>(load);

  const writeTags = useCallback((next: TriageTags) => {
    persist(next);
    setTags(next);
  }, []);

  const mergeTag = useCallback((id: string, label: TriageLabel) => {
    setTags(prev => {
      const next = { ...prev, [id]: label };
      persist(next);
      return next;
    });
  }, []);

  return { tags, writeTags, mergeTag };
}
