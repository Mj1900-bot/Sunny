//! macOS application menu bar. Item ids prefixed with `go-` are intercepted
//! in `startup::setup` and re-emitted as `sunny://nav` events for the frontend.

use tauri::AppHandle;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

pub fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "SUNNY")
        .text("about", "About SUNNY")
        .separator()
        .text("preferences", "Settings…")
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo().redo().separator()
        .cut().copy().paste().select_all()
        .build()?;

    // View menu mirrors the ViewKey union in src/store/view.ts — keep the two
    // in sync (the "go-<key>" ids are intercepted in `on_menu_event` below and
    // re-emitted as `sunny://nav` for the frontend's Dashboard listener).
    let view = SubmenuBuilder::new(app, "View")
        .text("go-overview", "Overview")
        .separator()
        .text("go-files", "Files")
        .text("go-apps", "Apps")
        .text("go-auto", "Auto")
        .text("go-tasks", "Tasks")
        .text("go-calendar", "Calendar")
        .text("go-screen", "Screen")
        .text("go-contacts", "Contacts")
        .text("go-notes", "Notes")
        .text("go-memory", "Memory")
        .text("go-web", "Web")
        .text("go-vault", "Vault")
        .text("go-capabilities", "Skills")
        .text("go-constitution", "Constitution")
        .text("go-history", "Agent History")
        .separator()
        .text("go-settings", "Settings")
        .separator()
        .fullscreen()
        .build()?;

    let assistant = SubmenuBuilder::new(app, "Assistant")
        .item(&MenuItemBuilder::with_id("listen", "Hold to Talk").accelerator("Space").build(app)?)
        .text("toggle-voice", "Toggle Voice Output")
        .separator()
        .text("cycle-theme", "Cycle Theme")
        .text("cycle-state", "Cycle Orb State")
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize().maximize().close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &view, &assistant, &window])
        .build()?;

    Ok(menu)
}
