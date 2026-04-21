import { invoke } from '../../lib/tauri';

export type EpisodicKind =
  | 'user' | 'agent_step' | 'perception' | 'reflection' | 'note' | 'correction' | 'goal'
  | 'tool_call' | 'tool_result' | 'answer';

export type EpisodicItem = {
  id: string;
  kind: EpisodicKind;
  text: string;
  tags: ReadonlyArray<string>;
  meta: unknown;
  created_at: number;
};

export async function listEpisodic(limit = 400): Promise<ReadonlyArray<EpisodicItem>> {
  return await invoke<EpisodicItem[]>('memory_episodic_list', { limit, offset: 0 });
}

export async function addJournalEntry(text: string, tags: ReadonlyArray<string> = ['journal']): Promise<void> {
  await invoke('memory_episodic_add', {
    kind: 'note',
    text,
    tags,
    meta: { source: 'journal-page' },
  });
}
