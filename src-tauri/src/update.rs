//! Updates of the app itself (tauri-plugin-updater). The manifest `latest.json` of the newest published GitHub release says the
//! version and, per platform, the file and its signature; nothing is installed unless the signature matches the public key in
//! tauri.conf.json (`plugins.updater.pubkey`).
//!
//! Only the AppImage and the Windows installers (nsis, msi) update themselves. Builds made by a package manager (AUR, Nix) or a
//! .deb/.rpm are updated by that package manager: there the app only says that a new version exists and links to the release page.
//!
//! «Автообновление» (on by default) = check at start and every 6 hours and offer the update in a window; nothing is installed
//! without a click. Turning it off needs the user to accept that the developer is not responsible for problems of an old version.
//! «Не сейчас» only hides the window: the same version is not offered again until the next start.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

/// Where a version can be read and downloaded by hand.
pub const RELEASES_PAGE: &str = "https://github.com/Xomel45/OpenSchool-Desktop/releases/latest";
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Settings {
    auto: bool,
    /// When the user ticked "the developer is not responsible" and turned the automatic check off (Unix seconds).
    #[serde(default)]
    declined_at: Option<u64>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto: true, declined_at: None }
    }
}

#[derive(Default)]
pub struct Updates {
    settings: Mutex<Option<Settings>>,
    /// The update found by the last check (what «Обновить» installs).
    found: tauri::async_runtime::Mutex<Option<tauri_plugin_updater::Update>>,
    /// Versions the user closed with «Не сейчас» in this run of the app.
    dismissed: Mutex<Vec<String>>,
    installing: std::sync::atomic::AtomicBool,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("update.json"))
}

fn read_settings(file: &Path) -> Settings {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_settings(file: &Path, s: &Settings) -> std::io::Result<()> {
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(file, serde_json::to_vec(s).map_err(std::io::Error::other)?)
}

impl Updates {
    fn settings(&self, app: &AppHandle) -> Settings {
        let mut s = self.settings.lock().unwrap_or_else(|p| p.into_inner());
        s.get_or_insert_with(|| settings_file(app).map(|f| read_settings(&f)).unwrap_or_default()).clone()
    }
}

/// The change of the automatic check: turning it off is refused unless the responsibility note was accepted.
fn change(mut s: Settings, auto: bool, accepted: bool, now: u64) -> Result<Settings, String> {
    if !auto && !accepted {
        return Err("Чтобы отключить автообновление, отметьте, что понимаете риск.".into());
    }
    s.auto = auto;
    s.declined_at = if auto { None } else { Some(now) };
    Ok(s)
}

/// How this copy was installed, from the mark `cargo tauri build` leaves in the program (none for `cargo build`: AUR, Nix, dev).
fn kind() -> &'static str {
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Nsis) => "nsis",
        Some(BundleType::Msi) => "msi",
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        _ => "other",
    }
}

/// Whether the app may replace itself. The AppImage only when it really runs as one (`$APPIMAGE` is set by its runtime).
/// A debug build (`cargo run`) never replaces itself.
fn self_updating(kind: &str, appimage_env: bool, release: bool) -> bool {
    release && (matches!(kind, "nsis" | "msi") || (kind == "appimage" && appimage_env))
}

fn can_install() -> bool {
    self_updating(kind(), std::env::var_os("APPIMAGE").is_some(), !cfg!(debug_assertions))
}

/// A public key is put into tauri.conf.json when the signing key is made; without it no update can be checked or installed.
fn configured(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty())
}

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    version: String,
    current: String,
    notes: String,
    date: String,
    can_install: bool,
}

fn describe(u: &tauri_plugin_updater::Update) -> Found {
    let notes: String = u.body.clone().unwrap_or_default().chars().take(4000).collect();
    let date = u.date.map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())).unwrap_or_default();
    Found { version: u.version.clone(), current: u.current_version.clone(), notes, date, can_install: can_install() }
}

async fn check_now(app: &AppHandle) -> Result<Option<Found>, String> {
    if !configured(app) {
        return Err("В этой сборке обновления не настроены (нет ключа подписи).".into());
    }
    let updater = app.updater_builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| format!("Не удалось проверить обновления: {e}"))?;
    let found = update.as_ref().map(describe);
    *app.state::<Updates>().found.lock().await = update;
    Ok(found)
}

/// The background check: offers a new version through the `update-available` event.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let st = app.state::<Updates>();
            if st.settings(&app).auto && configured(&app) && !st.installing.load(std::sync::atomic::Ordering::SeqCst) {
                match check_now(&app).await {
                    Ok(Some(f)) if !st.dismissed.lock().unwrap_or_else(|p| p.into_inner()).contains(&f.version) => {
                        let _ = app.emit("update-available", f);
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("update check: {e}"),
                }
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[derive(Serialize)]
pub struct Info {
    auto: bool,
    configured: bool,
    current: String,
    kind: &'static str,
    can_install: bool,
    page: &'static str,
}

#[tauri::command]
pub fn update_info(app: AppHandle, st: State<'_, Updates>) -> Info {
    Info { auto: st.settings(&app).auto, configured: configured(&app), current: app.package_info().version.to_string(), kind: kind(), can_install: can_install(), page: RELEASES_PAGE }
}

#[tauri::command]
pub fn set_update_auto(app: AppHandle, st: State<'_, Updates>, auto: bool, accepted: bool) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let new = change(st.settings(&app), auto, accepted, now)?;
    if let Some(f) = settings_file(&app) {
        write_settings(&f, &new).map_err(|e| format!("Не удалось сохранить: {e}"))?;
    }
    *st.settings.lock().unwrap_or_else(|p| p.into_inner()) = Some(new);
    Ok(())
}

/// «Проверить сейчас»: works with the automatic check off too.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Found>, String> {
    check_now(&app).await
}

/// «Не сейчас»: the window is hidden, this version is not offered again until the next start.
#[tauri::command]
pub fn dismiss_update(st: State<'_, Updates>, version: String) {
    let mut d = st.dismissed.lock().unwrap_or_else(|p| p.into_inner());
    if !d.contains(&version) {
        d.push(version);
    }
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Download, check the signature, install, start the new version. On Windows the installer closes the app by itself.
#[tauri::command]
pub async fn install_update(app: AppHandle, st: State<'_, Updates>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if !can_install() {
        return Err("Эта копия обновляется через менеджер пакетов или вручную.".into());
    }
    if st.installing.swap(true, Ordering::SeqCst) {
        return Err("Обновление уже устанавливается.".into());
    }
    let result = async {
        let guard = st.found.lock().await;
        let update = guard.as_ref().ok_or("Сначала проверьте обновления.")?;
        let mut done = 0u64;
        let a = app.clone();
        update
            .download_and_install(
                move |chunk, total| {
                    done += chunk as u64;
                    let _ = a.emit("update-progress", Progress { done, total });
                },
                || {},
            )
            .await
            .map_err(|e| format!("Не удалось установить обновление: {e}"))
    }
    .await;
    st.installing.store(false, Ordering::SeqCst);
    result?;
    app.restart();
}

#[tauri::command]
pub fn open_release_page() -> Result<(), String> {
    if crate::attach::open_path(Path::new(RELEASES_PAGE)) { Ok(()) } else { Err("Не удалось открыть браузер.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turning_off_needs_the_note_accepted_and_on_needs_nothing() {
        let on = Settings::default();
        assert!(on.auto, "on by default");
        assert!(change(on.clone(), false, false, 5).is_err());
        let off = change(on, false, true, 5).unwrap();
        assert_eq!(off, Settings { auto: false, declined_at: Some(5) });
        assert_eq!(change(off, true, false, 9).unwrap(), Settings::default());
    }

    #[test]
    fn settings_survive_a_restart_and_a_broken_file_means_defaults() {
        let d = std::env::temp_dir().join(format!("openschool-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let f = d.join("update.json");
        assert_eq!(read_settings(&f), Settings::default(), "no file: on");
        let off = Settings { auto: false, declined_at: Some(7) };
        write_settings(&f, &off).unwrap();
        assert_eq!(read_settings(&f), off);
        std::fs::write(&f, b"{oops").unwrap();
        assert_eq!(read_settings(&f), Settings::default());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn only_appimage_and_windows_installers_replace_themselves() {
        assert!(self_updating("nsis", false, true));
        assert!(self_updating("msi", false, true));
        assert!(self_updating("appimage", true, true));
        assert!(!self_updating("appimage", false, true), "an extracted AppImage is not one");
        assert!(!self_updating("nsis", false, false), "a debug build never replaces itself");
        for k in ["deb", "rpm", "other"] {
            assert!(!self_updating(k, true, true), "{k} is updated by its package manager");
        }
    }
}
