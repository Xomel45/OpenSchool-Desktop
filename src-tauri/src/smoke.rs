//! `--login-smoke`: does the real login window still reach the ESIA form? It opens the same window as «Войти через Госуслуги»
//! (same tauri.conf.json, same proxy-or-direct choice), hidden and with a throw-away profile, waits until the page is on
//! esia.gosuslugi.ru and exits with 0, or with 1 and the last address after `TIMEOUT`. Nothing is logged in or saved, the saved
//! session and the real login profile are not touched. It needs the network as the user has it: Gosuslugi refuses foreign
//! addresses, so it cannot run on CI machines abroad.
//!
//! Catches breakage like an injected script that stops the Gosuslugi page (`freezePrototype` once left it on its loading logo).

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::{login, net, AppState};

pub const ARG: &str = "--login-smoke";
const TIMEOUT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(500);
const ESIA_HOST: &str = "esia.gosuslugi.ru";

/// Reached the ESIA login: the diary page ran its scripts and sent the window on.
fn reached_esia(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(ESIA_HOST)
}

pub fn run() -> ! {
    let profile = std::env::temp_dir().join(format!("openschool-login-smoke-{}", std::process::id()));
    let for_setup = profile.clone();
    // Only the login window: the main window would load the app's page into the same web storage as a running OpenSchool.
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(move |app| {
            net::init(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let code = match check(&handle, for_setup).await {
                    Ok(msg) => {
                        println!("login smoke: OK, {msg}");
                        0
                    }
                    Err(msg) => {
                        eprintln!("login smoke: FAILED, {msg}");
                        1
                    }
                };
                handle.exit(code);
            });
            Ok(())
        })
        .build(context)
        .expect("error while starting the login smoke test")
        .run(move |_, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = std::fs::remove_dir_all(&profile);
            }
        });
    // `run` only returns if the event loop ended without our exit code (it never should).
    std::process::exit(1)
}

async fn check(app: &AppHandle, profile: std::path::PathBuf) -> Result<String, String> {
    let state = app.state::<AppState>();
    let net = app.state::<net::Net>();
    let status = net::resolve(&net, &state).await;
    let way = if status.direct { "напрямую" } else { "через системный маршрут" };
    let window = login::open_window(app, status.direct, Some(profile), false)?;
    let started = Instant::now();
    let mut last = String::new();
    while started.elapsed() < TIMEOUT {
        tokio::time::sleep(POLL).await;
        let Ok(url) = window.url() else { continue };
        // The window is left open: closing the last window would end the app with code 0 before `exit` gives ours.
        if reached_esia(&url) {
            return Ok(format!("{ESIA_HOST} за {:.1} с ({way})", started.elapsed().as_secs_f32()));
        }
        last = format!("{}://{}{}", url.scheme(), url.host_str().unwrap_or(""), url.path()); // no query: it carries one-time tokens
    }
    Err(format!("за {} с окно не дошло до {ESIA_HOST} ({way}); последняя страница: {last}", TIMEOUT.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_esia_host_over_https_counts() {
        let u = |s: &str| s.parse::<tauri::Url>().unwrap();
        assert!(reached_esia(&u("https://esia.gosuslugi.ru/login/")));
        assert!(!reached_esia(&u("https://www.gosuslugi.ru/school/feed")), "still on the diary: the page has not run");
        assert!(!reached_esia(&u("http://esia.gosuslugi.ru/login/")));
        assert!(!reached_esia(&u("https://esia.gosuslugi.ru.evil.example/login")));
        assert!(!reached_esia(&u("about:blank")));
    }
}
