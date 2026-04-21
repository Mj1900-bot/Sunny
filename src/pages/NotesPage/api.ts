import { invokeSafe } from '../../lib/tauri';
import type { Note } from '../../bindings/Note';

export type { Note };

export async function listFolders(): Promise<ReadonlyArray<string>> {
  return (await invokeSafe<string[]>('notes_app_folders')) ?? [];
}

export async function listNotes(folder?: string, limit = 80): Promise<ReadonlyArray<Note>> {
  return (await invokeSafe<Note[]>('notes_app_list', {
    folder: folder ?? null, limit,
  })) ?? [];
}

export async function searchNotes(query: string, limit = 80): Promise<ReadonlyArray<Note>> {
  return (await invokeSafe<Note[]>('notes_app_search', { query, limit })) ?? [];
}

export async function createNote(
  title: string, body: string, folder?: string,
): Promise<Note | null> {
  return invokeSafe<Note>('notes_app_create', { title, body, folder: folder ?? null });
}

export async function appendNote(id: string, text: string): Promise<void> {
  await invokeSafe<void>('notes_app_append', { id, text });
}
