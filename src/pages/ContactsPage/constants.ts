import type { MessageContact } from './types';

export const FALLBACK_CONTACTS: ReadonlyArray<MessageContact> = [
  {
    handle: '+14155550102',
    display: '+1 (415) 555-0102',
    last_message: 'See you at 7 — bringing the grant deck.',
    last_ts: Math.floor(Date.now() / 1000) - 60 * 42,
    message_count: 214,
    is_imessage: true,
  },
  {
    handle: 'kai.chen@example.com',
    display: 'kai.chen@example.com',
    last_message: 'Signed the NDA, pushed to the shared drive.',
    last_ts: Math.floor(Date.now() / 1000) - 60 * 60 * 3,
    message_count: 58,
    is_imessage: true,
  },
  {
    handle: '+16045550177',
    display: '+1 (604) 555-0177',
    last_message: 'Here’s the DICOM export you asked for.',
    last_ts: Math.floor(Date.now() / 1000) - 60 * 60 * 26,
    message_count: 12,
    is_imessage: false,
  },
];

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const PERMISSION_PATTERN = /permission|full disk|authorization/i;

export const PRIVACY_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
export const PRIVACY_PREFPANE_FALLBACK = '/System/Library/PreferencePanes/Security.prefPane';

export const AMBER = '#ffb347';
export const AMBER_GLOW = 'rgba(255, 179, 71, 0.35)';
export const AMBER_SOFT = 'rgba(255, 179, 71, 0.08)';
