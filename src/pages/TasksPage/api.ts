import { invoke, invokeSafe } from '../../lib/tauri';
import type { Reminder } from '../../bindings/Reminder';

export type { Reminder };

export async function listReminders(includeCompleted = false): Promise<ReadonlyArray<Reminder>> {
  // Raw invoke so usePoll can surface permission / bridge failures to the user.
  return await invoke<Reminder[]>('reminders_list', { includeCompleted, limit: 200 });
}

export async function listLists(): Promise<ReadonlyArray<string>> {
  // Lists are optional UI chrome — tolerate failure silently.
  return (await invokeSafe<string[]>('reminders_lists')) ?? [];
}

export async function createReminder(
  title: string, list?: string, notes?: string, due?: string,
): Promise<Reminder | null> {
  return invokeSafe<Reminder>('reminders_create', {
    title,
    notes: notes ?? null,
    listName: list ?? null,
    dueIso: due ?? null,
  });
}

export async function completeReminder(id: string): Promise<void> {
  await invokeSafe<void>('reminders_complete', { id });
}

export async function deleteReminder(id: string): Promise<void> {
  await invokeSafe<void>('reminders_delete', { id });
}

export async function renameReminder(id: string, title: string): Promise<void> {
  await invokeSafe<void>('reminders_update', { id, title });
}
