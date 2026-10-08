// Hide the console window on Windows release builds.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod background;
mod commands;
mod config_file;
mod eyedropper;
mod login;
mod store;

use std::sync::{Arc, Mutex};

use openschool_bridge::Client;

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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::restore_session,
            commands::login,
            commands::logout,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenSchool");
}
