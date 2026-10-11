//! `--ai-debug` (or `-ad`): the app can produce a report about itself that is safe to paste to an AI.
//!
//! The report is built by whitelist: it states facts (versions, settings, counts, kinds of outcomes, timings) and never copies data
//! (no names, ids, subjects, texts, addresses, cookies, marks). Without the flag nothing is recorded and the commands refuse.
//! Texts that come from outside (error messages) go through [`scrub`] first, and the whole report once more at the end.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use openschool_bridge::BridgeError;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

static ON: AtomicBool = AtomicBool::new(false);
static STARTED: OnceLock<Instant> = OnceLock::new();
static EVENTS: Mutex<VecDeque<Entry>> = Mutex::new(VecDeque::new());
/// The newest events kept.
const KEEP: usize = 200;

struct Entry {
    at: Instant,
    what: &'static str,
    outcome: String,
    ms: u64,
}

/// Read the flag (called once, first thing in `main`).
pub fn init() {
    STARTED.get_or_init(Instant::now);
    ON.store(std::env::args().skip(1).any(|a| a == "--ai-debug" || a == "-ad"), Ordering::SeqCst);
}

pub fn enabled() -> bool {
    ON.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn ai_debug_mode() -> bool {
    enabled()
}

fn push(what: &'static str, outcome: String, ms: u64) {
    if !enabled() {
        return;
    }
    let mut events = EVENTS.lock().unwrap_or_else(|p| p.into_inner());
    if events.len() >= KEEP {
        events.pop_front();
    }
    events.push_back(Entry { at: Instant::now(), what, outcome, ms });
}

/// A step without a request (a login, for example).
pub fn note(what: &'static str, outcome: &str) {
    push(what, scrub(outcome, 80), 0);
}

/// Run a request of the bridge and remember how it ended and how long it took (nothing else about it).
pub async fn timed<T, F: Future<Output = Result<T, BridgeError>>>(what: &'static str, f: F) -> Result<T, BridgeError> {
    let started = Instant::now();
    let result = f.await;
    if enabled() {
        let outcome = match &result {
            Ok(_) => "ok".to_string(),
            Err(e) => classify(e),
        };
        push(what, outcome, started.elapsed().as_millis() as u64);
    }
    result
}

/// What kind of failure it was, without the details a message may carry.
fn classify(e: &BridgeError) -> String {
    match e {
        BridgeError::Auth(_) => "auth (401/403)".into(),
        BridgeError::Network(m) => match m.strip_prefix("HTTP ") {
            Some(rest) => format!("http_{}", rest.chars().take(3).filter(char::is_ascii_digit).collect::<String>()),
            None => "network: unreachable".into(),
        },
        // a decoding message names the field that was wrong, which helps; its values do not
        BridgeError::Parse(m) => format!("parse: {}", scrub(m, 160)),
    }
}

/// Make a text from outside fit for a report: quoted values, addresses, mail addresses, long numbers, token-like words and the
/// home folder are replaced by markers; the rest stays (it is usually a field name or a reason), cut to `max` characters.
pub fn scrub(text: &str, max: usize) -> String {
    let mut s = text.to_string();
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(h) = std::env::var(var)
            && h.len() > 3
        {
            s = s.replace(&h, "~");
        }
    }
    for var in ["USER", "USERNAME"] {
        if let Ok(u) = std::env::var(var)
            && u.len() >= 3
        {
            s = s.replace(&u, "<user>");
        }
    }
    // text inside double quotes is a value
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        if c == '"' {
            if !inside {
                out.push_str("\"…\"");
            }
            inside = !inside;
        } else if !inside {
            out.push(c);
        }
    }
    let words: Vec<String> = out.split(' ').map(scrub_word).collect();
    let joined = words.join(" ");
    joined.chars().take(max).collect()
}

fn scrub_word(w: &str) -> String {
    let core = w.trim_matches(|c: char| !c.is_alphanumeric());
    if core.starts_with("http://") || core.starts_with("https://") || core.contains("://") {
        return "<url>".into();
    }
    if core.contains('@') && core.contains('.') {
        return "<email>".into();
    }
    if is_token(core) {
        return "<token>".into();
    }
    // a run of five or more digits (a phone number, an id) -> <n>
    let mut res = String::new();
    let mut run = String::new();
    for c in w.chars().chain(std::iter::once('\0')) {
        if c.is_ascii_digit() {
            run.push(c);
        } else {
            if run.len() >= 5 { res.push_str("<n>") } else { res.push_str(&run) }
            run.clear();
            if c != '\0' {
                res.push(c);
            }
        }
    }
    res
}

/// Long, mixed letters and digits (hex ids, uuids, cookies, base64) or very long without spaces.
fn is_token(w: &str) -> bool {
    let ok = |c: char| c.is_ascii_alphanumeric() || "_-+/=.".contains(c);
    w.chars().count() >= 20 && w.chars().all(ok) && ((w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(|c| c.is_ascii_alphabetic())) || w.chars().count() >= 32)
}

/// The last pass over the finished report: every line goes through the word rules (lines made of the report's own markup stay).
fn scrub_report(text: &str) -> String {
    text.lines().map(|l| l.split(' ').map(scrub_word).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join("\n")
}

#[derive(Serialize)]
pub struct EventOut {
    seconds_ago: u64,
    what: &'static str,
    outcome: String,
    ms: u64,
}

#[derive(Serialize)]
pub struct SecretOut {
    available: bool,
    has_session: bool,
}

/// What only the program knows. The page adds what it knows (settings, shapes of data) and writes the text.
#[derive(Serialize)]
pub struct Facts {
    version: &'static str,
    tauri: &'static str,
    build: &'static str,
    os: &'static str,
    arch: &'static str,
    desktop: Option<String>,
    session_type: Option<String>,
    webview: Option<String>,
    language: Option<String>,
    tray: bool,
    dev_flag: bool,
    uptime_s: u64,
    net: crate::net::Status,
    notify: crate::news::Settings,
    secret_store: SecretOut,
    cache_minutes: Vec<u64>,
    events: Vec<EventOut>,
}

#[tauri::command]
pub async fn ai_facts(app: AppHandle, net: State<'_, crate::net::Net>, news: State<'_, crate::news::News>) -> Result<Facts, String> {
    if !enabled() {
        return Err("start the program with --ai-debug".into());
    }
    let secret = tauri::async_runtime::spawn_blocking(|| match crate::store::load() {
        Ok(found) => SecretOut { available: true, has_session: found.is_some() },
        Err(_) => SecretOut { available: false, has_session: false },
    })
    .await
    .unwrap_or(SecretOut { available: false, has_session: false });
    let now = Instant::now();
    let events = EVENTS.lock().unwrap_or_else(|p| p.into_inner()).iter().map(|e| EventOut { seconds_ago: now.duration_since(e.at).as_secs(), what: e.what, outcome: e.outcome.clone(), ms: e.ms }).collect();
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Ok(Facts {
        version: env!("CARGO_PKG_VERSION"),
        tauri: tauri::VERSION,
        build: if cfg!(debug_assertions) { "debug" } else { "release" },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        desktop: env("XDG_CURRENT_DESKTOP"),
        session_type: env("XDG_SESSION_TYPE"),
        webview: tauri::webview_version().ok(),
        language: env("LANG").map(|l| l.split('.').next().unwrap_or("").to_string()),
        tray: app.tray_by_id("main").is_some(),
        dev_flag: crate::commands::dev_mode(),
        uptime_s: STARTED.get().map(|s| s.elapsed().as_secs()).unwrap_or(0),
        net: net.status(),
        notify: news.settings(),
        secret_store: secret,
        cache_minutes: crate::cache::ages_minutes(&app),
        events,
    })
}

/// Clean the finished report once more and keep a copy next to the other data of the program. Returns where it is.
#[tauri::command]
pub fn ai_save(app: AppHandle, text: String) -> Result<String, String> {
    if !enabled() {
        return Err("start the program with --ai-debug".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("ai-debug.txt");
    std::fs::write(&file, scrub_report(&text)).map_err(|e| e.to_string())?;
    Ok(scrub(&file.to_string_lossy(), 300))
}

/// The page asks for a last cleaning before it shows or copies the text.
#[tauri::command]
pub fn ai_clean(text: String) -> Result<String, String> {
    if !enabled() {
        return Err("start the program with --ai-debug".into());
    }
    Ok(scrub_report(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_addresses_and_tokens_do_not_survive() {
        let t = scrub(r#"invalid type: string "Иван Петров", expected u32 at https://www.gosuslugi.ru/api/x?id=1 mail a.b@c.ru phone 79001234567 cookie 3f2a9c8e7d6b5a4c3b2a1f0e9d8c7b6a"#, 400);
        for secret in ["Иван", "Петров", "gosuslugi", "a.b@c.ru", "79001234567", "3f2a9c8e"] {
            assert!(!t.contains(secret), "{secret} left in: {t}");
        }
        assert!(t.contains("invalid type") && t.contains("expected u32"), "the reason stays: {t}");
    }

    #[test]
    fn short_numbers_and_field_names_stay_and_the_text_is_cut() {
        assert_eq!(scrub("missing field `due_date` at line 1 column 214", 400), "missing field `due_date` at line 1 column 214");
        assert_eq!(scrub("abcdefghij", 4), "abcd");
    }

    #[test]
    fn the_home_folder_and_the_user_name_are_hidden() {
        if let Ok(h) = std::env::var("HOME")
            && h.len() > 3
        {
            assert_eq!(scrub(&format!("{h}/x/ai-debug.txt"), 200), "~/x/ai-debug.txt");
        }
    }

    #[test]
    fn failures_are_classified_without_their_details() {
        assert_eq!(classify(&BridgeError::Auth("cookie=abc".into())), "auth (401/403)");
        assert_eq!(classify(&BridgeError::Network("HTTP 503 Service Unavailable: <html>secret</html>".into())), "http_503");
        assert_eq!(classify(&BridgeError::Network("error sending request for url (https://x.ru/a?b=1)".into())), "network: unreachable");
        let p = classify(&BridgeError::Parse(r#"invalid type: string "Мария", expected a sequence"#.into()));
        assert!(p.starts_with("parse: ") && !p.contains("Мария"), "{p}");
    }

    #[test]
    fn the_last_pass_keeps_the_report_markup() {
        let r = "# OpenSchool\n--------------------------------\n| a | 12 |\nid 123456789 and 0123456789abcdef0123456789abcdef";
        let c = scrub_report(r);
        assert!(c.contains("--------------------------------") && c.contains("| a | 12 |"), "{c}");
        assert!(c.contains("id <n> and <token>"), "{c}");
    }
}
