//! The icon the user picked in the settings. The choice is kept here (not in the web page), so the icon is right from the first
//! moment of the next start. It replaces the icon of the window and of the tray at run time; the pictures are drawn by
//! `icons/make_icons.py` and built into the program.
//!
//! On Linux the dock, the taskbar and the menu take the icon from the installed `.desktop` file, not from the window (Wayland has no
//! per-window icons). So, when such a file is installed, a copy of it with the chosen icon is written to the user's own
//! `~/.local/share/applications` (it wins over the system one). The copy carries a marker line: a file without the marker is somebody's
//! own and is never touched, and choosing the default icon removes the copy again.

#[cfg(any(target_os = "linux", test))]
use std::path::Path;
use std::path::PathBuf;

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

const DEFAULT: &str = "graphite";
/// Shown (and used) only in the developer mode; the choice is kept while the mode is off. (A test compares with `ui/js/icons.js`.)
const DEV_ONLY: &[&str] = &["disc", "spark"];
/// Names the installed `.desktop` file may have (the package, the Arch package, the Tauri bundle).
#[cfg(any(target_os = "linux", test))]
const DESKTOP_NAMES: &[&str] = &["openschool.desktop", "openschool_desktop.desktop", "OpenSchool.desktop"];
#[cfg(any(target_os = "linux", test))]
const MARKER: &str = "X-OpenSchool-Icon-Managed=true";

fn bytes_of(id: &str) -> Option<&'static [u8]> {
    ICONS.iter().find(|(name, _)| *name == id).map(|(_, b)| *b)
}

/// The icon in use: a developer-only choice falls back to the default while the mode is off.
fn effective(id: &str, dev: bool) -> &str {
    if DEV_ONLY.contains(&id) && !dev { DEFAULT } else { id }
}

fn choice_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("icon.txt"))
}

fn apply(app: &AppHandle, chosen: &str) -> Result<(), String> {
    let id = effective(chosen, crate::commands::dev_mode());
    let bytes = bytes_of(id).ok_or("неизвестная иконка")?;
    let image = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(image.clone()).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    if let Err(e) = sync_launcher(app, id, bytes) {
        eprintln!("launcher icon: {e}"); // a nicety: the window and tray icons are already set
    }
    Ok(())
}

/// Called at start: the icon of the last choice.
pub fn restore(app: &AppHandle) {
    if let Some(id) = get_app_icon(app.clone()) {
        let _ = apply(app, &id);
    }
}

/// The saved choice (the program is the keeper of it; the page asks at start).
#[tauri::command]
pub fn get_app_icon(app: AppHandle) -> Option<String> {
    choice_file(&app).and_then(|f| std::fs::read_to_string(f).ok()).map(|t| t.trim().to_owned()).filter(|id| bytes_of(id).is_some())
}

#[tauri::command]
pub fn set_app_icon(app: AppHandle, id: String) -> Result<(), String> {
    bytes_of(&id).ok_or("неизвестная иконка")?;
    if let Some(file) = choice_file(&app) {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(file, &id).map_err(|e| e.to_string())?;
    }
    apply(&app, &id)
}

/// The `.desktop` text with its `Icon=` set to `icon` (only in the main group) and the marker added.
#[cfg(any(target_os = "linux", test))]
fn with_icon(text: &str, icon: &str) -> String {
    let (mut out, mut in_main, mut done) = (Vec::new(), false, false);
    for line in text.lines() {
        if line.starts_with('[') {
            in_main = line.trim() == "[Desktop Entry]";
            out.push(line.to_owned());
            if in_main {
                out.push(MARKER.to_owned());
            }
        } else if in_main && line.starts_with("Icon=") {
            out.push(format!("Icon={icon}"));
            done = true;
        } else if line.trim() != MARKER {
            out.push(line.to_owned());
        }
    }
    if !done && let Some(at) = out.iter().position(|l| l.as_str() == MARKER) {
        out.insert(at + 1, format!("Icon={icon}"));
    }
    out.join("\n") + "\n"
}

#[cfg(target_os = "linux")]
fn sync_launcher(app: &AppHandle, id: &str, png: &[u8]) -> Result<(), String> {
    let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".local/share"))).ok_or("нет домашней папки")?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    sync_launcher_in(&data_home, &[Path::new("/usr/share/applications"), Path::new("/usr/local/share/applications")], &app_data, id, png)
}

#[cfg(any(target_os = "linux", test))]
fn sync_launcher_in(data_home: &Path, system_dirs: &[&Path], app_data: &Path, id: &str, png: &[u8]) -> Result<(), String> {
    let user_dir = data_home.join("applications");
    for name in DESKTOP_NAMES {
        let user = user_dir.join(name);
        let managed = std::fs::read_to_string(&user).map(|t| t.contains(MARKER)).unwrap_or(false);
        if user.exists() && !managed {
            continue; // somebody's own file: never touched
        }
        if id == DEFAULT {
            if managed {
                std::fs::remove_file(&user).map_err(|e| e.to_string())?;
            }
            continue;
        }
        let Some(source) = system_dirs.iter().map(|d| d.join(name)).find(|p| p.is_file()) else { continue };
        let picture = app_data.join("launcher-icon.png");
        if picture.to_string_lossy().contains('\n') {
            return Err("странный путь".into());
        }
        std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
        std::fs::write(&picture, png).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&user_dir).map_err(|e| e.to_string())?;
        std::fs::write(&user, with_icon(&text, &picture.to_string_lossy())).map_err(|e| e.to_string())?;
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

    /// The list the settings page shows (`ui/js/icons.js`) and the list built in here must be the same, dev-only flags included.
    #[test]
    fn the_settings_page_lists_the_same_icons() {
        let js = include_str!("../../ui/js/icons.js");
        let entries: Vec<&str> = js.split("id: '").skip(1).collect();
        let in_js: Vec<&str> = entries.iter().filter_map(|s| s.split('\'').next()).collect();
        let here: Vec<&str> = ICONS.iter().map(|(n, _)| *n).collect();
        assert_eq!(in_js, here);
        let dev_in_js: Vec<&str> = entries.iter().filter(|s| s.split('}').next().is_some_and(|e| e.contains("dev: true"))).filter_map(|s| s.split('\'').next()).collect();
        assert_eq!(dev_in_js, DEV_ONLY);
    }

    #[test]
    fn a_developer_only_choice_falls_back_while_the_mode_is_off() {
        assert_eq!(effective("spark", false), DEFAULT);
        assert_eq!(effective("spark", true), "spark");
        assert_eq!(effective("dusk", false), "dusk");
    }

    #[test]
    fn the_desktop_entry_gets_the_icon_in_its_main_group_only() {
        let src = "[Desktop Entry]\nName=OpenSchool\nIcon=openschool_desktop\nExec=x\n\n[Desktop Action a]\nIcon=other\n";
        let out = with_icon(src, "/p/i.png");
        assert!(out.contains("Icon=/p/i.png\n") && out.contains("Icon=other\n") && !out.contains("Icon=openschool_desktop"));
        assert_eq!(out.matches(MARKER).count(), 1);
        assert_eq!(with_icon(&out, "/q.png").matches(MARKER).count(), 1, "again: still one marker");
        let none = with_icon("[Desktop Entry]\nName=X\n", "/p/i.png");
        assert!(none.contains("Icon=/p/i.png"), "{none}");
    }

    #[test]
    fn the_launcher_copy_is_made_removed_and_never_replaces_a_file_of_the_user() {
        let root = std::env::temp_dir().join(format!("openschool-icon-test-{}", std::process::id()));
        let (home, sys, data) = (root.join("home"), root.join("sys"), root.join("data"));
        std::fs::create_dir_all(&sys).unwrap();
        std::fs::write(sys.join("openschool.desktop"), "[Desktop Entry]\nName=OpenSchool\nIcon=openschool_desktop\n").unwrap();
        let user = home.join("applications/openschool.desktop");

        sync_launcher_in(&home, &[sys.as_path()], &data, "dusk", b"png").unwrap();
        let text = std::fs::read_to_string(&user).unwrap();
        assert!(text.contains(MARKER) && text.contains("launcher-icon.png") && !text.contains("openschool_desktop"));
        assert_eq!(std::fs::read(data.join("launcher-icon.png")).unwrap(), b"png");

        sync_launcher_in(&home, &[sys.as_path()], &data, DEFAULT, b"png").unwrap();
        assert!(!user.exists(), "the default icon removes our copy");

        std::fs::create_dir_all(user.parent().unwrap()).unwrap();
        std::fs::write(&user, "[Desktop Entry]\nName=mine\nIcon=mine\n").unwrap();
        sync_launcher_in(&home, &[sys.as_path()], &data, "dusk", b"png").unwrap();
        sync_launcher_in(&home, &[sys.as_path()], &data, DEFAULT, b"png").unwrap();
        assert_eq!(std::fs::read_to_string(&user).unwrap(), "[Desktop Entry]\nName=mine\nIcon=mine\n", "a file without our marker is left alone");
        let _ = std::fs::remove_dir_all(&root);
    }
}
