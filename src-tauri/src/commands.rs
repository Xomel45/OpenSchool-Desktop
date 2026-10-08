//! Commands the UI calls through `invoke`. All errors reach the UI as plain strings.

use openschool_bridge::{ClassInfo, Student, Week};
use tauri::{AppHandle, State};

use crate::{eyedropper, login, store, AppState};

/// Try the saved session. `true` means the UI can load data right away.
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>) -> Result<bool, String> {
    let cookies = match store::load() {
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
        Ok(true) => Ok(true),
        Ok(false) => {
            store::clear();
            Ok(false)
        }
        // Offline etc.: keep the saved session for the next start.
        Err(e) => Err(e.to_string()),
    }
}

/// Open the ESIA login window. `false` means the user closed it.
#[tauri::command]
pub async fn login(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    login::run(&app, state.client()).await
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>, news: State<'_, crate::news::News>) -> Result<(), String> {
    store::clear();
    news.reset();
    state.reset_client();
    Ok(())
}

#[tauri::command]
pub async fn student(state: State<'_, AppState>) -> Result<Student, String> {
    let students = state.client().students().await.map_err(|e| e.to_string())?;
    students.into_iter().next().ok_or_else(|| "no student is linked to this account".to_string())
}

#[tauri::command]
pub async fn class_info(
    state: State<'_, AppState>,
    student_id: String,
    year: u32,
) -> Result<Option<ClassInfo>, String> {
    state.client().class_info(student_id, year).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn week(
    state: State<'_, AppState>,
    student_id: String,
    year: u32,
    iso_week: u32,
) -> Result<Week, String> {
    state.client().week(student_id, year, iso_week).await.map_err(|e| e.to_string())
}

/// Whether the screen eyedropper works here (KDE Plasma only for now).
#[tauri::command]
pub async fn eyedropper_available() -> bool {
    tauri::async_runtime::spawn_blocking(eyedropper::available).await.unwrap_or(false)
}

/// Let the user click a pixel on the screen. `None` means they cancelled.
#[tauri::command]
pub async fn pick_color() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(eyedropper::pick).await.map_err(|e| e.to_string())?
}
