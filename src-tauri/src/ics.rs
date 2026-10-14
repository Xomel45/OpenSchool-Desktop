//! Export of the schedule as an iCalendar file (.ics) for Google Calendar, KDE, a phone, …
//! The page sends the lessons; times are written as local ("floating") times: the calendar shows them as they are in the diary.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize, Debug, Clone)]
pub struct IcsEvent {
    /// Stable id: importing the file again updates the same events instead of doubling them.
    pub uid: String,
    /// `YYYY-MM-DD HH:MM:SS`, as in the diary.
    pub start: String,
    pub end: String,
    pub summary: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub description: String,
}

/// TEXT value escaping (RFC 5545 3.3.11).
fn text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// `2026-10-14 08:30:00` -> `20261014T083000`; anything else is refused.
fn stamp(dt: &str) -> Option<String> {
    let b = dt.as_bytes();
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || b[13] != b':' {
        return None;
    }
    let digits: String = dt.chars().filter(char::is_ascii_digit).collect();
    (digits.len() >= 12).then(|| format!("{}T{}{}", &digits[..8], &digits[8..12], digits.get(12..14).unwrap_or("00")))
}

/// Lines are folded at 75 octets (a continuation starts with a space), never inside a UTF-8 character.
fn fold(line: &str, out: &mut String) {
    let mut len = 0;
    for c in line.chars() {
        let w = c.len_utf8();
        if len + w > 75 {
            out.push_str("\r\n ");
            len = 1;
        }
        out.push(c);
        len += w;
    }
    out.push_str("\r\n");
}

pub fn build(events: &[IcsEvent], now_utc: &str) -> String {
    let mut out = String::new();
    for l in ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenSchool//Schedule//RU", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Уроки (OpenSchool)"] {
        fold(l, &mut out);
    }
    for e in events {
        let (Some(start), Some(end)) = (stamp(&e.start), stamp(&e.end)) else { continue };
        fold("BEGIN:VEVENT", &mut out);
        let uid: String = e.uid.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
        fold(&format!("UID:{uid}@openschool"), &mut out);
        fold(&format!("DTSTAMP:{now_utc}"), &mut out);
        fold(&format!("DTSTART:{start}"), &mut out);
        fold(&format!("DTEND:{end}"), &mut out);
        fold(&format!("SUMMARY:{}", text(&e.summary)), &mut out);
        if !e.location.is_empty() {
            fold(&format!("LOCATION:{}", text(&e.location)), &mut out);
        }
        if !e.description.is_empty() {
            fold(&format!("DESCRIPTION:{}", text(&e.description)), &mut out);
        }
        fold("END:VEVENT", &mut out);
    }
    fold("END:VCALENDAR", &mut out);
    out
}

/// Ask where to save and write the file. `None` = cancelled.
#[tauri::command]
pub async fn export_ics(app: AppHandle, events: Vec<IcsEvent>, name: String) -> Result<Option<String>, String> {
    let now = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let body = build(&events, &now);
    let name = openschool_bridge::safe_file_name(if name.is_empty() { "uroki.ics".into() } else { name });
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app.dialog().file().set_title("Расписание в календарь").set_file_name(&name).add_filter("Календарь (iCalendar)", &["ics"]).blocking_save_file();
        let Some(path) = picked else { return Ok(None) };
        let mut path = path.into_path().map_err(|e| e.to_string())?;
        if path.extension().is_none() {
            path.set_extension("ics");
        }
        std::fs::write(&path, body).map_err(|e| e.to_string())?;
        Ok(Some(crate::diag::scrub(&path.to_string_lossy(), 300)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(summary: &str, description: &str) -> IcsEvent {
        IcsEvent { uid: "L-1/../x".into(), start: "2026-10-14 08:30:00".into(), end: "2026-10-14 09:10:00".into(), summary: summary.into(), location: "Каб. 21".into(), description: description.into() }
    }

    #[test]
    fn a_lesson_becomes_a_valid_event() {
        let s = build(&[ev("Алгебра", "Д/з: §5, №1; №2\nУчитель: Петров")], "20261014T120000Z");
        assert!(s.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
        assert!(s.ends_with("END:VCALENDAR\r\n"));
        assert!(s.contains("\r\nUID:L-1..x@openschool\r\n"), "uid limited to safe characters");
        assert!(s.contains("\r\nDTSTART:20261014T083000\r\nDTEND:20261014T091000\r\n"));
        assert!(s.contains("\r\nSUMMARY:Алгебра\r\n"));
        let unfolded = s.replace("\r\n ", "");
        assert!(unfolded.contains("DESCRIPTION:Д/з: §5\\, №1\\; №2\\nУчитель: Петров\r\n"), "{unfolded}");
        assert!(!s.split("\r\n").any(|l| l.contains('\n')), "no bare line feeds inside values");
    }

    #[test]
    fn long_lines_fold_at_75_bytes_without_breaking_letters() {
        let s = build(&[ev(&"Ж".repeat(100), "")], "20261014T120000Z");
        for line in s.split("\r\n") {
            assert!(line.len() <= 75, "{} bytes", line.len());
        }
        assert!(s.replace("\r\n ", "").contains(&format!("SUMMARY:{}", "Ж".repeat(100))));
    }

    #[test]
    fn bad_times_are_skipped() {
        let mut e = ev("X", "");
        e.start = "завтра".into();
        assert!(!build(&[e], "20261014T120000Z").contains("BEGIN:VEVENT"));
    }
}
