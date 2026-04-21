//! iMessage, SMS, phone call, and contacts commands.

use crate::messaging;
use crate::messages;
use crate::messages_watcher;
use crate::contacts_book;

// ---------------- Messages (iMessage contacts) ----------------

#[tauri::command]
pub async fn messages_recent(limit: Option<usize>) -> Result<Vec<messages::MessageContact>, String> {
    messages::recent_contacts(limit.unwrap_or(100)).await
}

// ---------------- Messaging (iMessage / SMS send) ----------------

#[tauri::command]
pub async fn messaging_send_imessage(to: String, body: String) -> Result<(), String> {
    messaging::send_imessage(to, body).await
}

#[tauri::command]
pub async fn messaging_send_sms(to: String, body: String) -> Result<(), String> {
    messaging::send_sms(to, body).await
}

#[tauri::command]
pub async fn messaging_list_chats(limit: Option<usize>) -> Result<Vec<messaging::ChatSummary>, String> {
    messaging::list_chats(limit).await
}

#[tauri::command]
pub async fn messaging_call_phone(to: String) -> Result<(), String> {
    messaging::call_phone(to).await
}

#[tauri::command]
pub async fn messaging_facetime_audio(to: String) -> Result<(), String> {
    messaging::facetime_audio(to).await
}

#[tauri::command]
pub async fn messaging_facetime_video(to: String) -> Result<(), String> {
    messaging::facetime_video(to).await
}

#[tauri::command]
pub async fn messaging_fetch_conversation(
    chat_identifier: String,
    limit: Option<usize>,
    since_rowid: Option<i64>,
) -> Result<Vec<messaging::ConversationMessage>, String> {
    messaging::fetch_conversation(chat_identifier, limit, since_rowid).await
}

#[tauri::command]
pub async fn messages_watcher_set_subscriptions(
    subscriptions: Vec<messages_watcher::Subscription>,
) -> Result<(), String> {
    messages_watcher::set_subscriptions(subscriptions).await
}

#[tauri::command]
pub async fn messages_watcher_subscriptions() -> Vec<messages_watcher::Subscription> {
    messages_watcher::list_subscriptions().await
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ContactBookEntry {
    pub handle_key: String,
    pub name: String,
}

#[tauri::command]
pub async fn contacts_book_list() -> Vec<ContactBookEntry> {
    let idx = contacts_book::get_index().await;
    idx.entries()
        .into_iter()
        .map(|(handle_key, name)| ContactBookEntry { handle_key, name })
        .collect()
}
