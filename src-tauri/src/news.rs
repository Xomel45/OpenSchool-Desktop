//! "What's new": watches the diary in the background and tells the user about new marks, homework and absences.
//!
//! * Every `interval_min` minutes (while the app runs, also when its window is hidden in the tray) the previous, the
//!   current and the next week are fetched and compared with the ids already seen.
//! * The very first check after a login only records what is there, so nobody gets forty notifications at once.
//! * New things go to a feed the UI shows behind the bell. If the window is in focus the UI shows a quiet toast,
//!   otherwise the system shows a notification.
//! * Seen ids, the feed and the settings live in the app data directory and are deleted on logout.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use openschool_bridge::{BridgeError, Week};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::{commands::SESSION_EXPIRED, AppState};

const FEED_LIMIT: usize = 50;
const INTERVALS: [u32; 4] = [5, 15, 30, 60];

// ---------- settings ----------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub marks: bool,
    pub homework: bool,
    pub absences: bool,
    pub interval_min: u32,
    /// Show the subject and the mark in the notification, not just "new mark".
    pub detail: bool,
    /// Closing the window hides it in the tray instead of quitting (the background check then keeps running).
    pub close_to_tray: bool,
    /// "Do not disturb at night": no system notifications between `quiet_from` and `quiet_to` (the check goes on, the feed fills).
    pub quiet: bool,
    /// Minutes since midnight, 0..1439.
    pub quiet_from: u32,
    pub quiet_to: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { marks: true, homework: true, absences: false, interval_min: 15, detail: true, close_to_tray: false, quiet: false, quiet_from: 22 * 60, quiet_to: 7 * 60 }
    }
}

impl Settings {
    fn sanitized(mut self) -> Self {
        let d = Settings::default();
        if !INTERVALS.contains(&self.interval_min) {
            self.interval_min = d.interval_min;
        }
        if self.quiet_from >= 24 * 60 {
            self.quiet_from = d.quiet_from;
        }
        if self.quiet_to >= 24 * 60 {
            self.quiet_to = d.quiet_to;
        }
        self
    }

    /// Is `minute` (minutes since local midnight) inside the quiet hours? The start is quiet, the end is not; a span may run over
    /// midnight (22:00-07:00); equal times mean "no quiet hours".
    pub fn is_quiet(&self, minute: u32) -> bool {
        if !self.quiet || self.quiet_from == self.quiet_to {
            return false;
        }
        if self.quiet_from < self.quiet_to { (self.quiet_from..self.quiet_to).contains(&minute) } else { minute >= self.quiet_from || minute < self.quiet_to }
    }
    fn wants(&self, kind: Kind) -> bool {
        match kind {
            Kind::Mark => self.marks,
            Kind::Homework => self.homework,
            Kind::Absence => self.absences,
        }
    }
}

// ---------- events found in a week ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Mark,
    Homework,
    Absence,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Mark => "mark",
            Kind::Homework => "homework",
            Kind::Absence => "absence",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    /// Stable across weeks and runs: `m:<mark id>`, `h:<homework id>`, `a:<lesson id>`.
    pub key: String,
    pub kind: Kind,
    pub subject: String,
    pub value: Option<String>,
    /// One line of context: the kind of work and the date, the assignment and its due date, ...
    pub detail: String,
    pub date: String,
}

const MONTHS: [&str; 12] = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/// `2026-10-08` -> `8 октября`; anything else is returned unchanged.
fn fmt_date(iso: &str) -> String {
    let mut p = iso.get(..10).unwrap_or("").split('-');
    match (p.next().and_then(|y| y.parse::<u32>().ok()), p.next().and_then(|m| m.parse::<usize>().ok()), p.next().and_then(|d| d.parse::<u32>().ok())) {
        (Some(_), Some(m @ 1..=12), Some(d)) => format!("{d} {}", MONTHS[m - 1]),
        _ => iso.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max { s } else { format!("{}…", s.chars().take(max).collect::<String>().trim_end()) }
}

pub fn events(week: &Week) -> Vec<Event> {
    let mut out = Vec::new();
    for m in &week.marks {
        let work = m.work_name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(&m.work_type);
        let detail = if work.trim().is_empty() { fmt_date(&m.date) } else { format!("{work} · {}", fmt_date(&m.date)) };
        out.push(Event { key: format!("m:{}", m.id), kind: Kind::Mark, subject: m.subject_name.clone(), value: Some(m.value.clone()), detail, date: m.date.clone() });
    }
    for h in &week.homeworks {
        let text = if h.description.trim().is_empty() { "без текста".to_string() } else { truncate(&h.description, 90) };
        out.push(Event { key: format!("h:{}", h.id), kind: Kind::Homework, subject: h.subject_name.clone(), value: None, detail: format!("{text} · на {}", fmt_date(&h.due_date)), date: h.due_date.clone() });
    }
    for l in &week.lessons {
        if l.absence.is_some() {
            let date = l.start.get(..10).unwrap_or("").to_string();
            let detail = match l.start.get(11..16) {
                Some(time) if !time.is_empty() => format!("{}, {time}", fmt_date(&date)),
                _ => fmt_date(&date),
            };
            out.push(Event { key: format!("a:{}", l.id), kind: Kind::Absence, subject: l.subject_name.clone(), value: None, detail, date });
        }
    }
    out
}

// ---------- texts ----------

/// Russian plural: 1 / 2-4 / 5+ (and 11-14).
fn plural<'a>(n: usize, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    if n % 10 == 1 && n % 100 != 11 {
        one
    } else if (2..=4).contains(&(n % 10)) && !(12..=14).contains(&(n % 100)) {
        few
    } else {
        many
    }
}

/// Linux notification servers (Plasma, GNOME) read a little markup (`<b>`, `<a href>`) in the body, and the text of a homework
/// is written by someone else: show it as text there. Windows shows the body as plain text, so it is left alone.
fn plain(s: String) -> String {
    if cfg!(target_os = "linux") { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") } else { s }
}

/// Title and body of the system notification for one or several new events.
pub fn notification_text(items: &[Event], detail: bool) -> (String, String) {
    let (title, body) = notification_text_raw(items, detail);
    (plain(title), plain(body))
}

fn notification_text_raw(items: &[Event], detail: bool) -> (String, String) {
    const HIDDEN: &str = "Откройте OpenSchool";
    if let [e] = items {
        let (title, name) = match e.kind {
            Kind::Mark => ("Новая оценка", e.value.as_deref().map(|v| format!("{} — {v}", e.subject))),
            Kind::Homework => ("Новое задание", Some(e.subject.clone())),
            Kind::Absence => ("Отметка о пропуске", Some(e.subject.clone())),
        };
        return match (detail, name) {
            (true, Some(n)) => (format!("{title}: {n}"), e.detail.clone()),
            _ => (title.to_string(), HIDDEN.to_string()),
        };
    }
    let n = items.len();
    let same = items.iter().all(|e| e.kind == items[0].kind);
    let title = match (same, items.first().map(|e| e.kind)) {
        (true, Some(Kind::Mark)) => format!("{n} {}", plural(n, "новая оценка", "новые оценки", "новых оценок")),
        (true, Some(Kind::Homework)) => format!("{n} {}", plural(n, "новое задание", "новых задания", "новых заданий")),
        (true, Some(Kind::Absence)) => format!("{n} {}", plural(n, "отметка о пропуске", "отметки о пропусках", "отметок о пропусках")),
        _ => format!("{n} {}", plural(n, "новое событие", "новых события", "новых событий")),
    };
    if !detail {
        return (title, HIDDEN.to_string());
    }
    let short: Vec<String> = items.iter().take(3).map(|e| match &e.value { Some(v) => format!("{} {v}", e.subject), None => e.subject.clone() }).collect();
    let more = if n > 3 { format!(" · и ещё {}", n - 3) } else { String::new() };
    (title, format!("{}{more}", short.join(" · ")))
}

// ---------- state on disk ----------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub value: Option<String>,
    pub date: String,
    /// Unix seconds when the app noticed it.
    pub ts: i64,
    pub read: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Data {
    /// The student the seen ids and the feed belong to; another account starts from scratch (silently).
    account: Option<String>,
    initialized: bool,
    seen: HashSet<String>,
    feed: Vec<FeedItem>,
}

pub struct News {
    dir: PathBuf,
    settings: Mutex<Settings>,
    data: Mutex<Data>,
    student: Mutex<Option<String>>,
    busy: AtomicBool,
    /// A login is confirmed (restored, or done just now). Only then does the background check ask the server anything:
    /// without a session it would get a 401 and wrongly announce "session expired" (at first start, after logout).
    active: AtomicBool,
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Write through a temporary file so a crash never leaves half a file.
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) {
    let tmp = path.with_extension("tmp");
    let ok = serde_json::to_vec(value).ok().is_some_and(|b| std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).is_ok() && std::fs::write(&tmp, b).is_ok() && std::fs::rename(&tmp, path).is_ok());
    if !ok {
        eprintln!("news: could not save {}", path.display());
    }
}

impl News {
    pub fn new(dir: PathBuf) -> Self {
        let settings: Settings = read_json(&dir.join("notify.json"));
        let data: Data = read_json(&dir.join("news.json"));
        Self { dir, settings: Mutex::new(settings.sanitized()), data: Mutex::new(data), student: Mutex::new(None), busy: AtomicBool::new(false), active: AtomicBool::new(false) }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn save_data(&self, d: &Data) {
        write_json(&self.dir.join("news.json"), d);
    }

    /// The student the background check follows (the UI selected another one of the account).
    pub fn set_student(&self, id: String) {
        if let Ok(mut s) = self.student.lock() {
            *s = Some(id);
        }
    }

    /// A confirmed login (a restored session or a new one): checks may run, and the student is looked up again (it may be another account).
    pub fn logged_in(&self) {
        self.active.store(true, Ordering::SeqCst);
        if let Ok(mut s) = self.student.lock() {
            *s = None;
        }
    }

    /// Make sure the stored ids and feed belong to `student`; for another account they are dropped (and the next check stays silent).
    fn adopt_account(&self, student: &str) {
        if let Ok(mut d) = self.data.lock()
            && d.account.as_deref() != Some(student)
        {
            *d = Data { account: Some(student.to_string()), ..Data::default() };
            self.save_data(&d);
        }
    }

    /// The session is gone (the UI saw it expire): no more checks until the next login.
    pub fn deactivate(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    /// Logout: forget the student, the seen ids and the feed (they belong to the account).
    pub fn reset(&self) {
        self.deactivate();
        if let Ok(mut s) = self.student.lock() {
            *s = None;
        }
        // The file goes while the data lock is held: `absorb` checks the login under the same lock, so it either finishes
        // before this (and its file is deleted here) or sees "logged out" and writes nothing.
        if let Ok(mut d) = self.data.lock() {
            *d = Data::default();
            let _ = std::fs::remove_file(self.dir.join("news.json"));
        }
    }

    fn unread(&self) -> usize {
        self.data.lock().map(|d| d.feed.iter().filter(|i| !i.read).count()).unwrap_or(0)
    }

    /// Take in what a check found. Returns the items that are new and wanted (empty on the very first run).
    fn absorb(&self, found: Vec<Event>, now: i64) -> Vec<Event> {
        let settings = self.settings();
        let mut data = match self.data.lock() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        // Checked under the lock (see `reset`): a check that was in flight while the user logged out must not bring the
        // old account's file back, not even if the logout lands right between the check and the lock.
        if !self.active.load(Ordering::SeqCst) {
            return Vec::new();
        }
        let first = !data.initialized;
        let seen_len = data.seen.len();
        let mut new = Vec::new();
        let mut batch = HashSet::new();
        for e in found {
            if data.seen.contains(&e.key) || !batch.insert(e.key.clone()) {
                continue;
            }
            new.push(e);
        }
        // Everything found counts as seen, even kinds that are switched off: turning one on later must not flood.
        for e in &new {
            data.seen.insert(e.key.clone());
        }
        data.initialized = true;
        let wanted: Vec<Event> = if first { Vec::new() } else { new.into_iter().filter(|e| settings.wants(e.kind)).collect() };
        for e in wanted.iter().rev() {
            data.feed.insert(0, FeedItem { id: e.key.clone(), kind: e.kind.as_str().into(), title: e.subject.clone(), text: e.detail.clone(), value: e.value.clone(), date: e.date.clone(), ts: now, read: false });
        }
        data.feed.truncate(FEED_LIMIT);
        if first || !nothing_added(&data, seen_len) {
            self.save_data(&data);
        }
        wanted
    }
}

// ---------- checking ----------

/// Nothing was added to the seen set: no need to rewrite the file on every check.
fn nothing_added(data: &Data, seen_len: usize) -> bool {
    data.seen.len() == seen_len
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Clears the "a check is running" flag when dropped.
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Why a check did not happen.
#[derive(Debug)]
pub enum CheckError {
    /// The server does not accept the session any more.
    Expired,
    Other(String),
}

impl From<BridgeError> for CheckError {
    fn from(e: BridgeError) -> Self {
        match e {
            BridgeError::Auth(_) => CheckError::Expired,
            other => CheckError::Other(crate::commands::err(other)),
        }
    }
}

impl From<String> for CheckError {
    fn from(e: String) -> Self {
        CheckError::Other(e)
    }
}

/// One pass: fetch three weeks, find what is new, tell the user. Returns how many wanted items were new.
pub async fn check(app: &AppHandle) -> Result<usize, CheckError> {
    use chrono::{Datelike, Duration as Days, Local};
    let news = app.state::<News>();
    if !news.active.load(Ordering::SeqCst) {
        return Err(CheckError::Expired); // not logged in (yet / any more): nothing to ask, and nothing to announce
    }
    if news.busy.swap(true, Ordering::SeqCst) {
        return Ok(0); // a check is already running
    }
    let _busy = BusyGuard(&news.busy); // released on every way out, also when this future is dropped half-way
    let result = async {
        let client = app.state::<AppState>().client();
        let known = news.student.lock().map_err(|e| e.to_string())?.clone();
        let student = match known {
            Some(s) => s,
            None => {
                let all = client.students().await?;
                let chosen = app.state::<AppState>().selected();
                let s = all.iter().find(|s| Some(&s.id) == chosen.as_ref()).or(all.first()).ok_or("no student".to_string())?.id.clone();
                *news.student.lock().map_err(|e| e.to_string())? = Some(s.clone());
                s
            }
        };
        news.adopt_account(&student);
        let today = Local::now().date_naive();
        let mut found = Vec::new();
        for shift in [-7i64, 0, 7] {
            let w = (today + Days::days(shift)).iso_week();
            let week = client.week(student.clone(), w.year() as u32, w.week()).await?;
            found.extend(events(&week));
        }
        Ok::<_, CheckError>(news.absorb(found, unix_now()))
    }
    .await;
    let new = match result {
        Ok(n) => n,
        Err(CheckError::Expired) => {
            session_expired(app);
            return Err(CheckError::Expired);
        }
        Err(e) => return Err(e),
    };
    if !new.is_empty() {
        announce(app, &new);
    }
    let _ = app.emit("news-updated", serde_json::json!({ "unread": news.unread() }));
    Ok(new.len())
}

/// The server rejected the session: tell the UI (it shows the login screen) and, if nobody is looking at the window,
/// the user (a system notification), once. Checks then pause until the next login.
fn session_expired(app: &AppHandle) {
    let news = app.state::<News>();
    if !news.active.swap(false, Ordering::SeqCst) {
        return; // already handled (or never logged in)
    }
    let looking = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    let _ = app.emit("session-expired", ());
    // At night nothing is shown from outside; the window says it when it is opened.
    if !looking && !quiet_now(&news.settings()) && let Err(e) = app.notification().builder().title("Сессия истекла").body("Войдите в OpenSchool снова, иначе уведомления не придут").show() {
        eprintln!("news: notification failed: {e}");
    }
}

fn quiet_now(settings: &Settings) -> bool {
    use chrono::Timelike;
    let now = chrono::Local::now();
    settings.is_quiet(now.hour() * 60 + now.minute())
}

/// A quiet toast inside the window if the user is looking at it, a system notification otherwise.
fn announce(app: &AppHandle, items: &[Event]) {
    let detail = app.state::<News>().settings().detail;
    let looking = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if looking {
        let (title, body) = notification_text(items, detail);
        let _ = app.emit("news-new", serde_json::json!({ "title": title, "body": body, "kinds": items.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), "value": items.first().and_then(|e| e.value.clone()) }));
    } else {
        // Quiet hours: nothing pops up; the items are in the feed (the bell) all the same.
        if quiet_now(&app.state::<News>().settings()) {
            return;
        }
        let (title, body) = notification_text(items, detail);
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            eprintln!("news: notification failed: {e}");
        }
    }
}

/// The background loop: the first check shortly after start, then every `interval_min` minutes.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let mut last: Option<Instant> = None;
        loop {
            let every = Duration::from_secs(u64::from(app.state::<News>().settings().interval_min) * 60);
            if last.is_none_or(|l| l.elapsed() >= every) {
                last = Some(Instant::now());
                match check(&app).await {
                    Ok(_) | Err(CheckError::Expired) => {}
                    Err(CheckError::Other(e)) => eprintln!("news: check failed: {e}"), // offline etc.: try again next time
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

// ---------- commands ----------

#[derive(Serialize)]
pub struct FeedView {
    items: Vec<FeedItem>,
    unread: usize,
}

#[tauri::command]
pub fn notify_get(news: State<'_, News>) -> Settings {
    news.settings()
}

#[tauri::command]
pub fn notify_set(news: State<'_, News>, settings: Settings) -> Settings {
    let clean = settings.sanitized();
    if let Ok(mut s) = news.settings.lock() {
        *s = clean.clone();
    }
    write_json(&news.dir.join("notify.json"), &clean);
    clean
}

#[tauri::command]
pub fn news_feed(news: State<'_, News>) -> FeedView {
    let items = news.data.lock().map(|d| d.feed.clone()).unwrap_or_default();
    let unread = items.iter().filter(|i| !i.read).count();
    FeedView { items, unread }
}

/// Mark items read: the given ids, or everything when `ids` is empty.
/// Empty the feed (the seen ids stay, so nothing comes back).
#[tauri::command]
pub fn news_clear(app: AppHandle, news: State<'_, News>) {
    if let Ok(mut d) = news.data.lock() {
        d.feed.clear();
        news.save_data(&d);
    }
    let _ = app.emit("news-updated", serde_json::json!({ "unread": 0 }));
}

#[tauri::command]
pub fn news_read(app: AppHandle, news: State<'_, News>, ids: Vec<String>) -> usize {
    if let Ok(mut d) = news.data.lock() {
        for i in d.feed.iter_mut().filter(|i| ids.is_empty() || ids.contains(&i.id)) {
            i.read = true;
        }
        news.save_data(&d);
    }
    let unread = news.unread();
    let _ = app.emit("news-updated", serde_json::json!({ "unread": unread }));
    unread
}

/// "Check now" button: returns how many new wanted items were found.
#[tauri::command]
pub async fn news_check_now(app: AppHandle) -> Result<usize, String> {
    check(&app).await.map_err(|e| match e {
        CheckError::Expired => SESSION_EXPIRED.to_string(),
        CheckError::Other(s) => s,
    })
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    app.manage(News::new(dir));
    start(app.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn quiet_hours_cover_the_night_across_midnight_and_include_only_their_start() {
        let night = Settings { quiet: true, quiet_from: 22 * 60, quiet_to: 7 * 60, ..Settings::default() };
        for (m, quiet) in [(22 * 60, true), (22 * 60 - 1, false), (23 * 60 + 59, true), (0, true), (6 * 60 + 59, true), (7 * 60, false), (12 * 60, false)] {
            assert_eq!(night.is_quiet(m), quiet, "{m}");
        }
        let day = Settings { quiet: true, quiet_from: 13 * 60, quiet_to: 15 * 60, ..Settings::default() };
        assert!(day.is_quiet(13 * 60) && day.is_quiet(14 * 60 + 59) && !day.is_quiet(15 * 60) && !day.is_quiet(3 * 60));
        assert!(!Settings { quiet: false, ..night.clone() }.is_quiet(0), "off means off");
        assert!(!Settings { quiet_from: 480, quiet_to: 480, ..night }.is_quiet(480), "equal times: no quiet hours");
    }

    #[test]
    fn broken_quiet_times_from_a_file_fall_back_to_the_defaults() {
        let s = Settings { quiet_from: 5000, quiet_to: 24 * 60, interval_min: 7, ..Settings::default() }.sanitized();
        assert_eq!((s.quiet_from, s.quiet_to, s.interval_min), (22 * 60, 7 * 60, 15));
        let old: Settings = serde_json::from_str(r#"{"marks":false}"#).unwrap();
        assert!(!old.quiet && old.quiet_from == 22 * 60, "a settings file from before has no quiet fields");
    }

    use super::*;
    use openschool_bridge::{Absence, Homework, Lesson, Mark, Teacher};

    fn mark(id: &str, subject: &str, value: &str) -> Mark {
        Mark { id: id.into(), subject_id: "s".into(), subject_name: subject.into(), value: value.into(), value2: None, date: "2026-10-08".into(), work_type_code: "Test".into(), work_type: "Контрольная работа".into(), work_name: None, comment: None, lesson_id: None }
    }
    fn homework(id: &str, subject: &str, text: &str) -> Homework {
        Homework { id: id.into(), subject_id: None, subject_name: subject.into(), description: text.into(), issue_date: "2026-10-07".into(), due_date: "2026-10-09".into(), due_lesson_id: None, materials: vec![] }
    }
    fn lesson(id: &str, absent: bool) -> Lesson {
        Lesson { id: id.into(), subject_id: "s".into(), subject_name: "Химия".into(), teacher: Teacher { first_name: "".into(), last_name: "".into(), patronymic: "".into() }, start: "2026-10-08 11:15:00".into(), end: "2026-10-08 11:55:00".into(), room: "".into(), theme: None, absence: absent.then(|| Absence { code: "x".into(), description: "".into() }) }
    }
    fn week(marks: Vec<Mark>, homeworks: Vec<Homework>, lessons: Vec<Lesson>) -> Week {
        Week { year: 2026, iso_week: 41, lessons, homeworks, marks }
    }
    /// A `News` that is logged in (the background check only records anything for a confirmed login).
    fn active(dir: PathBuf) -> News {
        let news = News::new(dir);
        news.logged_in();
        news
    }
    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("openschool-news-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plurals_and_dates() {
        assert_eq!([1, 2, 5, 11, 12, 21, 22, 25].map(|n| plural(n, "a", "b", "c")), ["a", "b", "c", "c", "c", "a", "b", "c"]);
        assert_eq!(fmt_date("2026-10-08"), "8 октября");
        assert_eq!(fmt_date("2026-01-31 10:00:00"), "31 января");
        assert_eq!(fmt_date("garbage"), "garbage");
        assert_eq!(truncate("a   b\n c", 50), "a b c");
        assert_eq!(truncate(&"x".repeat(100), 10), format!("{}…", "x".repeat(10)));
    }

    #[test]
    fn events_cover_marks_homework_and_absences() {
        let e = events(&week(vec![mark("1", "Алгебра", "5")], vec![homework("2", "Физика", "§12, №40")], vec![lesson("3", true), lesson("4", false)]));
        assert_eq!(e.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), ["m:1", "h:2", "a:3"]);
        assert_eq!(e[0].detail, "Контрольная работа · 8 октября");
        assert_eq!(e[1].detail, "§12, №40 · на 9 октября");
        assert_eq!(e[2].detail, "8 октября, 11:15");
    }

    #[test]
    fn texts_single_grouped_and_hidden() {
        let m = |s: &str, v: &str| events(&week(vec![mark(s, s, v)], vec![], vec![])).remove(0);
        let one = [m("Алгебра", "5")];
        assert_eq!(notification_text(&one, true), ("Новая оценка: Алгебра — 5".into(), "Контрольная работа · 8 октября".into()));
        assert_eq!(notification_text(&one, false), ("Новая оценка".into(), "Откройте OpenSchool".into()));
        let three = [m("Алгебра", "5"), m("Физика", "4"), m("История", "3")];
        assert_eq!(notification_text(&three, true), ("3 новые оценки".into(), "Алгебра 5 · Физика 4 · История 3".into()));
        let five: Vec<Event> = (0..5).map(|i| m(&format!("П{i}"), "4")).collect();
        let (t, b) = notification_text(&five, true);
        assert_eq!(t, "5 новых оценок");
        assert!(b.ends_with("и ещё 2"));
        let mixed = [m("Алгебра", "5"), events(&week(vec![], vec![homework("9", "Физика", "x")], vec![])).remove(0)];
        assert_eq!(notification_text(&mixed, true).0, "2 новых события");
        assert_eq!(notification_text(&three, false).1, "Откройте OpenSchool");
    }

    #[test]
    fn homework_text_cannot_inject_markup_into_a_linux_notification() {
        let e = events(&week(vec![], vec![homework("2", "Физика", "<a href=\"http://evil.example\">click</a> & <b>x</b>")], vec![]));
        let (title, body) = notification_text(&e, true);
        if cfg!(target_os = "linux") {
            assert!(!body.contains('<') && !body.contains('>'), "{body}");
            assert!(body.contains("&lt;a href") && body.contains("&amp;"));
        }
        assert!(title.starts_with("Новое задание"));
    }

    #[test]
    fn a_check_in_flight_during_logout_cannot_bring_the_old_file_back() {
        let dir = temp("logout-race");
        let news = News::new(dir.clone());
        news.logged_in();
        news.absorb(vec![], 1);
        news.absorb(events(&week(vec![mark("1", "Алгебра", "5")], vec![], vec![])), 2);
        assert!(dir.join("news.json").exists());
        news.reset(); // logout
        assert!(!dir.join("news.json").exists());
        let late = news.absorb(events(&week(vec![mark("2", "История", "4")], vec![], vec![])), 3); // the check that was still running
        assert!(late.is_empty());
        assert!(!dir.join("news.json").exists(), "the file of the logged-out account must stay deleted");
    }

    #[test]
    fn first_run_only_records_then_only_new_things_count() {
        let news = active(temp("flow"));
        let w1 = || events(&week(vec![mark("1", "Алгебра", "5")], vec![homework("2", "Физика", "x")], vec![lesson("3", true)]));
        assert!(news.absorb(w1(), 100).is_empty(), "first run must stay silent");
        assert_eq!(news.unread(), 0);
        assert!(news.absorb(w1(), 200).is_empty(), "nothing new");
        let mut again = w1();
        again.extend(events(&week(vec![mark("5", "История", "4")], vec![homework("6", "Химия", "y")], vec![lesson("7", true)])));
        let got = news.absorb(again, 300);
        // absences are off by default: the mark and the homework are announced, the absence is only remembered
        assert_eq!(got.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["m:5", "h:6"]);
        assert_eq!(news.unread(), 2);
        news.settings.lock().unwrap().absences = true;
        assert!(news.absorb(events(&week(vec![], vec![], vec![lesson("7", true)])), 400).is_empty(), "an old absence must not flood after switching it on");
    }

    #[test]
    fn another_account_starts_from_scratch_and_the_same_one_keeps_its_state() {
        let news = active(temp("account"));
        news.adopt_account("A");
        news.absorb(vec![], 1);
        news.absorb(events(&week(vec![mark("1", "Алгебра", "5")], vec![], vec![])), 2);
        assert_eq!(news.unread(), 1);
        news.adopt_account("A");
        assert_eq!(news.unread(), 1, "same account: nothing is lost");
        news.adopt_account("B");
        assert_eq!(news.unread(), 0, "another account: the old feed is gone");
        assert!(!news.data.lock().unwrap().initialized, "and the first check of the new account stays silent");
    }

    #[test]
    fn auth_errors_are_told_apart_and_a_new_login_resumes_checks() {
        assert!(matches!(CheckError::from(BridgeError::Auth("HTTP 401".into())), CheckError::Expired));
        assert!(matches!(CheckError::from(BridgeError::Network("HTTP 500".into())), CheckError::Other(_)));
        let news = News::new(temp("expired"));
        assert!(!news.active.load(Ordering::SeqCst), "a fresh start has no login: the background check must stay quiet");
        *news.student.lock().unwrap() = Some("old".into());
        news.logged_in();
        assert!(news.active.load(Ordering::SeqCst));
        assert!(news.student.lock().unwrap().is_none());
        news.deactivate();
        assert!(!news.active.load(Ordering::SeqCst));
        news.logged_in();
        news.reset(); // logout
        assert!(!news.active.load(Ordering::SeqCst), "after logout the check must not run and announce an expired session");
    }

    #[test]
    fn an_absence_without_a_time_has_no_dangling_comma() {
        let mut l = lesson("9", true);
        l.start = "2026-10-08".into();
        let e = events(&week(vec![], vec![], vec![l]));
        assert_eq!(e[0].detail, "8 октября");
    }

    #[test]
    fn unchanged_checks_do_not_rewrite_the_file() {
        let dir = temp("nowrite");
        let news = active(dir.clone());
        news.absorb(vec![], 1);
        let path = dir.join("news.json");
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        news.absorb(vec![], 2); // nothing new
        assert!(!path.exists(), "no new ids: no write");
        news.absorb(events(&week(vec![mark("1", "Алгебра", "5")], vec![], vec![])), 3);
        assert!(path.exists(), "a new id is saved");
    }

    #[test]
    fn duplicates_inside_one_batch_count_once() {
        let news = active(temp("dup"));
        news.absorb(vec![], 1);
        let e = events(&week(vec![mark("1", "Алгебра", "5")], vec![], vec![]));
        assert_eq!(news.absorb([e.clone(), e].concat(), 2).len(), 1);
    }

    #[test]
    fn feed_is_capped_persisted_and_cleared_on_reset() {
        let dir = temp("feed");
        let news = active(dir.clone());
        news.absorb(vec![], 1);
        let many: Vec<Event> = (0..80).flat_map(|i| events(&week(vec![mark(&i.to_string(), "Алгебра", "5")], vec![], vec![]))).collect();
        news.absorb(many, 2);
        assert_eq!(news.data.lock().unwrap().feed.len(), FEED_LIMIT);
        let again = News::new(dir.clone()); // a restart keeps the feed and the seen ids
        assert_eq!(again.unread(), FEED_LIMIT);
        assert!(again.data.lock().unwrap().initialized);
        again.reset();
        assert_eq!(again.unread(), 0);
        assert!(!dir.join("news.json").exists());
    }

    #[test]
    fn settings_are_checked_and_survive_a_restart() {
        let dir = temp("settings");
        assert_eq!(Settings { interval_min: 7, ..Settings::default() }.sanitized().interval_min, 15);
        write_json(&dir.join("notify.json"), &Settings { homework: false, interval_min: 30, ..Settings::default() });
        let s = News::new(dir.clone()).settings();
        assert!(!s.homework && s.interval_min == 30 && s.marks);
        std::fs::write(dir.join("notify.json"), "{ not json").unwrap();
        assert_eq!(News::new(dir).settings(), Settings::default(), "junk on disk falls back to the defaults");
    }
}
