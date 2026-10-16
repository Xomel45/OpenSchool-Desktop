//! Text for the terminal. Pure functions over the bridge's models: no network, easy to test.
//!
//! Every text that came from the server goes through `clean`: a homework could otherwise carry terminal escape sequences.

use chrono::{Datelike, NaiveDate};
use openschool_bridge::{Homework, Lesson, Mark, Period, Student};

const WEEKDAYS: [&str; 7] = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const MONTHS: [&str; 12] = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

#[derive(Clone, Copy)]
pub struct Style {
    pub color: bool,
}

impl Style {
    fn paint(self, code: &str, s: &str) -> String {
        if self.color { format!("\x1b[{code}m{s}\x1b[0m") } else { s.to_string() }
    }
    fn bold(self, s: &str) -> String {
        self.paint("1", s)
    }
    fn dim(self, s: &str) -> String {
        self.paint("2", s)
    }
    /// A mark in the colours of the app: 5 green, 4 blue, 3 amber, 2 red, anything else as is.
    fn mark(self, value: &str) -> String {
        match value {
            "5" => self.paint("32", value),
            "4" => self.paint("34", value),
            "3" => self.paint("33", value),
            "2" | "1" => self.paint("31", value),
            _ => value.to_string(),
        }
    }
    fn average(self, x: f64) -> String {
        let code = if x >= 4.5 { "32" } else if x >= 3.5 { "34" } else if x >= 2.6 { "33" } else { "31" };
        self.paint(code, &fmt_avg(x))
    }
}

/// Server text made safe and single-line for a terminal: control characters (escape sequences, line breaks) become spaces.
pub fn clean(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pads by characters, not bytes (Cyrillic is two bytes per letter).
fn pad(s: &str, width: usize) -> String {
    let n = s.chars().count();
    if n >= width { s.to_string() } else { format!("{s}{}", " ".repeat(width - n)) }
}

pub fn date_title(d: NaiveDate) -> String {
    format!("{}, {} {}", WEEKDAYS[d.weekday().num_days_from_monday() as usize], d.day(), MONTHS[d.month0() as usize])
}

fn short_date(d: NaiveDate) -> String {
    format!("{} {}", d.day(), MONTHS[d.month0() as usize])
}

/// `YYYY-MM-DD` at the start of a server date or date-time.
pub fn date_of(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}

/// `HH:MM` of a `YYYY-MM-DD HH:MM:SS` time.
fn time_of(s: &str) -> &str {
    s.get(11..16).unwrap_or("")
}

/// Numeric value of a mark (`"5"`, `"4,5"`); letters and the like are not numbers.
fn mark_number(v: &str) -> Option<f64> {
    v.trim().replace(',', ".").parse::<f64>().ok().filter(|x| x.is_finite())
}

/// The average the app shows: of the numeric first values only.
pub fn average(marks: &[&Mark]) -> Option<f64> {
    let nums: Vec<f64> = marks.iter().filter_map(|m| mark_number(&m.value)).collect();
    (!nums.is_empty()).then(|| nums.iter().sum::<f64>() / nums.len() as f64)
}

/// Two decimals at most, comma, no trailing zeros: 4.25 → «4,25», 4.5 → «4,5», 4 → «4» (as the app writes it).
pub fn fmt_avg(x: f64) -> String {
    let r = (x * 100.0).round() / 100.0;
    let s = format!("{r:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.replace('.', ",")
}

fn mark_text(m: &Mark) -> String {
    match &m.value2 {
        Some(v2) if !v2.is_empty() => format!("{}/{}", clean(&m.value), clean(v2)),
        _ => clean(&m.value),
    }
}

/// The marks given in this lesson: by the lesson id, or (when the mark has none) by subject and date.
fn marks_of<'a>(lesson: &Lesson, marks: &'a [Mark]) -> Vec<&'a Mark> {
    let day = date_of(&lesson.start);
    marks
        .iter()
        .filter(|m| match &m.lesson_id {
            Some(id) => *id == lesson.id,
            None => m.subject_id == lesson.subject_id && date_of(&m.date) == day,
        })
        .collect()
}

fn homework_line(h: &Homework, style: Style) -> String {
    let text = clean(&h.description);
    let text = if text.is_empty() { style.dim("без текста") } else { text };
    let files = match h.materials.len() {
        0 => String::new(),
        n => style.dim(&format!(" (файлов: {n})")),
    };
    format!("  • {}: {text}{files}", style.bold(&clean(&h.subject_name)))
}

/// One day: the lessons in order with time, room and marks, then the homework due that day.
pub fn day(date: NaiveDate, lessons: &[Lesson], marks: &[Mark], homeworks: &[Homework], style: Style) -> String {
    let mut today: Vec<&Lesson> = lessons.iter().filter(|l| date_of(&l.start) == Some(date)).collect();
    today.sort_by(|a, b| a.start.cmp(&b.start));
    let due: Vec<&Homework> = homeworks.iter().filter(|h| date_of(&h.due_date) == Some(date)).collect();
    let mut out = vec![style.bold(&date_title(date))];
    if today.is_empty() {
        out.push(style.dim("  Уроков нет"));
    }
    let width = today.iter().map(|l| clean(&l.subject_name).chars().count()).max().unwrap_or(0);
    for (n, l) in today.iter().enumerate() {
        let room = clean(&l.room);
        let room = if room.is_empty() { String::new() } else { format!("  каб. {room}") };
        let mut tail: Vec<String> = marks_of(l, marks).iter().map(|m| style.mark(&mark_text(m))).collect();
        if l.absence.is_some() {
            tail.push(style.dim("н"));
        }
        let tail = if tail.is_empty() { String::new() } else { format!("  {}", tail.join(" ")) };
        let line = format!("  {:>2}  {}–{}  {}{room}{tail}", n + 1, time_of(&l.start), time_of(&l.end), pad(&clean(&l.subject_name), width));
        out.push(line.trim_end().to_string());
    }
    if !due.is_empty() {
        out.push("  Задано:".to_string());
        out.extend(due.iter().map(|h| format!("  {}", homework_line(h, style))));
    }
    out.join("\n")
}

/// Monday to Sunday; days without lessons and homework are left out, except to say the week is empty.
pub fn week(monday: NaiveDate, lessons: &[Lesson], marks: &[Mark], homeworks: &[Homework], style: Style) -> String {
    let sunday = monday + chrono::Duration::days(6);
    let mut out = vec![style.bold(&format!("Неделя {} – {}", short_date(monday), short_date(sunday)))];
    let busy = |d: NaiveDate| lessons.iter().any(|l| date_of(&l.start) == Some(d)) || homeworks.iter().any(|h| date_of(&h.due_date) == Some(d));
    let days: Vec<NaiveDate> = (0..7).map(|i| monday + chrono::Duration::days(i)).filter(|d| busy(*d)).collect();
    if days.is_empty() {
        out.push(style.dim("  Уроков нет (неделя ещё не опубликована или каникулы)"));
    }
    for d in days {
        out.push(String::new());
        out.push(day(d, lessons, marks, homeworks, style));
    }
    out.join("\n")
}

/// Homework due from `from` to `to` (inclusive), by day.
pub fn homework(from: NaiveDate, to: NaiveDate, homeworks: &[Homework], style: Style) -> String {
    let mut days: Vec<NaiveDate> = homeworks.iter().filter_map(|h| date_of(&h.due_date)).filter(|d| (from..=to).contains(d)).collect();
    days.sort();
    days.dedup();
    if days.is_empty() {
        return style.dim(&format!("Заданий до {} нет", short_date(to)));
    }
    let mut out = Vec::new();
    for d in days {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(style.bold(&date_title(d)));
        out.extend(homeworks.iter().filter(|h| date_of(&h.due_date) == Some(d)).map(|h| homework_line(h, style)));
    }
    out.join("\n")
}

/// Marks of the quarter by subject, in date order, with the average; subjects that had lessons but no marks get a dash.
pub fn marks(period: &Period, lessons: &[Lesson], marks: &[Mark], style: Style) -> String {
    let mut subjects: Vec<String> = lessons.iter().map(|l| clean(&l.subject_name)).chain(marks.iter().map(|m| clean(&m.subject_name))).collect();
    subjects.sort();
    subjects.dedup();
    let range = (date_of(&period.start_date), date_of(&period.end_date));
    let title = match range {
        (Some(a), Some(b)) => format!("{} четверть: {} – {}", period.number, short_date(a), short_date(b)),
        _ => format!("{} четверть", period.number),
    };
    let mut out = vec![style.bold(&title)];
    if subjects.is_empty() {
        out.push(style.dim("  Оценок пока нет"));
    }
    let width = subjects.iter().map(|s| s.chars().count()).max().unwrap_or(0);
    for s in subjects {
        let mut own: Vec<&Mark> = marks.iter().filter(|m| clean(&m.subject_name) == s).collect();
        own.sort_by(|a, b| a.date.cmp(&b.date));
        let list = if own.is_empty() { style.dim("–") } else { own.iter().map(|m| style.mark(&mark_text(m))).collect::<Vec<_>>().join(" ") };
        let avg = average(&own).map(|x| format!("  {} {}", style.dim("·"), style.average(x))).unwrap_or_default();
        out.push(format!("  {}  {list}{avg}", pad(&s, width)));
    }
    out.join("\n")
}

pub fn students(list: &[Student], chosen: &str, style: Style) -> String {
    list.iter()
        .enumerate()
        .map(|(i, s)| {
            let name = clean(&format!("{} {} {}", s.last_name, s.first_name, s.middle_name));
            let mark = if s.id == chosen { style.bold(" ← выбран") } else { String::new() };
            format!("  {}. {name}  {}{mark}", i + 1, style.dim(&format!("id {}", clean(&s.id))))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use openschool_bridge::{Absence, Material, Teacher};

    const PLAIN: Style = Style { color: false };

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn lesson(id: &str, subject: &str, start: &str) -> Lesson {
        Lesson {
            id: id.into(),
            subject_id: format!("s-{subject}"),
            subject_name: subject.into(),
            teacher: Teacher { first_name: String::new(), last_name: String::new(), patronymic: String::new() },
            start: start.into(),
            end: format!("{}{}", &start[..14], "45:00"),
            room: "214".into(),
            theme: None,
            absence: None,
        }
    }
    fn mark(subject: &str, value: &str, date: &str, lesson_id: Option<&str>) -> Mark {
        Mark {
            id: format!("m-{subject}-{date}-{value}"),
            subject_id: format!("s-{subject}"),
            subject_name: subject.into(),
            value: value.into(),
            value2: None,
            date: date.into(),
            work_type_code: "Ordinary".into(),
            work_type: String::new(),
            work_name: None,
            comment: None,
            lesson_id: lesson_id.map(String::from),
        }
    }
    fn hw(subject: &str, text: &str, due: &str, files: usize) -> Homework {
        Homework {
            id: format!("h-{subject}-{due}"),
            subject_id: None,
            subject_name: subject.into(),
            description: text.into(),
            issue_date: due.into(),
            due_date: due.into(),
            due_lesson_id: None,
            materials: (0..files).map(|i| Material { name: format!("f{i}"), link: String::new() }).collect(),
        }
    }

    #[test]
    fn server_text_cannot_steer_the_terminal() {
        assert_eq!(clean("\x1b[2J\x1b]0;title\x07Решить\r\n№ 5\t"), "[2J ]0;title Решить № 5");
        assert!(!clean("a\x1bb\u{9b}c").chars().any(char::is_control));
    }

    #[test]
    fn averages_as_the_app_writes_them() {
        let ms = [mark("А", "5", "2026-10-01", None), mark("А", "4", "2026-10-02", None), mark("А", "н", "2026-10-03", None), mark("А", "4", "2026-10-04", None)];
        let refs: Vec<&Mark> = ms.iter().collect();
        assert_eq!(fmt_avg(average(&refs).unwrap()), "4,33", "letters do not count");
        assert_eq!(fmt_avg(4.25), "4,25");
        assert_eq!(fmt_avg(4.5), "4,5");
        assert_eq!(fmt_avg(4.0), "4");
        assert_eq!(average(&[]), None);
    }

    #[test]
    fn a_day_lists_lessons_in_order_with_marks_absence_and_homework() {
        let lessons = vec![
            lesson("2", "Физика", "2026-10-16 09:25:00"),
            lesson("1", "Алгебра", "2026-10-16 08:30:00"),
            lesson("3", "Химия", "2026-10-17 08:30:00"),
        ];
        let mut absent = lesson("4", "Литература", "2026-10-16 10:20:00");
        absent.absence = Some(Absence { code: "Н".into(), description: String::new() });
        let lessons = [lessons, vec![absent]].concat();
        let marks = vec![mark("Алгебра", "5", "2026-10-16", Some("1")), mark("Физика", "4", "2026-10-16", None), mark("Физика", "2", "2026-10-15", None)];
        let hws = vec![hw("Алгебра", "№ 123", "2026-10-16", 2), hw("Химия", "§ 3", "2026-10-17", 0)];
        let text = day(d("2026-10-16"), &lessons, &marks, &hws, PLAIN);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "Пятница, 16 октября");
        assert!(lines[1].starts_with("   1  08:30–08:45  Алгебра") && lines[1].ends_with("каб. 214  5"), "{}", lines[1]);
        assert!(lines[2].contains("Физика") && lines[2].ends_with("  4"), "a mark without a lesson id goes by subject and date: {}", lines[2]);
        assert!(lines[3].contains("Литература") && lines[3].ends_with("  н"), "{}", lines[3]);
        assert!(text.contains("Алгебра: № 123 (файлов: 2)"));
        assert!(!text.contains("Химия"), "another day's lesson and homework stay out");
    }

    #[test]
    fn an_empty_day_and_an_empty_week_say_so() {
        assert!(day(d("2026-10-18"), &[], &[], &[], PLAIN).contains("Уроков нет"));
        assert!(week(d("2026-12-28"), &[], &[], &[], PLAIN).contains("Уроков нет"));
    }

    #[test]
    fn homework_by_day_within_the_range() {
        let hws = vec![hw("Б", "позже", "2026-10-20", 0), hw("А", "раньше", "2026-10-17", 0), hw("В", "вне", "2026-10-30", 0)];
        let text = homework(d("2026-10-16"), d("2026-10-22"), &hws, PLAIN);
        let a = text.find("раньше").unwrap();
        assert!(a < text.find("позже").unwrap());
        assert!(!text.contains("вне"));
        assert!(homework(d("2026-10-16"), d("2026-10-16"), &hws, PLAIN).contains("Заданий до 16 октября нет"));
    }

    #[test]
    fn quarter_marks_by_subject_with_average_and_a_dash_for_none() {
        let period = Period { number: 1, start_date: "2026-09-01".into(), end_date: "2026-10-27".into() };
        let lessons = vec![lesson("1", "Физкультура", "2026-10-16 08:30:00")];
        let marks = vec![mark("Алгебра", "4", "2026-10-02", None), mark("Алгебра", "5", "2026-09-10", None)];
        let text = marks_view(&period, &lessons, &marks);
        assert!(text.starts_with("1 четверть: 1 сентября – 27 октября"));
        assert!(text.contains("Алгебра      5 4  · 4,5"), "{text}");
        assert!(text.contains("Физкультура  –"), "{text}");
    }

    fn marks_view(p: &Period, l: &[Lesson], m: &[Mark]) -> String {
        marks(p, l, m, PLAIN)
    }

    #[test]
    fn colour_only_when_asked() {
        assert_eq!(Style { color: true }.mark("5"), "\x1b[32m5\x1b[0m");
        assert_eq!(PLAIN.mark("5"), "5");
    }
}
