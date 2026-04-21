import { derivePriority } from './TaskRow';
import type { Reminder } from './api';

export type SortMode = 'due' | 'priority' | 'title' | 'list' | 'created';

function priorityRank(title: string): number {
  const p = derivePriority(title);
  if (p === 'P1') return 0;
  if (p === 'P2') return 1;
  if (p === 'P3') return 2;
  return 3;
}

/** Stable sort for the visible task list. */
export function sortReminders(rows: ReadonlyArray<Reminder>, mode: SortMode): Reminder[] {
  const arr = [...rows];
  arr.sort((a, b) => {
    let c = 0;
    switch (mode) {
      case 'due': {
        const ad = a.due ? new Date(a.due).getTime() : Number.MAX_SAFE_INTEGER;
        const bd = b.due ? new Date(b.due).getTime() : Number.MAX_SAFE_INTEGER;
        c = ad - bd;
        break;
      }
      case 'priority':
        c = priorityRank(a.title) - priorityRank(b.title);
        break;
      case 'list':
        c = a.list.localeCompare(b.list, undefined, { sensitivity: 'base' });
        break;
      case 'created': {
        const ac = a.created ? new Date(a.created).getTime() : 0;
        const bc = b.created ? new Date(b.created).getTime() : 0;
        c = bc - ac;
        break;
      }
      case 'title':
      default:
        c = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        break;
    }
    if (c !== 0) return c;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
  return arr;
}
