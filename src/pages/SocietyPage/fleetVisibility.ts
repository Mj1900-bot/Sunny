import type { SubAgent } from '../../store/subAgentsLive';

export type FleetMode = 'all' | 'running' | 'done' | 'error';

/** Keep parent/child trees intact: show agents matching status + text, plus ancestors and descendants. */
export function selectVisibleFleet(
  active: SubAgent[],
  mode: FleetMode,
  query: string,
): SubAgent[] {
  const q = query.trim().toLowerCase();
  const textMatch = (a: SubAgent) => {
    if (!q) return true;
    return (
      a.task.toLowerCase().includes(q) ||
      a.role.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      (a.model && a.model.toLowerCase().includes(q)) ||
      (a.error && a.error.toLowerCase().includes(q))
    );
  };
  const statusMatch = (a: SubAgent) => {
    if (mode === 'all') return true;
    if (mode === 'running') return a.status === 'running';
    if (mode === 'done') return a.status === 'done';
    if (mode === 'error') return a.status === 'error';
    return true;
  };
  const match = (a: SubAgent) => statusMatch(a) && textMatch(a);

  const byId = new Map(active.map(a => [a.id, a]));
  const vis = new Set<string>();
  for (const a of active) {
    if (match(a)) vis.add(a.id);
  }
  for (const id of [...vis]) {
    let p = byId.get(id)?.parentId ?? null;
    while (p) {
      vis.add(p);
      p = byId.get(p)?.parentId ?? null;
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const a of active) {
      if (a.parentId && vis.has(a.parentId) && !vis.has(a.id)) {
        vis.add(a.id);
        added = true;
      }
    }
  }
  return active.filter(a => vis.has(a.id));
}
