//! macOS application tools. Read-path tools carry
//! `macos.<app>` capabilities (`macos.mail`, `macos.calendar`,
//! `macos.notes`, `macos.reminders`, `macos.contacts`); write-path
//! tools add `.write` (`macos.mail.write`, `macos.calendar.write`,
//! `macos.notes.write`, `macos.messaging.write`) or the side-effect
//! capability (`app:launch`, `shortcut:run`). Trust-class is
//! ExternalRead for anything that touches user-authored content and
//! ExternalWrite for anything that emits a side effect.
pub mod app_launch;
pub mod calendar_create_event;
pub mod calendar_today;
pub mod calendar_upcoming;
pub mod contacts_lookup;
pub mod nl_time;
pub mod imessage_send;
pub mod mail_list_unread;
pub mod mail_search;
pub mod mail_send;
pub mod mail_unread_count;
pub mod messaging_fetch_conversation;
pub mod messaging_list_chats;
pub mod messaging_send_sms;
pub mod notes_append;
pub mod notes_create;
pub mod notes_search;
pub mod reminders_add;
pub mod reminders_list;
pub mod shortcut_run;
