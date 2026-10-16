// Hide the console window on Windows release builds.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod appicon;
mod attach;
mod background;
mod cache;
mod changes;
mod commands;
mod config_file;
mod diag;
mod eyedropper;
mod ics;
mod login;
mod net;
mod news;
mod planner;
mod store;
mod tray;
mod update;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use openschool_bridge::Client;
use tauri::Manager;

/// The bridge client holds the session cookies; it is replaced on logout.
pub struct AppState {
    client: Mutex<Arc<Client>>,
    /// Gosuslugi is reached without any proxy (see `net`). Read when a client is made.
    direct: AtomicBool,
    /// The student of the account that is shown (an account can have several); `None` = the first one.
    selected: Mutex<Option<String>>,
}

impl AppState {
    fn new() -> Self {
        Self { client: Mutex::new(Arc::new(Client::new().expect("http client"))), direct: AtomicBool::new(false), selected: Mutex::new(None) }
    }

    fn make_client(&self) -> Arc<Client> {
        Arc::new(if self.is_direct() { Client::direct() } else { Client::new() }.expect("http client"))
    }

    pub fn selected(&self) -> Option<String> {
        self.selected.lock().expect("selected lock").clone()
    }

    pub fn select(&self, id: Option<String>) {
        *self.selected.lock().expect("selected lock") = id;
    }

    pub fn is_direct(&self) -> bool {
        self.direct.load(Ordering::SeqCst)
    }

    /// Returns whether the way changed (the caller then replaces the client).
    pub fn set_direct(&self, direct: bool) -> bool {
        self.direct.swap(direct, Ordering::SeqCst) != direct
    }

    pub fn client(&self) -> Arc<Client> {
        self.client.lock().expect("client lock").clone()
    }

    pub fn reset_client(&self) {
        *self.client.lock().expect("client lock") = self.make_client();
    }
}

fn main() {
    diag::init();
    // The User-Agent carries the app's version (src-tauri/Cargo.toml), the bridge adds its own; before any client is made.
    openschool_bridge::set_app_version(env!("CARGO_PKG_VERSION").to_string());
    tauri::Builder::default()
        // Must be the first plugin: a second launch (a click on the shortcut while the window sits in the tray) only
        // brings the running instance forward, instead of starting a second background check and a second local server.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // «Запускать при входе в систему»: the system starts the app with --autostart; it then stays in the tray.
        .plugin(tauri_plugin_autostart::Builder::new().arg(tray::AUTOSTART_ARG).app_name("OpenSchool").build())
        .manage(AppState::new())
        .manage(update::Updates::default())
        .manage(planner::Planner::default())
        .manage(tray::NowLine::default())
        .setup(|app| {
            net::init(app.handle())?;
            news::init(app.handle())?;
            // A missing tray (some desktops have none) must not stop the app.
            if let Err(e) = tray::build(app.handle()) {
                eprintln!("tray unavailable: {e}");
            }
            appicon::restore(app.handle());
            update::init(app.handle());
            // The window is created hidden (tauri.conf.json): shown now, unless the system started the app at login and a tray
            // icon exists to bring it back from.
            tray::first_show(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // "Close to tray": only the main window, only when the user asked for it.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && window.app_handle().state::<news::News>().settings().close_to_tray
                && window.app_handle().tray_by_id("main").is_some() // no tray icon: closing must really close, not hide the window for good
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::restore_session,
            commands::login,
            commands::logout,
            commands::forget_session,
            commands::secret_store,
            commands::tray_ready,
            commands::student,
            cache::cache_put,
            cache::cache_get,
            commands::dev_mode,
            diag::ai_debug_mode,
            diag::ai_facts,
            diag::ai_save,
            diag::ai_clean,
            appicon::set_app_icon,
            attach::download_material,
            attach::list_downloads,
            attach::open_download,
            attach::reveal_download,
            attach::delete_download,
            attach::open_downloads_folder,
            planner::planner_done,
            ics::export_ics,
            tray::set_now,
            tray::autostart_get,
            tray::autostart_set,
            update::update_info,
            update::set_update_auto,
            update::check_update,
            update::dismiss_update,
            update::install_update,
            update::open_release_page,
            appicon::get_app_icon,
            commands::students,
            commands::select_student,
            commands::session_status,
            commands::class_info,
            commands::week,
            commands::eyedropper_available,
            commands::pick_color,
            background::set_background,
            background::background_path,
            background::clear_background,
            config_file::export_config,
            config_file::import_config,
            net::net_get,
            net::net_set,
            net::net_test,
            news::notify_get,
            news::notify_set,
            news::news_feed,
            news::news_read,
            news::news_clear,
            news::news_check_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenSchool");
}

#[cfg(test)]
mod tests {
    /// The version is written in Cargo.toml only: tauri.conf.json must not carry its own (Tauri then takes Cargo's).
    #[test]
    fn the_version_comes_from_cargo_toml_only() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert!(conf.get("version").is_none(), "tauri.conf.json must not set a version");
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        assert_eq!(context.package_info().version.to_string(), env!("CARGO_PKG_VERSION"));
    }
}
