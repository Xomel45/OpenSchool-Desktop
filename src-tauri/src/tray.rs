//! The tray icon: left click or "Открыть" brings the window back, "Выход" really quits.
//! With "close to tray" on, closing the window only hides it, so the background check keeps running.
//! The first (inactive) menu line and the tooltip say what lesson is on now (`set_now`, sent by the page); on Linux the
//! tray has no tooltip (AppIndicator), so the menu line is what is seen there.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

const NOTHING_NOW: &str = "Сейчас уроков нет";

/// The "now" line of the tray menu (set once the tray exists).
#[derive(Default)]
pub struct NowLine(Mutex<Option<MenuItem<Wry>>>);

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть OpenSchool", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let now = MenuItem::with_id(app, "now", NOTHING_NOW, false, None::<&str>)?;
    let menu = Menu::with_items(app, &[&now, &PredefinedMenuItem::separator(app)?, &open, &quit])?;
    if let Ok(mut n) = app.state::<NowLine>().0.lock() {
        *n = Some(now);
    }
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("OpenSchool")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// One line, no control characters, at most `max` characters.
fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// The page says what is on now ("" = nothing): window title, tray tooltip and the first menu line.
#[tauri::command]
pub fn set_now(app: AppHandle, text: String) {
    let text = one_line(&text, 120);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&if text.is_empty() { "OpenSchool".to_string() } else { format!("{text} — OpenSchool") });
    }
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(if text.is_empty() { "OpenSchool".to_string() } else { format!("OpenSchool\n{text}") }));
    }
    if let Ok(n) = app.state::<NowLine>().0.lock()
        && let Some(item) = n.as_ref()
    {
        let _ = item.set_text(if text.is_empty() { NOTHING_NOW } else { text.as_str() });
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_now_text_is_one_short_line() {
        assert_eq!(super::one_line("Алгебра,\n каб.\t21\u{7}", 120), "Алгебра, каб. 21");
        assert_eq!(super::one_line(&"я".repeat(200), 120).chars().count(), 120);
    }
}
