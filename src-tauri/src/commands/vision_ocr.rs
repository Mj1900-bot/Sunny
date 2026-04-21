//! Vision (screen capture), mouse/keyboard automation, and OCR commands.

use crate::vision;
use crate::automation;
use crate::ocr;

// ---------------- Vision (screen capture) ----------------

#[tauri::command]
pub async fn screen_capture_full(display: Option<usize>) -> Result<vision::ScreenImage, String> {
    vision::capture_full_screen(display).await
}

#[tauri::command]
pub async fn screen_capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<vision::ScreenImage, String> {
    vision::capture_region(x, y, w, h).await
}

#[tauri::command]
pub async fn screen_capture_active_window() -> Result<vision::ScreenImage, String> {
    vision::capture_active_window().await
}

// ---------------- Automation (mouse + keyboard) ----------------

#[tauri::command]
pub async fn mouse_move(x: i32, y: i32) -> Result<(), String> {
    automation::move_cursor(x, y).await
}

#[tauri::command]
pub async fn mouse_click(button: String, count: u32) -> Result<(), String> {
    automation::click(button, count).await
}

#[tauri::command]
pub async fn mouse_click_at(x: i32, y: i32, button: String, count: u32) -> Result<(), String> {
    automation::click_at(x, y, button, count).await
}

#[tauri::command]
pub async fn mouse_scroll(dx: i32, dy: i32) -> Result<(), String> {
    automation::scroll(dx, dy).await
}

#[tauri::command]
pub async fn keyboard_type(text: String) -> Result<(), String> {
    automation::type_text(text).await
}

#[tauri::command]
pub async fn keyboard_tap(key: String) -> Result<(), String> {
    automation::key_tap(key).await
}

#[tauri::command]
pub async fn keyboard_combo(keys: Vec<String>) -> Result<(), String> {
    automation::key_combo(keys).await
}

#[tauri::command]
pub async fn cursor_position() -> Result<(i32, i32), String> {
    automation::get_cursor_position().await
}

#[tauri::command]
pub async fn screen_size() -> Result<(i32, i32), String> {
    automation::get_screen_size().await
}

// ---------------- OCR ----------------

#[tauri::command]
pub async fn ocr_region(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    options: Option<ocr::OcrOptions>,
) -> Result<ocr::OcrResult, String> {
    ocr::ocr_region(x, y, w, h, options).await
}

#[tauri::command]
pub async fn ocr_full_screen(
    display: Option<usize>,
    options: Option<ocr::OcrOptions>,
) -> Result<ocr::OcrResult, String> {
    ocr::ocr_full_screen(display, options).await
}

#[tauri::command]
pub async fn ocr_image_base64(
    png_base64: String,
    options: Option<ocr::OcrOptions>,
) -> Result<ocr::OcrResult, String> {
    ocr::ocr_image_base64(png_base64, options).await
}
