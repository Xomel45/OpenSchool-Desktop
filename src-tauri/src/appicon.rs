//! The icon the user picked in the settings: it replaces the icon of the window and of the tray at run time.
//! The pictures are drawn by `icons/make_icons.py` and built into the program. The taskbar of some desktops (KDE on Wayland,
//! GNOME) shows the icon of the installed `.desktop` file instead, which cannot change while the app runs.

use tauri::image::Image;
use tauri::{AppHandle, Manager};

const ICONS: &[(&str, &[u8])] = &[
    ("graphite", include_bytes!("../icons/variants/graphite.png")),
    ("ink", include_bytes!("../icons/variants/ink.png")),
    ("night", include_bytes!("../icons/variants/night.png")),
    ("paper", include_bytes!("../icons/variants/paper.png")),
    ("dusk", include_bytes!("../icons/variants/dusk.png")),
    ("indigo", include_bytes!("../icons/variants/indigo.png")),
    ("dawn", include_bytes!("../icons/variants/dawn.png")),
    ("ring", include_bytes!("../icons/variants/ring.png")),
    ("disc", include_bytes!("../icons/variants/disc.png")),
    ("spark", include_bytes!("../icons/variants/spark.png")),
];

#[tauri::command]
pub fn set_app_icon(app: AppHandle, id: String) -> Result<(), String> {
    let bytes = ICONS.iter().find(|(name, _)| *name == id).map(|(_, b)| *b).ok_or("неизвестная иконка")?;
    let image = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(image.clone()).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_picture_decodes_and_is_square() {
        for (name, bytes) in ICONS {
            let image = Image::from_bytes(bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((image.width(), image.height()), (256, 256), "{name}");
        }
    }

    /// The list the settings page shows (`ui/js/icons.js`) and the list built in here must be the same.
    #[test]
    fn the_settings_page_lists_the_same_icons() {
        let js = include_str!("../../ui/js/icons.js");
        let in_js: Vec<&str> = js.split("id: '").skip(1).filter_map(|s| s.split('\'').next()).collect();
        let here: Vec<&str> = ICONS.iter().map(|(n, _)| *n).collect();
        assert_eq!(in_js, here);
    }
}
