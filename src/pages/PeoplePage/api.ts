/**
 * PeoplePage data layer.
 *
 * `contacts_book_list` on the Rust side returns entries in the shape
 * `{ handle_key, name }` — handle_key is already normalised (digits-only
 * for phones, lowercased emails). `messages_recent` returns MessageContacts
 * whose `.handle` is the raw chat_identifier (e.g. "+16045551234" or
 * "me@example.com"). We normalise that identically when joining so
 * "+1 (604) 555-1234" and "6045551234" land on the same Person.
 *
 * `ContactBookEntry` and `MessageContact` are re-exported from the
 * auto-generated ts-rs bindings (`src/bindings/*.ts`) so the Rust
 * structs are the single source of truth for the wire shape.
 * Regenerate with `cd src-tauri && cargo test --lib export_bindings_`
 * — the .cargo/config.toml sets TS_RS_EXPORT_DIR so output lands in
 * `src/bindings/`.
 */
import { invokeSafe } from '../../lib/tauri';
import type { ContactBookEntry } from '../../bindings/ContactBookEntry';
import type { MessageContact } from '../../bindings/MessageContact';

export { normaliseHandle } from '../../lib/handles';
export type { ContactBookEntry, MessageContact };

export async function loadBook(): Promise<ReadonlyArray<ContactBookEntry>> {
  return (await invokeSafe<ContactBookEntry[]>('contacts_book_list')) ?? [];
}

export async function loadRecentChats(): Promise<ReadonlyArray<MessageContact>> {
  return (await invokeSafe<MessageContact[]>('messages_recent', { limit: 200 })) ?? [];
}
