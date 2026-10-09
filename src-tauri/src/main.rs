// Hide the console window on Windows release builds.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod background;
mod commands;
mod config_file;
mod eyedropper;
mod login;
mod news;
mod store;
mod tray;

use std::sync::{Arc, Mutex};

use openschool_bridge::Client;
use tauri::Manager;

/// The bridge client holds the session cookies; it is replaced on logout.
pub struct AppState {
    client: Mutex<Arc<Client>>,
}

impl AppState {
    fn new() -> Self {
        Self { client: Mutex::new(Arc::new(Client::new().expect("http client"))) }
    }

    pub fn client(&self) -> Arc<Client> {
        self.client.lock().expect("client lock").clone()
    }

    pub fn reset_client(&self) {
        *self.client.lock().expect("client lock") = Arc::new(Client::new().expect("http client"));
    }
}

fn main() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch (a click on the shortcut while the window sits in the tray) only
        // brings the running instance forward, instead of starting a second background check and a second local server.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .setup(|app| {
            news::init(app.handle())?;
            // A missing tray (some desktops have none) must not stop the app.
            if let Err(e) = tray::build(app.handle()) {
                eprintln!("tray unavailable: {e}");
            }
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
            commands::class_info,
            commands::week,
            commands::eyedropper_available,
            commands::pick_color,
            background::set_background,
            background::background_path,
            background::clear_background,
            config_file::export_config,
            config_file::import_config,
            news::notify_get,
            news::notify_set,
            news::news_feed,
            news::news_read,
            news::news_check_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenSchool");
}
