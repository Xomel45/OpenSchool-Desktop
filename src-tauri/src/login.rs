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
/// If the window stays on the diary this long without visiting ESIA, assume it is already
/// logged in (the webview keeps its own cookies between runs).
const ALREADY_LOGGED_IN_AFTER: Duration = Duration::from_secs(8);

pub async fn run(app: &AppHandle, client: Arc<Client>) -> Result<bool, String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_focus();
        return Ok(false);
    }
    let start_url: Url = login_url().parse().map_err(|e| format!("bad login url: {e}"))?;
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(start_url.clone()))
        .title("OpenSchool: вход через Госуслуги")
        .inner_size(480.0, 760.0)
        .build()
        .map_err(|e| e.to_string())?;

    let started = Instant::now();
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
        // Reaching the diary does not mean every cookie is set yet: let the server decide.
        client.set_session(cookies.clone());
        if matches!(client.check_session().await, Ok(true)) {
            if let Err(e) = store::save(&cookies) {
                eprintln!("could not save session: {e}");
            }
            let _ = window.close();
            return Ok(true);
        }
    }
}
