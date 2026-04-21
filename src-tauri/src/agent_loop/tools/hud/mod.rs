//! HUD navigation + per-page state peek tools. `hud.read` covers the
//! cheap snapshot tools (`current_page_state`, `page_state_*`);
//! `hud.navigate` covers `navigate_to_page` and `page_action`, which
//! emit Tauri events to re-drive the frontend (read-path in spirit —
//! no side effects outside the app).
pub mod current_page_state;
pub mod navigate_to_page;
pub mod page_action;
pub mod page_state_calendar;
pub mod page_state_focus;
pub mod page_state_inbox;
pub mod page_state_notes;
pub mod page_state_tasks;
pub mod page_state_voice;
