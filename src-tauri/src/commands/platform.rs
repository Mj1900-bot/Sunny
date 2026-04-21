//! macOS platform app integration: Notes, Reminders, Calendar, Mail, Media, Worldinfo.

use crate::notes_app;
use crate::reminders;
use crate::calendar;
use crate::mail;
use crate::media;
use crate::worldinfo;

// ---------------- Notes.app ----------------

#[tauri::command]
pub async fn notes_app_list(folder: Option<String>, limit: Option<usize>) -> Result<Vec<notes_app::Note>, String> {
    notes_app::list_notes(folder, limit).await
}

#[tauri::command]
pub async fn notes_app_folders() -> Result<Vec<String>, String> {
    notes_app::list_folders().await
}

#[tauri::command]
pub async fn notes_app_create(title: String, body: String, folder: Option<String>) -> Result<notes_app::Note, String> {
    notes_app::create_note(title, body, folder).await
}

#[tauri::command]
pub async fn notes_app_append(id: String, text: String) -> Result<(), String> {
    notes_app::append_to_note(id, text).await
}

#[tauri::command]
pub async fn notes_app_search(query: String, limit: Option<usize>) -> Result<Vec<notes_app::Note>, String> {
    notes_app::search_notes(query, limit).await
}

// ---------------- Reminders.app ----------------

#[tauri::command]
pub async fn reminders_list(list_name: Option<String>, include_completed: Option<bool>, limit: Option<usize>) -> Result<Vec<reminders::Reminder>, String> {
    reminders::list_reminders(list_name, include_completed.unwrap_or(false), limit).await
}

#[tauri::command]
pub async fn reminders_lists() -> Result<Vec<String>, String> {
    reminders::list_reminder_lists().await
}

#[tauri::command]
pub async fn reminders_create(title: String, notes: Option<String>, list_name: Option<String>, due_iso: Option<String>) -> Result<reminders::Reminder, String> {
    reminders::create_reminder(title, notes, list_name, due_iso).await
}

#[tauri::command]
pub async fn reminders_complete(id: String) -> Result<(), String> {
    reminders::complete_reminder(id).await
}

#[tauri::command]
pub async fn reminders_delete(id: String) -> Result<(), String> {
    reminders::delete_reminder(id).await
}

// ---------------- Calendar.app ----------------

#[tauri::command]
pub async fn calendar_list_events(start_iso: String, end_iso: String, calendar_name: Option<String>, limit: Option<usize>) -> Result<Vec<calendar::CalendarEvent>, String> {
    calendar::list_events_range(start_iso, end_iso, calendar_name, limit).await
}

#[tauri::command]
pub async fn calendar_list_calendars() -> Result<Vec<String>, String> {
    calendar::list_calendars().await
}

#[tauri::command]
pub async fn calendar_create_event(title: String, start_iso: String, end_iso: String, calendar_name: Option<String>, location: Option<String>, notes: Option<String>) -> Result<calendar::CalendarEvent, String> {
    calendar::create_event(title, start_iso, end_iso, calendar_name, location, notes).await
}

#[tauri::command]
pub async fn calendar_delete_event(id: String, calendar_name: Option<String>) -> Result<(), String> {
    calendar::delete_event(id, calendar_name).await
}

// ---------------- Mail.app ----------------

#[tauri::command]
pub async fn mail_list_recent(limit: Option<usize>, unread_only: Option<bool>) -> Result<Vec<mail::MailMessage>, String> {
    mail::list_recent_messages(limit, unread_only.unwrap_or(false)).await
}

#[tauri::command]
pub async fn mail_list_accounts() -> Result<Vec<String>, String> {
    mail::list_accounts().await
}

#[tauri::command]
pub async fn mail_unread_count() -> Result<i64, String> {
    mail::unread_count().await
}

#[tauri::command]
pub async fn mail_search(query: String, limit: Option<usize>) -> Result<Vec<mail::MailMessage>, String> {
    mail::search_messages(query, limit).await
}

// ---------------- Media control (Spotify, Music, system) ----------------

#[tauri::command]
pub async fn media_toggle_play_pause() -> Result<(), String> {
    media::media_toggle_play_pause().await
}

#[tauri::command]
pub async fn media_play() -> Result<(), String> { media::media_play().await }

#[tauri::command]
pub async fn media_pause() -> Result<(), String> { media::media_pause().await }

#[tauri::command]
pub async fn media_next() -> Result<(), String> { media::media_next().await }

#[tauri::command]
pub async fn media_prev() -> Result<(), String> { media::media_prev().await }

#[tauri::command]
pub async fn media_volume_set(percent: u32) -> Result<(), String> {
    media::media_volume_set(percent).await
}

#[tauri::command]
pub async fn media_volume_get() -> Result<u32, String> {
    media::media_volume_get().await
}

#[tauri::command]
pub async fn media_now_playing() -> Result<media::NowPlaying, String> {
    media::media_now_playing().await
}

// ---------------- Worldinfo (weather, stocks, units) ----------------

#[tauri::command]
pub async fn weather_current(city: String) -> Result<worldinfo::Weather, String> {
    worldinfo::weather_current(city).await
}

#[tauri::command]
pub async fn weather_forecast(city: String, days: u32) -> Result<worldinfo::Forecast, String> {
    worldinfo::weather_forecast(city, days).await
}

#[tauri::command]
pub async fn stock_quote(ticker: String) -> Result<worldinfo::StockQuote, String> {
    worldinfo::stock_quote(ticker).await
}

#[tauri::command]
pub async fn unit_convert(value: f64, from_unit: String, to_unit: String) -> Result<f64, String> {
    worldinfo::unit_convert(value, from_unit, to_unit).await
}
