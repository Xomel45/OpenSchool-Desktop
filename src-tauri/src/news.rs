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

use openschool_bridge::Week;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::AppState;

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
}

impl Default for Settings {
    fn default() -> Self {
        Self { marks: true, homework: true, absences: false, interval_min: 15, detail: true, close_to_tray: false }
    }
}

impl Settings {
    fn sanitized(mut self) -> Self {
        if !INTERVALS.contains(&self.interval_min) {
            self.interval_min = Settings::default().interval_min;
        }
        self
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
            let time = l.start.get(11..16).unwrap_or("");
            out.push(Event { key: format!("a:{}", l.id), kind: Kind::Absence, subject: l.subject_name.clone(), value: None, detail: format!("{}, {time}", fmt_date(&date)), date });
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

/// Title and body of the system notification for one or several new events.
pub fn notification_text(items: &[Event], detail: bool) -> (String, String) {
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
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Write through a temporary file so a crash never leaves half a file.
fn write_json<T: Serialize>(path: &Path, value: &T) {
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
        Self { dir, settings: Mutex::new(settings.sanitized()), data: Mutex::new(data), student: Mutex::new(None), busy: AtomicBool::new(false) }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn save_data(&self, d: &Data) {
        write_json(&self.dir.join("news.json"), d);
    }

    /// Logout: forget the student, the seen ids and the feed (they belong to the account).
    pub fn reset(&self) {
        if let Ok(mut s) = self.student.lock() {
            *s = None;
        }
        if let Ok(mut d) = self.data.lock() {
            *d = Data::default();
        }
        let _ = std::fs::remove_file(self.dir.join("news.json"));
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
        let first = !data.initialized;
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
        self.save_data(&data);
        wanted
    }
}

// ---------- checking ----------

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// One pass: fetch three weeks, find what is new, tell the user. Returns how many wanted items were new.
pub async fn check(app: &AppHandle) -> Result<usize, String> {
    use chrono::{Datelike, Duration as Days, Local};
    let news = app.state::<News>();
    if news.busy.swap(true, Ordering::SeqCst) {
        return Ok(0); // a check is already running
    }
    let result = async {
        let client = app.state::<AppState>().client();
        let known = news.student.lock().map_err(|e| e.to_string())?.clone();
        let student = match known {
            Some(s) => s,
            None => {
                let s = client.students().await.map_err(|e| e.to_string())?.into_iter().next().ok_or("no student")?.id;
                *news.student.lock().map_err(|e| e.to_string())? = Some(s.clone());
                s
            }
        };
        let today = Local::now().date_naive();
        let mut found = Vec::new();
        for shift in [-7i64, 0, 7] {
            let w = (today + Days::days(shift)).iso_week();
            let week = client.week(student.clone(), w.year() as u32, w.week()).await.map_err(|e| e.to_string())?;
            found.extend(events(&week));
        }
        Ok::<_, String>(news.absorb(found, unix_now()))
    }
    .await;
    news.busy.store(false, Ordering::SeqCst);
    let new = result?;
    if !new.is_empty() {
        announce(app, &new);
    }
    let _ = app.emit("news-updated", serde_json::json!({ "unread": news.unread() }));
    Ok(new.len())
}

/// A quiet toast inside the window if the user is looking at it, a system notification otherwise.
fn announce(app: &AppHandle, items: &[Event]) {
    let detail = app.state::<News>().settings().detail;
    let looking = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if looking {
        let (title, body) = notification_text(items, detail);
        let _ = app.emit("news-new", serde_json::json!({ "title": title, "body": body, "kinds": items.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), "value": items.first().and_then(|e| e.value.clone()) }));
    } else {
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
                if let Err(e) = check(&app).await {
                    eprintln!("news: check failed: {e}"); // offline or not logged in: try again next time
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
    check(&app).await
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    app.manage(News::new(dir));
    start(app.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
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
    fn first_run_only_records_then_only_new_things_count() {
        let news = News::new(temp("flow"));
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
    fn duplicates_inside_one_batch_count_once() {
        let news = News::new(temp("dup"));
        news.absorb(vec![], 1);
        let e = events(&week(vec![mark("1", "Алгебра", "5")], vec![], vec![]));
        assert_eq!(news.absorb([e.clone(), e].concat(), 2).len(), 1);
    }

    #[test]
    fn feed_is_capped_persisted_and_cleared_on_reset() {
        let dir = temp("feed");
        let news = News::new(dir.clone());
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
