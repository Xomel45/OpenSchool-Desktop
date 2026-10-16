//! `openschool`: the diary in a terminal. It uses the session the desktop app saved in the system secret store and only reads:
//! it never logs in, saves or deletes a session (an expired one is renewed by logging in in the app).

mod args;
mod view;

// The app's own session store, so both read the same entries the same way (save/clear are the app's business).
#[allow(dead_code)]
#[path = "../../src-tauri/src/store.rs"]
mod store;

use std::collections::HashSet;
use std::io::IsTerminal;
use std::sync::Arc;
use std::time::Duration;

use args::{Command, Day, Options};
use chrono::{Datelike, Local, NaiveDate};
use openschool_bridge::{BridgeError, Client, ClassInfo, Homework, Lesson, Mark, Period, Student};
use view::Style;

const VERSION: &str = env!("OPENSCHOOL_VERSION");
/// The app's identifier (tauri.conf.json): its data folder holds the network setting. A test compares the two.
const APP_ID: &str = "io.github.xomel45.openschool";

enum Fail {
    /// Exit 3: there is no usable session, log in in the app.
    Login(String),
    /// Exit 1.
    Other(String),
}

impl From<BridgeError> for Fail {
    fn from(e: BridgeError) -> Self {
        match e {
            BridgeError::Auth(_) => Fail::Login("Сессия истекла или отклонена: войдите заново в приложении OpenSchool.".into()),
            BridgeError::Network(m) => Fail::Other(format!("Нет связи с Госуслугами: {m}")),
            BridgeError::Parse(m) => Fail::Other(format!("Госуслуги ответили неожиданно: {m}")),
        }
    }
}

fn main() {
    let code = match args::parse(std::env::args().skip(1)) {
        Err(e) => {
            eprintln!("openschool: {e}\nСправка: openschool help");
            2
        }
        Ok(o) => run(o),
    };
    std::process::exit(code)
}

fn run(o: Options) -> i32 {
    match o.command {
        Command::Help => {
            println!("{}", args::USAGE);
            return 0;
        }
        Command::Version => {
            println!("openschool {VERSION} (bridge {})", openschool_bridge::bridge_version());
            return 0;
        }
        _ => {}
    }
    openschool_bridge::set_app_version(VERSION.to_string());
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    match runtime.block_on(work(&o)) {
        Ok(text) => {
            println!("{text}");
            0
        }
        Err(Fail::Login(m)) => {
            eprintln!("openschool: {m}");
            3
        }
        Err(Fail::Other(m)) => {
            eprintln!("openschool: {m}");
            1
        }
    }
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).expect("serializable")
}

async fn work(o: &Options) -> Result<String, Fail> {
    let style = Style { color: o.color && !o.json && std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() };
    let (client, route) = connect(o.route).await?;
    let cookies = match store::load() {
        Ok(Some(c)) => c,
        Ok(None) => return Err(Fail::Login("Нет сохранённого входа: войдите в приложении OpenSchool.".into())),
        Err(e) => return Err(Fail::Other(format!("Хранилище секретов недоступно: {e}"))),
    };
    client.set_session(cookies);
    let all = client.students().await?;
    let student = pick(&all, o.student.as_deref())?;
    let today = Local::now().date_naive();

    Ok(match o.command {
        Command::Day(which) => {
            let date = match which {
                Day::Today => today,
                Day::Tomorrow => today.succ_opt().unwrap_or(today),
                Day::Date(d) => d,
            };
            let w = weeks(&client, &student.id, date, date).await?;
            if o.json {
                json(&serde_json::json!({ "date": date.to_string(), "lessons": w.lessons, "marks": w.marks, "homeworks": w.homeworks }))
            } else {
                view::day(date, &w.lessons, &w.marks, &w.homeworks, style)
            }
        }
        Command::Week(offset) => {
            let monday = today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64) + chrono::Duration::weeks(offset as i64);
            let sunday = monday + chrono::Duration::days(6);
            let w = weeks(&client, &student.id, monday, sunday).await?;
            if o.json {
                json(&serde_json::json!({ "from": monday.to_string(), "to": sunday.to_string(), "lessons": w.lessons, "marks": w.marks, "homeworks": w.homeworks }))
            } else {
                view::week(monday, &w.lessons, &w.marks, &w.homeworks, style)
            }
        }
        Command::Homework(days) => {
            let to = today + chrono::Duration::days(days as i64 - 1);
            let w = weeks(&client, &student.id, today, to).await?;
            let due: Vec<&Homework> = w.homeworks.iter().filter(|h| view::date_of(&h.due_date).is_some_and(|d| (today..=to).contains(&d))).collect();
            if o.json { json(&due) } else { view::homework(today, to, &w.homeworks, style) }
        }
        Command::Marks(number) => {
            let info = client.class_info(student.id.clone(), academic_year(today)).await?;
            let period = quarter(info.as_ref(), number, today)?;
            let (Some(from), Some(end)) = (view::date_of(&period.start_date), view::date_of(&period.end_date)) else {
                return Err(Fail::Other("Госуслуги прислали четверть без дат".into()));
            };
            // Marks of a quarter that is still running exist only up to today; later weeks are not asked for.
            let to = end.min(today).max(from);
            let w = weeks(&client, &student.id, from, to).await?;
            if o.json { json(&serde_json::json!({ "quarter": period, "marks": w.marks })) } else { view::marks(&period, &w.lessons, &w.marks, style) }
        }
        Command::Students => {
            if o.json { json(&all) } else { view::students(&all, &student.id, style) }
        }
        Command::Status => {
            let way = match &route {
                Route { direct: true, country: Some(c) } => format!("напрямую (системный маршрут выходит из {c})"),
                Route { direct: true, country: None } => "напрямую".to_string(),
                Route { direct: false, country: Some(c) } => format!("через системный маршрут ({c})"),
                Route { direct: false, country: None } => "через системный маршрут".to_string(),
            };
            let name = view::clean(&format!("{} {}", student.first_name, student.last_name));
            if o.json {
                json(&serde_json::json!({ "session": "ok", "student": student, "direct": route.direct, "country": route.country, "version": VERSION, "bridge": openschool_bridge::bridge_version() }))
            } else {
                format!("Вход: действует\nУченик: {name}\nК Госуслугам: {way}\nВерсии: OpenSchool {VERSION}, bridge {}", openschool_bridge::bridge_version())
            }
        }
        Command::Help | Command::Version => unreachable!("answered before any network"),
    })
}

/// The student by id or 1-based number in the account's list; the first one by default.
fn pick<'a>(all: &'a [Student], wanted: Option<&str>) -> Result<&'a Student, Fail> {
    let found = match wanted {
        None => all.first(),
        Some(w) => all.iter().find(|s| s.id == w).or_else(|| w.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).and_then(|i| all.get(i))),
    };
    found.ok_or_else(|| match wanted {
        None => Fail::Other("К этому аккаунту не привязан ученик.".into()),
        Some(w) => Fail::Other(format!("Нет ученика {w}: список — openschool students")),
    })
}

/// 1 September starts the school year: autumn to summer is one academic year, named by its first calendar year.
fn academic_year(d: NaiveDate) -> u32 {
    (if d.month() >= 8 { d.year() } else { d.year() - 1 }) as u32
}

/// The asked quarter, or the one that contains `today`, or the last one that has begun (holidays between quarters).
fn quarter(info: Option<&ClassInfo>, number: Option<u32>, today: NaiveDate) -> Result<Period, Fail> {
    let quarters = info.map(|i| i.quarters.clone()).unwrap_or_default();
    let started = |p: &&Period| view::date_of(&p.start_date).is_some_and(|d| d <= today);
    let found = match number {
        Some(n) => quarters.iter().find(|p| p.number == n),
        None => quarters.iter().filter(started).max_by_key(|p| p.start_date.clone()).or_else(|| quarters.first()),
    };
    found.cloned().ok_or_else(|| Fail::Other(match number {
        Some(n) => format!("В этом учебном году нет {n} четверти"),
        None => "Госуслуги не прислали четверти этого учебного года".into(),
    }))
}

#[derive(Default)]
struct Merged {
    lessons: Vec<Lesson>,
    marks: Vec<Mark>,
    homeworks: Vec<Homework>,
}

/// ISO weeks (year, number) that cover `from..=to`.
fn iso_weeks(from: NaiveDate, to: NaiveDate) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let mut d = from - chrono::Duration::days(from.weekday().num_days_from_monday() as i64);
    while d <= to {
        let w = d.iso_week();
        out.push((w.year() as u32, w.week()));
        d += chrono::Duration::weeks(1);
    }
    out
}

/// Everything of the weeks around `from..=to`, asked for at once. An answer can hold neighbouring weeks too: records are
/// kept once (by id), whatever their dates; the views pick their own days.
async fn weeks(client: &Arc<Client>, student: &str, from: NaiveDate, to: NaiveDate) -> Result<Merged, Fail> {
    let mut tasks = tokio::task::JoinSet::new();
    for (i, (year, week)) in iso_weeks(from, to).into_iter().enumerate() {
        let (client, student) = (client.clone(), student.to_string());
        tasks.spawn(async move { (i, client.week(student, year, week).await) });
    }
    let mut answers = Vec::new();
    while let Some(done) = tasks.join_next().await {
        let (i, answer) = done.map_err(|e| Fail::Other(e.to_string()))?;
        answers.push((i, answer?));
    }
    answers.sort_by_key(|(i, _)| *i); // the weeks in calendar order, whichever answered first
    let mut m = Merged::default();
    let (mut lessons, mut marks, mut homeworks) = (HashSet::new(), HashSet::new(), HashSet::new());
    for (_, w) in answers {
        m.lessons.extend(w.lessons.into_iter().filter(|x| lessons.insert(x.id.clone())));
        m.marks.extend(w.marks.into_iter().filter(|x| marks.insert(x.id.clone())));
        m.homeworks.extend(w.homeworks.into_iter().filter(|x| homeworks.insert(x.id.clone())));
    }
    Ok(m)
}

struct Route {
    direct: bool,
    country: Option<String>,
}

/// The app's network setting (`network.json` in its data folder): "auto" (default), "direct" or "system".
fn saved_mode() -> String {
    let file = dirs::data_dir().map(|d| d.join(APP_ID).join("network.json")).unwrap_or_default();
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("mode")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "auto".into())
}

/// The way to Gosuslugi, as the app decides it: Gosuslugi refuses foreign addresses, so in "auto" a system route that leaves
/// from abroad (a proxy) is skipped; an unknown country keeps the system route.
async fn connect(forced: args::Route) -> Result<(Arc<Client>, Route), Fail> {
    let (direct, country) = match forced {
        Some(d) => (d, None),
        None => match saved_mode().as_str() {
            "direct" => (true, None),
            "system" => (false, None),
            _ => {
                let probe = Client::new()?;
                let country = tokio::time::timeout(Duration::from_secs(10), probe.exit_country()).await.ok().and_then(Result::ok);
                (country.as_deref().is_some_and(|c| !c.eq_ignore_ascii_case("RU")), country)
            }
        },
    };
    let client = if direct { Client::direct()? } else { Client::new()? };
    Ok((Arc::new(client), Route { direct, country }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn the_app_id_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);
    }

    #[test]
    fn the_version_is_the_apps() {
        let cargo = include_str!("../../src-tauri/Cargo.toml");
        assert!(cargo.contains(&format!("\nversion = \"{VERSION}\"\n")), "{VERSION}");
    }

    #[test]
    fn weeks_cover_the_range_across_a_new_year() {
        assert_eq!(iso_weeks(d("2026-10-16"), d("2026-10-16")), vec![(2026, 42)]);
        assert_eq!(iso_weeks(d("2026-10-16"), d("2026-10-19")), vec![(2026, 42), (2026, 43)]);
        // 2026-12-31 is a Thursday of week 53; 2027-01-04 starts week 1 of 2027.
        assert_eq!(iso_weeks(d("2026-12-31"), d("2027-01-05")), vec![(2026, 53), (2027, 1)]);
    }

    #[test]
    fn academic_year_turns_in_august() {
        assert_eq!(academic_year(d("2026-10-16")), 2026);
        assert_eq!(academic_year(d("2027-05-20")), 2026);
        assert_eq!(academic_year(d("2027-08-01")), 2027);
    }

    fn info() -> ClassInfo {
        let p = |n, a: &str, b: &str| Period { number: n, start_date: a.into(), end_date: b.into() };
        ClassInfo {
            school_name: String::new(),
            class_number: String::new(),
            class_letter: String::new(),
            academic_year: 2026,
            quarters: vec![p(1, "2026-09-01", "2026-10-27"), p(2, "2026-11-05", "2026-12-28"), p(3, "2027-01-12", "2027-03-20"), p(4, "2027-03-30", "2027-05-26")],
        }
    }

    #[test]
    fn the_current_quarter_or_the_last_begun_one_in_the_holidays() {
        let q = |today: &str, n: Option<u32>| quarter(Some(&info()), n, d(today)).ok().map(|p| p.number);
        assert_eq!(q("2026-10-16", None), Some(1));
        assert_eq!(q("2026-11-01", None), Some(1), "autumn holidays: the quarter that just ended");
        assert_eq!(q("2026-11-05", None), Some(2));
        assert_eq!(q("2026-08-25", None), Some(1), "before school: the first one");
        assert_eq!(q("2026-10-16", Some(3)), Some(3));
        assert!(quarter(Some(&info()), Some(4), d("2026-10-16")).is_ok());
        assert!(quarter(None, None, d("2026-10-16")).is_err());
    }

    #[test]
    fn a_student_by_id_or_number() {
        let s = |id: &str| Student { id: id.into(), first_name: String::new(), last_name: String::new(), middle_name: String::new(), region: String::new() };
        let all = vec![s("a1"), s("b2")];
        let id = |w: Option<&str>| pick(&all, w).ok().map(|s| s.id.clone());
        assert_eq!(id(None).as_deref(), Some("a1"));
        assert_eq!(id(Some("b2")).as_deref(), Some("b2"));
        assert_eq!(id(Some("2")).as_deref(), Some("b2"));
        assert_eq!(id(Some("3")), None);
        assert_eq!(id(Some("0")), None);
        assert!(pick(&[], None).is_err());
    }
}
