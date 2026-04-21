import { invokeSafe } from '../../lib/tauri';
import { useView } from '../../store/view';
import type { EpisodicItem, EpisodicKind } from '../JournalPage/api';

export type { EpisodicItem, EpisodicKind };

/** Timeline still fetches "all recent episodic items and filters client-side"
 *  (the memory_episodic_list command doesn't accept a time window yet), but
 *  the cap is now tunable via Settings · MODULES · TIMELINE FETCH CAP so a
 *  user with a dense memory DB can trade rendering cost for history depth. */
export async function listDay(dayStartSecs: number, dayEndSecs: number): Promise<ReadonlyArray<EpisodicItem>> {
  const limit = useView.getState().settings.timelineFetchCap;
  const all = (await invokeSafe<EpisodicItem[]>('memory_episodic_list', { limit, offset: 0 })) ?? [];
  return all.filter(e => e.created_at >= dayStartSecs && e.created_at < dayEndSecs);
}
