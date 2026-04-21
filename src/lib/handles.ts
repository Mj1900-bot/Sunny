/**
 * Mirror of the Rust `contacts_book::normalise_handle` helper. Shared by
 * PeoplePage and ContactsPage so the contact↔chat join uses one canonical
 * form — drift between JS and Rust here silently drops matches (e.g.
 * "+1 (604) 555-1234" vs "6045551234" landing on different Persons).
 *
 * Rules, in order:
 * - trim → empty stays empty
 * - contains '@' → lowercase (email)
 * - strip non-digits; if digits are empty, fall back to lowercased trim
 * - 11 digits starting with '1' → drop the leading country code
 * - otherwise return the digits
 */
export function normaliseHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) return trimmed.toLowerCase();
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}
