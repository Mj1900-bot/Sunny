//! Low-level input automation primitives for SUNNY.
//!
//! Wraps the `enigo` crate so SUNNY can drive the mouse and keyboard of the host
//! Mac. All functions are `async` but the underlying `enigo` API is synchronous,
//! so every call is off-loaded to `tokio::task::spawn_blocking` to avoid
//! stalling the runtime. Every error path returns a human-readable `String`.
//!
//! ### Coordinate system
//! Cartesian, origin at the top-left of the primary display, pixels.
//!
//! ### Threading model
//! A fresh `Enigo` instance is created for every call. This is intentional:
//! `Enigo` is not `Send` on all platforms, and re-creation is cheap compared to
//! the latency of a real input event.

use enigo::{
    Axis, Button, Coordinate,
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Move the cursor to absolute screen coordinates `(x, y)`.
pub async fn move_cursor(x: i32, y: i32) -> Result<(), String> {
    run_blocking(move || {
        let mut enigo = new_enigo()?;
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| format!("move_cursor({x},{y}) failed: {e}"))
    })
    .await
}

/// Click a mouse `button` (`"left" | "right" | "middle"`) `count` times.
///
/// `count` is clamped to `1..=2` (single or double click). For any other value
/// a validation error is returned.
pub async fn click(button: String, count: u32) -> Result<(), String> {
    let btn = parse_button(&button)?;
    let clicks = validate_count(count)?;
    run_blocking(move || {
        let mut enigo = new_enigo()?;
        for _ in 0..clicks {
            enigo
                .button(btn, Click)
                .map_err(|e| format!("click({button:?}) failed: {e}"))?;
        }
        Ok(())
    })
    .await
}

/// Move to `(x, y)` then click `button` `count` times.
pub async fn click_at(x: i32, y: i32, button: String, count: u32) -> Result<(), String> {
    let btn = parse_button(&button)?;
    let clicks = validate_count(count)?;
    run_blocking(move || {
        let mut enigo = new_enigo()?;
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| format!("click_at move to ({x},{y}) failed: {e}"))?;
        for _ in 0..clicks {
            enigo
                .button(btn, Click)
                .map_err(|e| format!("click_at click({button:?}) failed: {e}"))?;
        }
        Ok(())
    })
    .await
}

/// Scroll by `(dx, dy)` in wheel "clicks" (15° notches). Positive `dy` scrolls
/// down; positive `dx` scrolls right.
pub async fn scroll(dx: i32, dy: i32) -> Result<(), String> {
    run_blocking(move || {
        let mut enigo = new_enigo()?;
        if dy != 0 {
            enigo
                .scroll(dy, Axis::Vertical)
                .map_err(|e| format!("scroll vertical({dy}) failed: {e}"))?;
        }
        if dx != 0 {
            enigo
                .scroll(dx, Axis::Horizontal)
                .map_err(|e| format!("scroll horizontal({dx}) failed: {e}"))?;
        }
        Ok(())
    })
    .await
}

/// Type a Unicode string as if on the keyboard (does NOT interpret shortcuts).
pub async fn type_text(text: String) -> Result<(), String> {
    run_blocking(move || {
        let mut enigo = new_enigo()?;
        enigo
            .text(&text)
            .map_err(|e| format!("type_text failed: {e}"))
    })
    .await
}

/// Tap a single named key. See [`parse_key`] for the accepted names.
pub async fn key_tap(key: String) -> Result<(), String> {
    let parsed = parse_key(&key)?;
    run_blocking(move || {
        let mut enigo = new_enigo()?;
        enigo
            .key(parsed, Click)
            .map_err(|e| format!("key_tap({key:?}) failed: {e}"))
    })
    .await
}

/// Execute a keyboard combo: press all modifiers (and any non-final keys), tap
/// the last key, then release everything in reverse order. All modifiers are
/// resolved via [`parse_key`].
///
/// Empty input returns `Err`.
pub async fn key_combo(keys: Vec<String>) -> Result<(), String> {
    if keys.is_empty() {
        return Err("key_combo: keys list is empty".to_string());
    }
    let parsed = keys
        .iter()
        .map(|k| parse_key(k))
        .collect::<Result<Vec<_>, _>>()?;

    run_blocking(move || {
        let mut enigo = new_enigo()?;
        let (last, rest) = parsed
            .split_last()
            .expect("non-empty validated above");

        // Press all holds.
        let mut pressed: Vec<Key> = Vec::with_capacity(rest.len());
        for k in rest {
            if let Err(e) = enigo.key(*k, Press) {
                // Best-effort release of what we already pressed, then bail.
                for held in pressed.iter().rev() {
                    let _ = enigo.key(*held, Release);
                }
                return Err(format!("key_combo press failed: {e}"));
            }
            pressed.push(*k);
        }

        // Tap the final key.
        let tap_res = enigo
            .key(*last, Click)
            .map_err(|e| format!("key_combo tap failed: {e}"));

        // Always release holds in reverse order.
        for held in pressed.iter().rev() {
            let _ = enigo.key(*held, Release);
        }

        tap_res
    })
    .await
}

/// Current cursor position in absolute screen coordinates.
pub async fn get_cursor_position() -> Result<(i32, i32), String> {
    run_blocking(|| {
        let enigo = new_enigo()?;
        enigo
            .location()
            .map_err(|e| format!("get_cursor_position failed: {e}"))
    })
    .await
}

/// Primary display size `(width, height)` in pixels.
pub async fn get_screen_size() -> Result<(i32, i32), String> {
    run_blocking(|| {
        let enigo = new_enigo()?;
        enigo
            .main_display()
            .map_err(|e| format!("get_screen_size failed: {e}"))
    })
    .await
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Build a new `Enigo` with default `Settings`.
fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default())
        .map_err(|e| format!("failed to initialize Enigo (accessibility permission?): {e}"))
}

/// Execute `f` on a blocking thread and return its `Result`. Errors from the
/// runtime itself are converted to `String`.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("automation task panicked: {e}"))?
}

/// Validate click count. Only `1` (single) and `2` (double) are allowed.
fn validate_count(count: u32) -> Result<u32, String> {
    match count {
        1 | 2 => Ok(count),
        other => Err(format!(
            "click count must be 1 or 2, got {other}"
        )),
    }
}

/// Parse a mouse button name. Case-insensitive.
fn parse_button(name: &str) -> Result<Button, String> {
    match name.trim().to_ascii_lowercase().as_str() {
        "left" | "l" => Ok(Button::Left),
        "right" | "r" => Ok(Button::Right),
        "middle" | "m" => Ok(Button::Middle),
        other => Err(format!(
            "unknown mouse button {other:?} (expected left/right/middle)"
        )),
    }
}

/// Parse a key name into an `enigo::Key`.
///
/// Accepts (case-insensitive):
/// - Modifiers: `cmd/command/meta/super`, `ctrl/control`,
///   `opt/option/alt`, `shift`
/// - Named keys: `return/enter`, `tab`, `escape/esc`, `space`,
///   `left/right/up/down` (and `*arrow`), `home`, `end`,
///   `delete/del`, `backspace`, `pageup/pgup`, `pagedown/pgdn`, `insert`,
///   `capslock`
/// - Function keys: `f1`..`f19`
/// - Single character: any other single `char` becomes `Key::Unicode(c)`
fn parse_key(name: &str) -> Result<Key, String> {
    let lower = name.trim().to_ascii_lowercase();
    let key = match lower.as_str() {
        // Modifiers
        "cmd" | "command" | "meta" | "super" | "win" => Key::Meta,
        "ctrl" | "control" => Key::Control,
        "opt" | "option" | "alt" => Key::Alt,
        "shift" => Key::Shift,

        // Named keys
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" | "spacebar" => Key::Space,
        "left" | "leftarrow" | "arrowleft" => Key::LeftArrow,
        "right" | "rightarrow" | "arrowright" => Key::RightArrow,
        "up" | "uparrow" | "arrowup" => Key::UpArrow,
        "down" | "downarrow" | "arrowdown" => Key::DownArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "delete" | "del" | "forwarddelete" => Key::Delete,
        "backspace" => Key::Backspace,
        "pageup" | "pgup" => Key::PageUp,
        "pagedown" | "pgdn" => Key::PageDown,
        "capslock" => Key::CapsLock,

        // Function keys f1..f19
        fkey if fkey.starts_with('f') => match fkey[1..].parse::<u8>() {
            Ok(n @ 1..=19) => function_key(n).ok_or_else(|| format!("unsupported function key {fkey}"))?,
            _ => return Err(format!("unknown key {name:?}")),
        },

        // Single unicode char
        other if other.chars().count() == 1 => {
            let c = other.chars().next().expect("count == 1");
            Key::Unicode(c)
        }

        _ => return Err(format!("unknown key {name:?}")),
    };
    Ok(key)
}

/// Map a function-key number 1..=19 to its `Key` variant.
fn function_key(n: u8) -> Option<Key> {
    let k = match n {
        1 => Key::F1,
        2 => Key::F2,
        3 => Key::F3,
        4 => Key::F4,
        5 => Key::F5,
        6 => Key::F6,
        7 => Key::F7,
        8 => Key::F8,
        9 => Key::F9,
        10 => Key::F10,
        11 => Key::F11,
        12 => Key::F12,
        13 => Key::F13,
        14 => Key::F14,
        15 => Key::F15,
        16 => Key::F16,
        17 => Key::F17,
        18 => Key::F18,
        19 => Key::F19,
        _ => return None,
    };
    Some(k)
}

// ---------------------------------------------------------------------------
// Tests — pure helpers only. We never exercise real input from unit tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_button_is_case_insensitive() {
        assert!(matches!(parse_button("Left").unwrap(), Button::Left));
        assert!(matches!(parse_button("RIGHT").unwrap(), Button::Right));
        assert!(matches!(parse_button(" middle ").unwrap(), Button::Middle));
        assert!(parse_button("wheel").is_err());
    }

    #[test]
    fn parse_key_named_and_function_and_unicode() {
        // Modifier alias -> Meta
        assert!(matches!(parse_key("Command").unwrap(), Key::Meta));
        // Named key
        assert!(matches!(parse_key("return").unwrap(), Key::Return));
        // Arrow alias
        assert!(matches!(parse_key("ArrowLeft").unwrap(), Key::LeftArrow));
        // Function key within range
        assert!(matches!(parse_key("f5").unwrap(), Key::F5));
        // Unicode fallback
        match parse_key("a").unwrap() {
            Key::Unicode(c) => assert_eq!(c, 'a'),
            other => panic!("expected Unicode, got {other:?}"),
        }
        // Out-of-range f-key
        assert!(parse_key("f42").is_err());
        // Multi-char garbage
        assert!(parse_key("notakey").is_err());
    }

    #[test]
    fn validate_count_accepts_one_and_two_only() {
        assert_eq!(validate_count(1).unwrap(), 1);
        assert_eq!(validate_count(2).unwrap(), 2);
        assert!(validate_count(0).is_err());
        assert!(validate_count(3).is_err());
    }
}

// === REGISTER IN lib.rs ===
// #[tauri::command] async fn mouse_move(x: i32, y: i32) -> Result<(), String> { automation::move_cursor(x, y).await }
// #[tauri::command] async fn mouse_click(button: String, count: u32) -> Result<(), String> { automation::click(button, count).await }
// #[tauri::command] async fn mouse_click_at(x: i32, y: i32, button: String, count: u32) -> Result<(), String> { automation::click_at(x, y, button, count).await }
// #[tauri::command] async fn mouse_scroll(dx: i32, dy: i32) -> Result<(), String> { automation::scroll(dx, dy).await }
// #[tauri::command] async fn keyboard_type(text: String) -> Result<(), String> { automation::type_text(text).await }
// #[tauri::command] async fn keyboard_tap(key: String) -> Result<(), String> { automation::key_tap(key).await }
// #[tauri::command] async fn keyboard_combo(keys: Vec<String>) -> Result<(), String> { automation::key_combo(keys).await }
// #[tauri::command] async fn cursor_position() -> Result<(i32, i32), String> { automation::get_cursor_position().await }
// #[tauri::command] async fn screen_size() -> Result<(i32, i32), String> { automation::get_screen_size().await }
// In invoke_handler: mouse_move, mouse_click, mouse_click_at, mouse_scroll, keyboard_type, keyboard_tap, keyboard_combo, cursor_position, screen_size
// Also add: mod automation; at the top of lib.rs
// === END REGISTER ===
