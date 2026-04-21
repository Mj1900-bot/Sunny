export type MessageContact = Readonly<{
  handle: string;
  display: string;
  last_message: string;
  last_ts: number;
  message_count: number;
  is_imessage: boolean;
  /** Number of unread inbound messages in this conversation. 0 when caught up. */
  unread_count?: number;
}>;

export type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly source: 'messages' | 'fallback' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'error'; readonly message: string };

export type DetailProps = Readonly<{
  contact: MessageContact;
  copiedLabel: string | null;
  onCopyHandle: (handle: string) => void;
  onOpenInMessages: (handle: string) => void;
  onSendText: (handle: string, body: string) => Promise<boolean>;
  onCall: (handle: string, mode: CallMode) => Promise<void>;
}>;

export type CallMode = 'phone' | 'facetime_audio' | 'facetime_video';

export type ConversationMessage = Readonly<{
  rowid: number;
  text: string;
  ts: number;
  from_me: boolean;
  sender: string | null;
  is_imessage: boolean;
  has_attachment: boolean;
}>;

export type DetailRowProps = Readonly<{
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}>;

export type ActionChipProps = Readonly<{
  label: string;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}>;

export type PermissionDeniedProps = Readonly<{
  onOpenSettings: () => void;
  onRetry: () => void;
}>;
