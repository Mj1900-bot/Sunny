import { invokeSafe } from '../../lib/tauri';
import type { MailMessage, MessageContact } from '../TodayPage/api';

export type { MailMessage, MessageContact };

export type UnifiedItem =
  | { kind: 'mail'; id: string; when: number; data: MailMessage }
  | { kind: 'chat'; id: string; when: number; data: MessageContact };

export async function loadInbox(): Promise<{
  mail: ReadonlyArray<MailMessage>;
  chats: ReadonlyArray<MessageContact>;
}> {
  const [mail, chats] = await Promise.all([
    invokeSafe<MailMessage[]>('mail_list_recent', { limit: 40, unreadOnly: false }),
    invokeSafe<MessageContact[]>('messages_recent', { limit: 40 }),
  ]);
  return { mail: mail ?? [], chats: chats ?? [] };
}

export function unify(
  mail: ReadonlyArray<MailMessage>,
  chats: ReadonlyArray<MessageContact>,
): ReadonlyArray<UnifiedItem> {
  const items: UnifiedItem[] = [];
  for (const m of mail) {
    const when = Math.floor(new Date(m.received).getTime() / 1000);
    items.push({ kind: 'mail', id: `mail:${m.id}`, when, data: m });
  }
  for (const c of chats) {
    items.push({ kind: 'chat', id: `chat:${c.handle}`, when: c.last_ts, data: c });
  }
  items.sort((a, b) => b.when - a.when);
  return items;
}
