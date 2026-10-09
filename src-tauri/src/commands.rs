//! Commands the UI calls through `invoke`. All errors reach the UI as plain strings.

use openschool_bridge::{BridgeError, ClassInfo, Student, Week};
use tauri::{AppHandle, State};

use crate::{eyedropper, login, store, AppState};

/// What the UI gets instead of an error text when the server no longer accepts the session (HTTP 401/403).
/// The UI matches this exact string and sends the user to the login screen.
pub const SESSION_EXPIRED: &str = "SESSION_EXPIRED";

/// What the UI gets when Gosuslugi could not be reached at all (no internet, DNS, refused, timeout).
pub const OFFLINE: &str = "OFFLINE";

/// A bridge error as the string the UI receives: two exact markers the UI knows (`SESSION_EXPIRED`, `OFFLINE`),
/// anything else (an HTTP error answer, an unexpected body) as its text, where `HTTP 503` can be recognised.
pub fn err(e: BridgeError) -> String {
    match e {
        BridgeError::Auth(_) => SESSION_EXPIRED.to_string(),
        // The bridge words a server answer "HTTP <code>: ..."; every other network error means the request never got an answer.
        BridgeError::Network(m) if !m.starts_with("HTTP ") => OFFLINE.to_string(),
        other => other.to_string(),
    }
}

/// Try the saved session. `true` means the UI can load data right away.
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>, news: State<'_, crate::news::News>) -> Result<bool, String> {
    // The system secret store talks D-Bus / the Credential Manager and may wait for the user (KWallet asks for its password):
    // never on an async worker.
    let loaded = tauri::async_runtime::spawn_blocking(store::load).await.map_err(|e| e.to_string())?;
    let cookies = match loaded {
        Ok(Some(c)) => c,
        Ok(None) => return Ok(false),
        Err(e) => {
            eprintln!("secret store unavailable: {e}");
            return Ok(false);
        }
    };
    let client = state.client();
    client.set_session(cookies);
    match client.check_session().await {
        Ok(true) => {
            news.logged_in(); // the saved session works: the background check may start
            Ok(true)
        }
        Ok(false) => {
            let _ = tauri::async_runtime::spawn_blocking(store::clear).await;
            state.reset_client(); // the rejected cookies must not stay in memory and mix with the next login
            Ok(false)
        }
        // Offline etc.: keep the saved session for the next start.
        Err(e) => Err(err(e)),
    }
}

/// Open the ESIA login window. `false` means the user closed it.
#[tauri::command]
pub async fn login(app: AppHandle, state: State<'_, AppState>, news: State<'_, crate::news::News>) -> Result<bool, String> {
    state.reset_client(); // every login starts from a clean client, nothing of an older session survives in its cookie jar
    let ok = login::run(&app, state.client()).await?;
    if ok {
        news.logged_in(); // a fresh session: the background check may run again, for whoever just logged in
    }
    Ok(ok)
}

/// Whether the tray icon exists. Without it "close to tray" would hide the window with no way back, so the UI says so.
#[tauri::command]
pub fn tray_ready(app: AppHandle) -> bool {
    app.tray_by_id("main").is_some()
}

/// State of the system secret store, so the UI can say why a login is not remembered.
#[derive(serde::Serialize)]
pub struct SecretStore {
    /// The store answered (an empty answer counts): KWallet / GNOME Keyring / Credential Manager is there.
    available: bool,
    /// A saved session can be read back right now.
    has_session: bool,
}

#[tauri::command]
pub async fn secret_store() -> SecretStore {
    tauri::async_runtime::spawn_blocking(|| match store::load() {
        Ok(found) => SecretStore { available: true, has_session: found.is_some() },
        Err(e) => {
            eprintln!("secret store unavailable: {e}");
            SecretStore { available: false, has_session: false }
        }
    })
    .await
    .unwrap_or(SecretStore { available: false, has_session: false })
}

/// The UI saw the session expire: drop the dead cookies so the next start does not try them again.
/// Unlike logout this keeps the "what's new" feed, which belongs to the account and is checked when the next login happens.
#[tauri::command]
pub async fn forget_session(state: State<'_, AppState>, news: State<'_, crate::news::News>) -> Result<(), String> {
    news.deactivate(); // otherwise the background check would meet the same 401 and announce the expiry a second time
    let _ = tauri::async_runtime::spawn_blocking(store::clear).await;
    state.reset_client();
    Ok(())
}

#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, AppState>, news: State<'_, crate::news::News>) -> Result<(), String> {
    let _ = tauri::async_runtime::spawn_blocking(store::clear).await;
    // Logging out of the app must also log out of Gosuslugi in the login window, or the next "Войти" signs the same
    // account straight back in and another student can never be chosen.
    login::forget_profile(&app);
    news.reset();
    state.reset_client();
    Ok(())
}

#[tauri::command]
pub async fn student(state: State<'_, AppState>) -> Result<Student, String> {
    let students = state.client().students().await.map_err(err)?;
    students.into_iter().next().ok_or_else(|| "К этому аккаунту не привязан ученик. Войдите под аккаунтом ученика.".to_string())
}

#[tauri::command]
pub async fn class_info(
    state: State<'_, AppState>,
    student_id: String,
    year: u32,
) -> Result<Option<ClassInfo>, String> {
    state.client().class_info(student_id, year).await.map_err(err)
}

#[tauri::command]
pub async fn week(
    state: State<'_, AppState>,
    student_id: String,
    year: u32,
    iso_week: u32,
) -> Result<Week, String> {
    state.client().week(student_id, year, iso_week).await.map_err(err)
}

/// Whether the screen eyedropper works here (KDE Plasma only for now).
#[tauri::command]
pub async fn eyedropper_available() -> bool {
    tauri::async_runtime::spawn_blocking(eyedropper::available).await.unwrap_or_else(|e| {
        eprintln!("eyedropper check failed: {e}"); // a panic in the check means "not available", but leave a trace
        false
    })
}

/// Let the user click a pixel on the screen. `None` means they cancelled.
#[tauri::command]
pub async fn pick_color() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(eyedropper::pick).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{err, OFFLINE, SESSION_EXPIRED};
    use openschool_bridge::BridgeError;

    #[test]
    fn only_auth_errors_become_the_expiry_marker() {
        assert_eq!(err(BridgeError::Auth("HTTP 401".into())), SESSION_EXPIRED);
        assert_ne!(err(BridgeError::Network("HTTP 500".into())), SESSION_EXPIRED);
        assert_ne!(err(BridgeError::Parse("bad".into())), SESSION_EXPIRED);
    }

    #[test]
    fn unreachable_servers_and_server_errors_are_told_apart() {
        assert_eq!(err(BridgeError::Network("error sending request for url (https://www.gosuslugi.ru/)".into())), OFFLINE);
        assert_eq!(err(BridgeError::Network("operation timed out".into())), OFFLINE);
        let http = err(BridgeError::Network("HTTP 503 Service Unavailable: maintenance".into()));
        assert_ne!(http, OFFLINE);
        assert!(http.contains("HTTP 503"), "the UI reads the code from this text: {http}");
        assert!(err(BridgeError::Parse("bad json".into())).contains("bad json"));
    }
}
