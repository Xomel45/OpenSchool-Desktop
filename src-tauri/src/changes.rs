//! «Замены»: what changed in the timetable of the coming days since the last background check.
//!
//! The check keeps a snapshot of the lessons of today and the next 7 days (id, subject, start, room). The next check compares:
//! a lesson gone and another one at the same time = «Замена»; gone alone = «Урок отменён»; a new one = «Новый урок»; the same
//! lesson at another time or in another room = «Перенос» / «Кабинет». Days that were not published before say nothing (a new
//! week is not a change), and a day whose lessons all vanished says nothing either (an empty answer of the server looks the same).

use std::collections::BTreeMap;

use openschool_bridge::Week;
use serde::{Deserialize, Serialize};

use crate::news::{Event, Kind};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LessonSnap {
    pub id: String,
    pub subject: String,
    /// "09:25"
    pub start: String,
    pub room: String,
}

/// Date (`YYYY-MM-DD`) -> its lessons, by start time.
pub type Snapshot = BTreeMap<String, Vec<LessonSnap>>;

/// The lessons of `from..=to` (dates as `YYYY-MM-DD`) in the weeks at hand; days without lessons are left out.
pub fn snapshot(weeks: &[Week], from: &str, to: &str) -> Snapshot {
    let mut out: Snapshot = BTreeMap::new();
    for l in weeks.iter().flat_map(|w| &w.lessons) {
        let Some(date) = l.start.get(..10) else { continue };
        if date < from || date > to {
            continue;
        }
        let day = out.entry(date.to_string()).or_default();
        if !day.iter().any(|x| x.id == l.id) {
            day.push(LessonSnap { id: l.id.clone(), subject: l.subject_name.clone(), start: l.start.get(11..16).unwrap_or("").to_string(), room: l.room.clone() });
        }
    }
    for day in out.values_mut() {
        day.sort_by(|a, b| a.start.cmp(&b.start));
    }
    out
}

const MONTHS: [&str; 12] = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

fn day_text(date: &str) -> String {
    let m: usize = date.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(0);
    let d: u32 = date.get(8..10).and_then(|s| s.parse().ok()).unwrap_or(0);
    if (1..=12).contains(&m) { format!("{d} {}", MONTHS[m - 1]) } else { date.to_string() }
}

fn hm(s: &str) -> &str {
    s.strip_prefix('0').unwrap_or(s)
}

fn room(r: &str) -> String {
    if r.trim().is_empty() { "без кабинета".into() } else { format!("каб. {r}") }
}

fn ev(key: String, subject: &str, detail: String, date: &str) -> Event {
    Event { key, kind: Kind::Change, subject: subject.to_string(), value: None, detail, date: date.to_string() }
}

/// What changed from `old` to `new` on the days from `today` on that both know.
pub fn changes(old: &Snapshot, new: &Snapshot, today: &str) -> Vec<Event> {
    let mut out = Vec::new();
    for (date, now) in new.range(today.to_string()..) {
        let Some(before) = old.get(date) else { continue }; // not published before: nothing to compare
        let when = day_text(date);
        let mut gone: Vec<&LessonSnap> = before.iter().filter(|b| !now.iter().any(|n| n.id == b.id)).collect();
        let mut came: Vec<&LessonSnap> = now.iter().filter(|n| !before.iter().any(|b| b.id == n.id)).collect();
        // gone + came at the same time = a substitution
        let mut i = 0;
        while i < gone.len() {
            if let Some(j) = came.iter().position(|c| c.start == gone[i].start) {
                let (g, c) = (gone.remove(i), came.remove(j));
                if g.subject != c.subject {
                    out.push(ev(format!("c:{date}:{}:sub:{}>{}", c.start, g.subject, c.subject), &c.subject, format!("Замена: {} → {}, {when}, {}", g.subject, c.subject, hm(&c.start)), date));
                } else if g.room != c.room {
                    out.push(ev(format!("c:{date}:{}:room:{}", c.start, c.room), &c.subject, format!("Кабинет: {} → {}, {when}, {}", room(&g.room), room(&c.room), hm(&c.start)), date));
                }
                continue;
            }
            i += 1;
        }
        for g in gone {
            out.push(ev(format!("c:{date}:{}:off:{}", g.start, g.subject), &g.subject, format!("Урок отменён: {when}, {}", hm(&g.start)), date));
        }
        for c in came {
            out.push(ev(format!("c:{date}:{}:new:{}", c.start, c.subject), &c.subject, format!("Новый урок: {when}, {}", hm(&c.start)), date));
        }
        for n in now {
            if let Some(b) = before.iter().find(|b| b.id == n.id) {
                if b.start != n.start {
                    out.push(ev(format!("c:{date}:{}:move:{}", n.start, n.id), &n.subject, format!("Перенос: {} → {}, {when}", hm(&b.start), hm(&n.start)), date));
                } else if b.room != n.room {
                    out.push(ev(format!("c:{date}:{}:room:{}", n.start, n.room), &n.subject, format!("Кабинет: {} → {}, {when}, {}", room(&b.room), room(&n.room), hm(&n.start)), date));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(days: &[(&str, &[(&str, &str, &str, &str)])]) -> Snapshot {
        days.iter().map(|(d, ls)| (d.to_string(), ls.iter().map(|(id, s, t, r)| LessonSnap { id: id.to_string(), subject: s.to_string(), start: t.to_string(), room: r.to_string() }).collect())).collect()
    }

    fn details(e: &[Event]) -> Vec<String> {
        e.iter().map(|e| format!("{}: {}", e.subject, e.detail)).collect()
    }

    #[test]
    fn substitution_cancel_new_move_and_room_are_told() {
        let old = snap(&[("2026-10-15", &[("1", "Алгебра", "08:30", "21"), ("2", "Физика", "09:25", "5"), ("3", "Химия", "10:20", "7"), ("4", "Труд", "11:15", "1")])]);
        let new = snap(&[("2026-10-15", &[("1", "Алгебра", "08:30", "34"), ("9", "История", "09:25", "5"), ("4", "Труд", "12:10", "1"), ("8", "ИЗО", "13:05", "2")])]);
        assert_eq!(
            details(&changes(&old, &new, "2026-10-15")),
            vec![
                "История: Замена: Физика → История, 15 октября, 9:25",
                "Химия: Урок отменён: 15 октября, 10:20",
                "ИЗО: Новый урок: 15 октября, 13:05",
                "Алгебра: Кабинет: каб. 21 → каб. 34, 15 октября, 8:30",
                "Труд: Перенос: 11:15 → 12:10, 15 октября",
            ]
        );
    }

    #[test]
    fn new_weeks_vanished_days_and_the_past_say_nothing() {
        let old = snap(&[("2026-10-14", &[("1", "A", "08:30", "")]), ("2026-10-15", &[("2", "B", "08:30", "")])]);
        let new = snap(&[("2026-10-14", &[("5", "C", "08:30", "")]), ("2026-10-20", &[("3", "D", "08:30", "")])]);
        // 14th is before today, 15th vanished completely (not in new), 20th was not published before
        assert!(changes(&old, &new, "2026-10-15").is_empty());
        assert!(changes(&old, &old, "2026-10-14").is_empty(), "nothing changed: nothing said");
    }

    #[test]
    fn the_keys_are_stable_for_the_same_change() {
        let old = snap(&[("2026-10-15", &[("2", "Физика", "09:25", "5")])]);
        let new = snap(&[("2026-10-15", &[("9", "История", "09:25", "5")])]);
        assert_eq!(changes(&old, &new, "2026-10-15")[0].key, changes(&old, &new, "2026-10-15")[0].key);
        assert_eq!(changes(&old, &new, "2026-10-15")[0].kind, Kind::Change);
    }
}
