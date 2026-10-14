//! «Скоро контрольная» and «Вечерняя сводка».
//!
//! * A lesson is a test (контрольная, самостоятельная, тест, диктант, …) when its topic or a homework due on it says so. The same word
//!   list is in `ui/js/planner.js` (marks in the schedule); a test below keeps both lists equal.
//! * Once a day at the chosen time (19:00 by default) the background loop sends one notification about the next school day:
//!   how many lessons and from when, how many homeworks are not ticked, which tests there are. Either part can be switched off.
//!   The ticks live in the page; it sends them here (`planner_done`). Quiet hours silence it like any other notification.

use std::collections::HashSet;
use std::sync::Mutex;

use chrono::{Datelike, Duration as Days, NaiveDate};
use openschool_bridge::Week;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::news::News;

/// Word stem -> the label shown. Stems are matched inside words; the ones marked `true` only as a whole word (`впр` is in «вправо»).
pub const TEST_WORDS: &[(&str, &str, bool)] = &[
    ("контрольн", "Контрольная", false),
    ("к/р", "Контрольная", false),
    ("самостоятельн", "Самостоятельная", false),
    ("с/р", "Самостоятельная", false),
    ("проверочн", "Проверочная", false),
    ("диктант", "Диктант", false),
    ("зачёт", "Зачёт", false),
    ("зачет", "Зачёт", false),
    ("впр", "ВПР", true),
    ("тест", "Тест", false),
    ("срез", "Срез", true),
    ("диагностическ", "Диагностическая", false),
    ("экзамен", "Экзамен", false),
];

/// The label of the first test word in `text`, if any.
pub fn test_label(text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    for &(stem, label, whole) in TEST_WORDS {
        for (i, _) in t.match_indices(stem) {
            if !whole {
                return Some(label);
            }
            let before = t[..i].chars().next_back();
            let after = t[i + stem.len()..].chars().next();
            if !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric) {
                return Some(label);
            }
        }
    }
    None
}

/// One lesson of a day as the summary needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct DayPlan {
    pub date: NaiveDate,
    pub lessons: usize,
    /// "8:30"
    pub first: String,
    /// Homeworks due that day that are not ticked: their subjects.
    pub open: Vec<String>,
    /// (subject, label)
    pub tests: Vec<(String, &'static str)>,
    /// My open notes for the day's lessons.
    pub notes: Vec<String>,
}

/// An open note of the page: the lesson it belongs to and its text.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Note {
    pub lesson: String,
    pub text: String,
}

fn day_of(dt: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(dt.get(..10)?, "%Y-%m-%d").ok()
}

fn hm(dt: &str) -> String {
    dt.get(11..16).map(|s| s.strip_prefix('0').unwrap_or(s).to_string()).unwrap_or_default()
}

/// What the day holds, from the weeks at hand (a lesson or homework in two weeks counts once).
pub fn plan(weeks: &[Week], date: NaiveDate, done: &HashSet<String>, notes: &[Note]) -> DayPlan {
    let mut lessons: Vec<&openschool_bridge::Lesson> = Vec::new();
    let mut seen = HashSet::new();
    for l in weeks.iter().flat_map(|w| &w.lessons) {
        if day_of(&l.start) == Some(date) && seen.insert(l.id.clone()) {
            lessons.push(l);
        }
    }
    lessons.sort_by(|a, b| a.start.cmp(&b.start));
    let mut hws = Vec::new();
    let mut seen_hw = HashSet::new();
    for h in weeks.iter().flat_map(|w| &w.homeworks) {
        if day_of(&h.due_date) == Some(date) && seen_hw.insert(h.id.clone()) {
            hws.push(h);
        }
    }
    let mut tests: Vec<(String, &'static str)> = Vec::new();
    for l in &lessons {
        let from_hw = hws.iter().filter(|h| h.due_lesson_id.as_deref() == Some(&l.id)).find_map(|h| test_label(&h.description));
        if let Some(label) = l.theme.as_deref().and_then(test_label).or(from_hw)
            && !tests.iter().any(|(s, _)| s == &l.subject_name)
        {
            tests.push((l.subject_name.clone(), label));
        }
    }
    let mut open: Vec<String> = Vec::new();
    for h in hws.iter().filter(|h| !done.contains(&h.id)) {
        open.push(h.subject_name.clone());
    }
    let notes = lessons.iter().flat_map(|l| notes.iter().filter(move |n| n.lesson == l.id)).map(|n| n.text.chars().take(80).collect()).collect();
    DayPlan { date, lessons: lessons.len(), first: lessons.first().map(|l| hm(&l.start)).unwrap_or_default(), open, tests, notes }
}

/// The next day after `today` that has lessons, looking at most `within` days ahead.
pub fn next_school_day(weeks: &[Week], today: NaiveDate, within: i64) -> Option<NaiveDate> {
    (1..=within).map(|d| today + Days::days(d)).find(|d| weeks.iter().flat_map(|w| &w.lessons).any(|l| day_of(&l.start) == Some(*d)))
}

const WEEKDAYS_IN: [&str; 7] = ["В понедельник", "Во вторник", "В среду", "В четверг", "В пятницу", "В субботу", "В воскресенье"];

fn lessons_word(n: usize) -> &'static str {
    match (n % 10, n % 100) {
        (1, x) if x != 11 => "урок",
        (2..=4, x) if !(12..=14).contains(&x) => "урока",
        _ => "уроков",
    }
}

/// Title and text of the evening notification, or nothing to say.
pub fn evening_text(p: &DayPlan, today: NaiveDate, summary: bool, tests: bool) -> Option<(String, String)> {
    let when = if p.date == today + Days::days(1) { "Завтра".to_string() } else { WEEKDAYS_IN[p.date.weekday().num_days_from_monday() as usize].to_string() };
    let test_line = p.tests.iter().map(|(s, l)| format!("{s} ({})", l.to_lowercase())).collect::<Vec<_>>().join(", ");
    if summary {
        let title = format!("{when}: {} {} с {}", p.lessons, lessons_word(p.lessons), p.first);
        let mut body = Vec::new();
        if tests && !p.tests.is_empty() {
            body.push(format!("Контрольные: {test_line}."));
        }
        if p.open.is_empty() {
            body.push("Все задания отмечены сделанными.".to_string());
        } else {
            let mut subjects: Vec<&str> = Vec::new();
            for s in &p.open {
                if !subjects.contains(&s.as_str()) {
                    subjects.push(s);
                }
            }
            body.push(format!("Не сделано заданий: {} ({}).", p.open.len(), subjects.join(", ")));
        }
        if !p.notes.is_empty() {
            body.push(format!("Не забыть: {}.", p.notes.join("; ")));
        }
        return Some((title, body.join(" ")));
    }
    if tests && !p.tests.is_empty() {
        let title = if p.tests.len() == 1 { format!("{when} {}", p.tests[0].1.to_lowercase()) } else { format!("{when} контрольные") };
        return Some((title, test_line));
    }
    None
}

// ---------- the evening notification ----------

/// Ticked homework ids (from the page) and the day the evening notification was last sent.
#[derive(Default)]
pub struct Planner {
    done: Mutex<HashSet<String>>,
    notes: Mutex<Vec<Note>>,
}

/// The page tells which homeworks are ticked (at start and on every tick).
#[tauri::command]
pub fn planner_done(st: State<'_, Planner>, ids: Vec<String>, notes: Option<Vec<Note>>) {
    if let Ok(mut d) = st.done.lock() {
        *d = ids.into_iter().collect();
    }
    if let Ok(mut n) = st.notes.lock() {
        *n = notes.unwrap_or_default();
    }
}

fn last_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("evening-sent.txt"))
}

/// Called by the background loop every few seconds: sends the evening notification once a day, at or after the chosen time.
pub async fn tick(app: &AppHandle) {
    use chrono::{Local, Timelike};
    let news = app.state::<News>();
    let s = news.settings();
    if !s.evening && !s.test_reminders {
        return;
    }
    let now = Local::now();
    let minute = now.hour() * 60 + now.minute();
    if minute < s.evening_at || !news.is_active() {
        return;
    }
    let today = now.date_naive();
    let Some(file) = last_file(app) else { return };
    if std::fs::read_to_string(&file).ok().as_deref() == Some(today.to_string().as_str()) {
        return;
    }
    let Some(student) = news.student() else { return }; // the background check finds it first
    let client = app.state::<crate::AppState>().client();
    let mut weeks = Vec::new();
    for shift in [0i64, 7] {
        let w = (today + Days::days(shift)).iso_week();
        match client.week(student.clone(), w.year() as u32, w.week()).await {
            Ok(week) => weeks.push(week),
            Err(e) => {
                eprintln!("evening: {e}"); // offline: tried again on the next tick
                return;
            }
        }
    }
    let _ = std::fs::write(&file, today.to_string()); // one try per day, whatever the outcome below
    let Some(day) = next_school_day(&weeks, today, 3) else { return };
    let done = app.state::<Planner>().done.lock().map(|d| d.clone()).unwrap_or_default();
    let notes = app.state::<Planner>().notes.lock().map(|n| n.clone()).unwrap_or_default();
    let Some((title, body)) = evening_text(&plan(&weeks, day, &done, &notes), today, s.evening, s.test_reminders) else { return };
    if s.is_quiet(minute) {
        return;
    }
    let looking = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if looking {
        let _ = app.emit("news-new", serde_json::json!({ "title": title, "body": body, "kinds": ["evening"], "value": null }));
    } else if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("evening: notification failed: {e}");
    }
}

/// Logout: the ticks belong to the account; the "sent today" mark goes too, so a new login can get today's summary.
pub fn reset(app: &AppHandle) {
    if let Ok(mut d) = app.state::<Planner>().done.lock() {
        d.clear();
    }
    if let Ok(mut n) = app.state::<Planner>().notes.lock() {
        n.clear();
    }
    if let Some(f) = last_file(app) {
        let _ = std::fs::remove_file(f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openschool_bridge::{Homework, Lesson, Teacher};

    fn lesson(id: &str, subject: &str, start: &str, theme: Option<&str>) -> Lesson {
        Lesson { id: id.into(), subject_id: subject.into(), subject_name: subject.into(), teacher: Teacher { first_name: String::new(), last_name: String::new(), patronymic: String::new() }, start: start.into(), end: start.into(), room: String::new(), theme: theme.map(Into::into), absence: None }
    }
    fn hw(id: &str, subject: &str, due: &str, lesson: &str, text: &str) -> Homework {
        Homework { id: id.into(), subject_id: Some(subject.into()), subject_name: subject.into(), description: text.into(), issue_date: due.into(), due_date: due.into(), due_lesson_id: Some(lesson.into()), materials: vec![] }
    }
    fn week(lessons: Vec<Lesson>, homeworks: Vec<Homework>) -> Week {
        Week { year: 2026, iso_week: 42, lessons, homeworks, marks: vec![] }
    }
    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn test_words_are_found_and_short_ones_only_as_words() {
        for (text, label) in [("Контрольная работа №2", "Контрольная"), ("к/р по теме", "Контрольная"), ("Подготовиться к самостоятельной", "Самостоятельная"), ("ВПР по математике", "ВПР"), ("итоговый тест", "Тест"), ("Словарный диктант", "Диктант"), ("зачет", "Зачёт")] {
            assert_eq!(test_label(text), Some(label), "{text}");
        }
        for text in ["Повернуть вправо", "§5, ответить на вопросы", "прочитать текст", "срезать углы", ""] {
            assert_eq!(test_label(text), None, "{text}");
        }
    }

    #[test]
    fn the_word_list_of_the_page_is_the_same() {
        let js = include_str!("../../ui/js/planner.js");
        let start = js.find("const TEST_WORDS = [").expect("list in planner.js");
        let list = &js[start..js[start..].find("];").unwrap() + start];
        let page: Vec<(String, String, bool)> = list
            .match_indices("['")
            .map(|(i, _)| {
                let item = &list[i + 1..i + list[i..].find(']').unwrap()];
                let parts: Vec<&str> = item.split(',').map(str::trim).collect();
                (parts[0].trim_matches('\'').to_string(), parts[1].trim_matches('\'').to_string(), parts[2] == "true")
            })
            .collect();
        let here: Vec<(String, String, bool)> = TEST_WORDS.iter().map(|&(s, l, w)| (s.into(), l.into(), w)).collect();
        assert_eq!(page, here);
    }

    #[test]
    fn the_plan_counts_lessons_open_homework_and_tests_once() {
        let a = week(
            vec![lesson("L2", "Физика", "2026-10-15 09:25:00", None), lesson("L1", "Алгебра", "2026-10-15 08:30:00", Some("Контрольная работа")), lesson("L3", "Химия", "2026-10-16 08:30:00", None)],
            vec![hw("H1", "Алгебра", "2026-10-15", "L1", "повторить §3"), hw("H2", "Физика", "2026-10-15", "L2", "к тесту: §4-5"), hw("H3", "Химия", "2026-10-16", "L3", "x")],
        );
        let b = week(vec![lesson("L1", "Алгебра", "2026-10-15 08:30:00", Some("Контрольная работа"))], vec![hw("H1", "Алгебра", "2026-10-15", "L1", "повторить §3")]);
        let done: HashSet<String> = ["H2".to_string()].into();
        let notes = [Note { lesson: "L2".into(), text: "взять тетрадь".into() }, Note { lesson: "L3".into(), text: "другой день".into() }];
        let p = plan(&[a, b], d("2026-10-15"), &done, &notes);
        assert_eq!(p.notes, vec!["взять тетрадь".to_string()], "only notes of that day's lessons");
        assert_eq!(p.lessons, 2);
        assert_eq!(p.first, "8:30");
        assert_eq!(p.open, vec!["Алгебра".to_string()], "the ticked one is not open, the doubled one counts once");
        assert_eq!(p.tests, vec![("Алгебра".to_string(), "Контрольная"), ("Физика".to_string(), "Тест")]);
    }

    #[test]
    fn the_next_school_day_skips_the_weekend() {
        let w = week(vec![lesson("L", "X", "2026-10-19 08:30:00", None)], vec![]);
        assert_eq!(next_school_day(std::slice::from_ref(&w), d("2026-10-16"), 3), Some(d("2026-10-19")), "Friday evening: Monday");
        assert_eq!(next_school_day(&[w], d("2026-10-12"), 3), None, "nothing within three days");
    }

    #[test]
    fn the_evening_text_says_what_is_switched_on() {
        let p = DayPlan { date: d("2026-10-15"), lessons: 6, first: "8:30".into(), open: vec!["Алгебра".into(), "Физика".into(), "Алгебра".into()], tests: vec![("Алгебра".into(), "Контрольная")], notes: vec![] };
        let today = d("2026-10-14");
        let (t, b) = evening_text(&p, today, true, true).unwrap();
        assert_eq!(t, "Завтра: 6 уроков с 8:30");
        assert_eq!(b, "Контрольные: Алгебра (контрольная). Не сделано заданий: 3 (Алгебра, Физика).");
        let (_, b) = evening_text(&p, today, true, false).unwrap();
        assert!(!b.contains("Контрольн"), "tests off: not mentioned");
        assert_eq!(evening_text(&p, today, false, true).unwrap(), ("Завтра контрольная".to_string(), "Алгебра (контрольная)".to_string()));
        let with_note = DayPlan { notes: vec!["взять форму".into()], ..p.clone() };
        assert!(evening_text(&with_note, today, true, true).unwrap().1.ends_with(" Не забыть: взять форму."));
        let calm = DayPlan { tests: vec![], open: vec![], ..p.clone() };
        assert_eq!(evening_text(&calm, today, false, true), None, "only tests wanted, none there: silence");
        assert_eq!(evening_text(&calm, today, true, true).unwrap().1, "Все задания отмечены сделанными.");
        let monday = DayPlan { date: d("2026-10-19"), ..calm };
        assert!(evening_text(&monday, d("2026-10-16"), true, true).unwrap().0.starts_with("В понедельник: "));
        assert_eq!((lessons_word(1), lessons_word(3), lessons_word(11), lessons_word(22)), ("урок", "урока", "уроков", "урока"));
    }
}
