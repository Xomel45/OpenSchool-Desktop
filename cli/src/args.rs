//! Command line: one command and a few options, no parser crate.

use chrono::NaiveDate;

pub const USAGE: &str = "\
openschool: «Моя школа» в терминале (вход берётся из приложения OpenSchool)

Использование: openschool [команда] [параметры]

Команды:
  today              уроки, оценки и задания на сегодня (по умолчанию)
  tomorrow           то же на завтра
  day ГГГГ-ММ-ДД     то же на дату
  week [+N|-N]       неделя: 0 — текущая, +1 — следующая, -1 — прошлая
  hw [ДНЕЙ]          домашние задания на ближайшие дни (7)
  marks [ЧЕТВЕРТЬ]   оценки и средние за четверть (текущая)
  students           ученики аккаунта
  status             вход, маршрут до Госуслуг, версии
  help, version

Параметры:
  --json             данные в JSON вместо текста
  --student ID|N     ученик по id или номеру из `students` (по умолчанию первый)
  --direct           к Госуслугам без прокси
  --system           через системный прокси
  --no-color         без цвета (так же NO_COLOR=1)

Коды выхода: 0 — готово, 1 — ошибка, 2 — неверная команда, 3 — нужно войти в приложении.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Day {
    Today,
    Tomorrow,
    Date(NaiveDate),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Day(Day),
    /// Offset from the current week.
    Week(i32),
    /// How many days from today.
    Homework(u32),
    /// Quarter number; `None` = the current one.
    Marks(Option<u32>),
    Students,
    Status,
    Help,
    Version,
}

/// `Some(true)`: straight to Gosuslugi, `Some(false)`: through the system proxy, `None`: as the app is set up.
pub type Route = Option<bool>;

#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub command: Command,
    pub json: bool,
    pub student: Option<String>,
    pub route: Route,
    pub color: bool,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut words = Vec::new();
    let mut o = Options { command: Command::Day(Day::Today), json: false, student: None, route: None, color: true };
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => o.json = true,
            "--no-color" => o.color = false,
            "--direct" => o.route = Some(true),
            "--system" => o.route = Some(false),
            "--student" => o.student = Some(it.next().ok_or("--student: укажите id или номер ученика")?),
            "-h" | "--help" => words.insert(0, "help".to_string()),
            "-V" | "--version" => words.insert(0, "version".to_string()),
            // A negative offset (`week -1`) is a value, not an option.
            s if s.starts_with('-') && s.parse::<i32>().is_err() => return Err(format!("неизвестный параметр {s}")),
            _ => words.push(a),
        }
    }
    let mut words = words.into_iter();
    let Some(cmd) = words.next() else { return Ok(o) };
    let arg = words.next();
    if let Some(extra) = words.next() {
        return Err(format!("лишнее: {extra}"));
    }
    let no_arg = |c: Command| if arg.is_some() { Err(format!("{cmd}: без значений")) } else { Ok(c) };
    o.command = match cmd.as_str() {
        "today" => no_arg(Command::Day(Day::Today))?,
        "tomorrow" => no_arg(Command::Day(Day::Tomorrow))?,
        "day" => {
            let s = arg.ok_or("day: укажите дату ГГГГ-ММ-ДД")?;
            Command::Day(Day::Date(NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_err(|_| format!("day: не дата: {s}"))?))
        }
        "week" => Command::Week(match arg {
            None => 0,
            Some(s) => s.trim_start_matches('+').parse().ok().filter(|n: &i32| n.abs() <= 60).ok_or(format!("week: смещение от -60 до +60, а не {s}"))?,
        }),
        "hw" => Command::Homework(match arg {
            None => 7,
            Some(s) => s.parse().ok().filter(|n| (1..=60).contains(n)).ok_or(format!("hw: число дней от 1 до 60, а не {s}"))?,
        }),
        "marks" => Command::Marks(match arg {
            None => None,
            Some(s) => Some(s.parse().ok().filter(|n| (1..=4).contains(n)).ok_or(format!("marks: четверть от 1 до 4, а не {s}"))?),
        }),
        "students" => no_arg(Command::Students)?,
        "status" => no_arg(Command::Status)?,
        "help" => Command::Help,
        "version" => Command::Version,
        other => return Err(format!("неизвестная команда {other}")),
    };
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Result<Options, String> {
        parse(s.split_whitespace().map(String::from))
    }

    #[test]
    fn no_command_means_today() {
        assert_eq!(p("").unwrap().command, Command::Day(Day::Today));
        assert_eq!(p("--json").unwrap(), Options { command: Command::Day(Day::Today), json: true, student: None, route: None, color: true });
    }

    #[test]
    fn commands_and_their_values() {
        assert_eq!(p("tomorrow").unwrap().command, Command::Day(Day::Tomorrow));
        assert_eq!(p("day 2026-10-16").unwrap().command, Command::Day(Day::Date(NaiveDate::from_ymd_opt(2026, 10, 16).unwrap())));
        assert_eq!(p("week").unwrap().command, Command::Week(0));
        assert_eq!(p("week +2").unwrap().command, Command::Week(2));
        assert_eq!(p("week -1").unwrap().command, Command::Week(-1), "a negative offset is not an option");
        assert_eq!(p("hw").unwrap().command, Command::Homework(7));
        assert_eq!(p("hw 3").unwrap().command, Command::Homework(3));
        assert_eq!(p("marks").unwrap().command, Command::Marks(None));
        assert_eq!(p("marks 2").unwrap().command, Command::Marks(Some(2)));
        assert_eq!(p("status --help").unwrap().command, Command::Help, "--help wins");
    }

    #[test]
    fn options_anywhere() {
        let o = p("--student 2 marks --direct --no-color").unwrap();
        assert_eq!((o.command, o.student.as_deref(), o.route, o.color), (Command::Marks(None), Some("2"), Some(true), false));
        assert_eq!(p("week --system").unwrap().route, Some(false));
    }

    #[test]
    fn mistakes_are_refused_with_a_reason() {
        for bad in ["dya", "day", "day 16.10.2026", "week x", "week 99", "hw 0", "hw 61", "marks 5", "today 1", "hw 1 2", "--nope", "--student"] {
            assert!(p(bad).is_err(), "{bad}");
        }
    }
}
