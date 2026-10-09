//! Which way Gosuslugi is reached: through the system proxy or straight. Gosuslugi refuses foreign addresses, so a proxy
//! abroad breaks both the login and every request. "Auto" asks a public service which country the traffic leaves from:
//! a foreign one always means "go direct". If the country cannot be found out, it asks Gosuslugi itself both ways.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use openschool_bridge::{BridgeError, Client};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::news::{read_json, write_json};
use crate::AppState;

/// A probe that takes longer is counted as a failure (a proxy that swallows the connection would otherwise hold the start for 30 s).
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// All geo services together; each one is also limited by the client's own timeouts.
const GEO_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Go direct whenever the system route leaves from a foreign country; otherwise use the system route.
    #[default]
    Auto,
    /// Never use a proxy for Gosuslugi.
    Direct,
    /// Always do what the system says.
    System,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    mode: Mode,
}

/// What the UI shows: the chosen mode, the way in use, and whether the server answered that way at the last check.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct Status {
    pub mode: Mode,
    pub direct: bool,
    /// `None`: not checked yet.
    pub reachable: Option<bool>,
    /// Country (two letters) the system route leaves from, when it was found out.
    pub country: Option<String>,
}

pub struct Net {
    dir: PathBuf,
    state: Mutex<Status>,
}

impl Net {
    pub fn new(dir: PathBuf) -> Self {
        let saved: Saved = read_json(&dir.join("network.json"));
        Self { dir, state: Mutex::new(Status { mode: saved.mode, direct: saved.mode == Mode::Direct, reachable: None, country: None }) }
    }

    pub fn status(&self) -> Status {
        self.state.lock().expect("net lock").clone()
    }

    fn update(&self, f: impl FnOnce(&mut Status)) -> Status {
        let mut s = self.state.lock().expect("net lock");
        f(&mut s);
        s.clone()
    }
}

/// A server answer that shows the way works: anything but a refusal of the address (403) or a broken gateway (5xx).
/// 401 is the normal answer to a request without a session.
fn usable(r: &Result<u16, BridgeError>) -> bool {
    matches!(r, Ok(s) if *s != 403 && *s < 500)
}

/// Decide the way. A known country decides alone: Russia keeps the system route, anywhere else goes direct, always.
/// Without a country the probes decide: the system way wins whenever it works; going direct needs proof that it works.
fn choose_direct(country: Option<&str>, system_ok: bool, direct_ok: bool) -> bool {
    match country {
        Some(c) => !c.eq_ignore_ascii_case("RU"),
        None => !system_ok && direct_ok,
    }
}

async fn country(client: Result<Client, BridgeError>) -> Option<String> {
    let client = client.ok()?;
    tokio::time::timeout(GEO_TIMEOUT, client.exit_country()).await.ok()?.ok()
}

async fn probe(client: Result<Client, BridgeError>) -> Result<u16, BridgeError> {
    let client = client?;
    tokio::time::timeout(PROBE_TIMEOUT, client.probe()).await.unwrap_or_else(|_| Err(BridgeError::Network("timeout".into())))
}

/// Settle which way to use for the current mode, store it in `AppState` (a changed way gets a fresh client) and report.
/// Call it before a session is installed in the client (start, login); `net_set` reinstalls the session itself.
pub async fn resolve(net: &Net, app_state: &AppState) -> Status {
    let mode = net.status().mode;
    let (direct, reachable, country) = match mode {
        Mode::System => (false, None, None),
        Mode::Direct => (true, None, None),
        Mode::Auto => {
            // The country is asked through the system route (the one that may be a foreign proxy); the probes only matter without it.
            let code = tauri::async_runtime::spawn(country(Client::new())).await.ok().flatten();
            if code.is_some() {
                let direct = choose_direct(code.as_deref(), true, true);
                (direct, None, code)
            } else {
                let sys = tauri::async_runtime::spawn(probe(Client::new()));
                let dir = tauri::async_runtime::spawn(probe(Client::direct()));
                let sys = sys.await.map(|r| usable(&r)).unwrap_or(false);
                let dir = dir.await.map(|r| usable(&r)).unwrap_or(false);
                (choose_direct(None, sys, dir), Some(sys || dir), None)
            }
        }
    };
    if app_state.set_direct(direct) {
        app_state.reset_client();
    }
    net.update(|s| {
        s.direct = direct;
        s.reachable = reachable.or(s.reachable);
        s.country = country;
    })
}

#[tauri::command]
pub fn net_get(net: State<'_, Net>) -> Status {
    net.status()
}

/// Change the mode, apply it at once and keep a logged-in session working on the new client.
#[tauri::command]
pub async fn net_set(net: State<'_, Net>, state: State<'_, AppState>, mode: Mode) -> Result<Status, String> {
    net.update(|s| s.mode = mode);
    write_json(&net.dir.join("network.json"), &Saved { mode });
    reapply(&net, &state).await
}

/// Check the connection again (after the user switched a proxy on or off).
#[tauri::command]
pub async fn net_test(net: State<'_, Net>, state: State<'_, AppState>) -> Result<Status, String> {
    reapply(&net, &state).await
}

async fn reapply(net: &Net, state: &AppState) -> Result<Status, String> {
    let before = state.is_direct();
    let status = resolve(net, state).await;
    if state.is_direct() != before {
        // A new client has an empty cookie jar: put the saved session back.
        if let Ok(Ok(Some(cookies))) = tauri::async_runtime::spawn_blocking(crate::store::load).await {
            state.client().set_session(cookies);
        }
    }
    Ok(status)
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let net = Net::new(app.path().app_data_dir()?);
    app.state::<AppState>().set_direct(net.status().direct);
    app.state::<AppState>().reset_client();
    app.manage(net);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("openschool-net-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn only_a_real_answer_counts_as_a_working_way() {
        assert!(usable(&Ok(401)) && usable(&Ok(200)) && usable(&Ok(404)));
        assert!(!usable(&Ok(403)), "the address is refused");
        assert!(!usable(&Ok(502)) && !usable(&Ok(503)));
        assert!(!usable(&Err(BridgeError::Network("refused".into()))));
    }

    #[test]
    fn a_foreign_country_always_means_direct() {
        for c in ["DE", "KZ", "us", "NL"] {
            assert!(choose_direct(Some(c), true, false), "{c}: even when Gosuslugi answers through the proxy");
            assert!(choose_direct(Some(c), true, true));
        }
        assert!(!choose_direct(Some("RU"), false, true), "Russia keeps the system route");
        assert!(!choose_direct(Some("ru"), true, true));
    }

    #[test]
    fn without_a_country_direct_is_chosen_only_when_the_system_way_fails_and_direct_works() {
        assert!(!choose_direct(None, true, true), "a working system way is kept");
        assert!(!choose_direct(None, true, false));
        assert!(choose_direct(None, false, true), "the proxy fails, direct works");
        assert!(!choose_direct(None, false, false), "offline: nothing to gain, stay on the system way");
    }

    #[test]
    fn the_mode_survives_a_restart_and_junk_falls_back_to_auto() {
        let d = dir("mode");
        assert_eq!(Net::new(d.clone()).status().mode, Mode::Auto);
        write_json(&d.join("network.json"), &Saved { mode: Mode::Direct });
        let n = Net::new(d.clone());
        assert_eq!((n.status().mode, n.status().direct), (Mode::Direct, true));
        std::fs::write(d.join("network.json"), r#"{"mode":"sideways"}"#).unwrap();
        assert_eq!(Net::new(d).status().mode, Mode::Auto);
    }
}
