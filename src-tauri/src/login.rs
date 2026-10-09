//! ESIA login in a second window. The user types the password/2FA there; we only read the
//! resulting cookies once the page is back on the diary and the server accepts them.
//!
//! Windows needs window and cookie calls to run from an async command, which is the case here.

use std::sync::Arc;
use std::time::{Duration, Instant};

use openschool_bridge::{login_url, Client, SessionCookie};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::store;

const LABEL: &str = "login";
const POLL: Duration = Duration::from_secs(1);
/// The server is asked whether the session works at most this often, and the window is given up after this many "no" answers:
/// a server that keeps refusing (a firewall, a changed rule) must not be asked every second for as long as the window stays open.
const CHECK_EVERY: Duration = Duration::from_secs(4);
const MAX_REFUSALS: u32 = 15;
/// The login window keeps its own cookies in this folder (not in the main window's store, so clearing it never touches the app's
/// settings). It is wiped on logout.
const PROFILE_DIR: &str = "login-webview";
/// If the window stays on the diary this long without visiting ESIA, assume it is already
/// logged in (the webview keeps its own cookies between runs).
const ALREADY_LOGGED_IN_AFTER: Duration = Duration::from_secs(8);

fn profile_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(PROFILE_DIR))
}

/// Forget what the login window remembers about Gosuslugi/ESIA (best effort).
pub fn forget_profile(app: &AppHandle) {
    if let Some(dir) = profile_dir(app)
        && dir.exists()
        && let Err(e) = std::fs::remove_dir_all(&dir)
    {
        eprintln!("could not clear the login window profile: {e}");
    }
}

pub async fn run(app: &AppHandle, client: Arc<Client>) -> Result<bool, String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_focus();
        return Ok(false);
    }
    let start_url: Url = login_url().parse().map_err(|e| format!("bad login url: {e}"))?;
    // A remote page never gets our commands (Tauri rejects invoke from a non-local origin without an explicit `remote` capability,
    // and ours is for the "main" window only), so the login window is only a browser.
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(start_url.clone()))
        .title("OpenSchool: вход через Госуслуги")
        .inner_size(480.0, 760.0);
    if let Some(dir) = profile_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }
    builder.build().map_err(|e| e.to_string())?;

    let started = Instant::now();
    let mut last_check: Option<Instant> = None;
    let mut refusals = 0u32;
    let mut seen_login_page = false;
    loop {
        tokio::time::sleep(POLL).await;
        // The user closed the window: cancelled.
        let Some(window) = app.get_webview_window(LABEL) else { return Ok(false) };
        let Ok(url) = window.url() else { continue };

        if url.host_str() != Some("www.gosuslugi.ru") {
            seen_login_page = true; // ESIA or another auth host
            continue;
        }
        if !url.path().starts_with("/school") || !(seen_login_page || started.elapsed() > ALREADY_LOGGED_IN_AFTER) {
            continue;
        }
        let Ok(cookies) = window.cookies_for_url(start_url.clone()) else { continue };
        let cookies: Vec<SessionCookie> = cookies
            .iter()
            .map(|c| SessionCookie { name: c.name().to_string(), value: c.value().to_string() })
            .collect();
        if cookies.is_empty() {
            continue;
        }
        // Reaching the diary does not mean every cookie is set yet: let the server decide (but not every second).
        if last_check.is_some_and(|t| t.elapsed() < CHECK_EVERY) {
            continue;
        }
        last_check = Some(Instant::now());
        client.set_session(cookies.clone());
        if matches!(client.check_session().await, Ok(true)) {
            let to_save = cookies.clone();
            match tauri::async_runtime::spawn_blocking(move || store::save(&to_save)).await {
                Ok(Err(e)) => eprintln!("could not save session: {e}"),
                Err(e) => eprintln!("could not save session: {e}"),
                Ok(Ok(())) => {}
            }
            let _ = window.close();
            return Ok(true);
        }
        refusals += 1;
        if refusals >= MAX_REFUSALS {
            let _ = window.close();
            return Err("Госуслуги не принимают вход: сервер отклоняет сессию. Попробуйте позже или сообщите об ошибке.".into());
        }
    }
}
