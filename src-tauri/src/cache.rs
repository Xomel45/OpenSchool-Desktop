//! The last weeks that were loaded, kept on disk so the app still shows something when Gosuslugi cannot be reached.
//! One file per student and week under `<app_data>/week-cache/`; the file's modification time says when it was fetched.
//! The UI decides what to keep (it sends the week as JSON text); nothing here reads or interprets it. Wiped on logout.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Newest files kept in total.
const LIMIT: usize = 60;
/// A week is a few dozen kilobytes; anything near this is not a week.
const MAX_BYTES: usize = 2 * 1024 * 1024;

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("week-cache")).map_err(|e| e.to_string())
}

/// The folder name for a student id: letters, digits, `-` and `_` only, so an id can never point outside the cache.
fn safe(id: &str) -> String {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if s.is_empty() { "x".into() } else { s }
}

fn file(root: &Path, student: &str, year: u32, week: u32) -> PathBuf {
    root.join(safe(student)).join(format!("{year}-{week}.json"))
}

fn put_in(root: &Path, student: &str, year: u32, week: u32, json: &str) -> Result<(), String> {
    if json.len() > MAX_BYTES {
        return Err("week too big".into());
    }
    let f = file(root, student, year, week);
    fs::create_dir_all(f.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
    prune(root);
    Ok(())
}

fn prune(root: &Path) {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    if let Ok(students) = fs::read_dir(root) {
        for s in students.flatten() {
            if let Ok(weeks) = fs::read_dir(s.path()) {
                for w in weeks.flatten() {
                    if w.path().extension().is_some_and(|e| e == "json")
                        && let Ok(m) = w.metadata().and_then(|m| m.modified())
                    {
                        files.push((m, w.path()));
                    }
                }
            }
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, p) in files.into_iter().skip(LIMIT) {
        let _ = fs::remove_file(p);
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Cached {
    pub json: String,
    /// When it was fetched, Unix milliseconds.
    pub saved_at: u64,
}

fn get_from(root: &Path, student: &str, year: u32, week: u32) -> Option<Cached> {
    let f = file(root, student, year, week);
    let json = fs::read_to_string(&f).ok()?;
    let saved_at = f.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(Cached { json, saved_at })
}

#[tauri::command]
pub fn cache_put(app: AppHandle, student_id: String, year: u32, week: u32, json: String) -> Result<(), String> {
    put_in(&root(&app)?, &student_id, year, week, &json)
}

#[tauri::command]
pub fn cache_get(app: AppHandle, student_id: String, year: u32, week: u32) -> Option<Cached> {
    get_from(&root(&app).ok()?, &student_id, year, week)
}

/// How old each cached week is, in minutes, oldest last (names and contents stay private: for the `--ai-debug` report).
pub fn ages_minutes(app: &AppHandle) -> Vec<u64> {
    let now = std::time::SystemTime::now();
    let mut ages = Vec::new();
    if let Ok(root) = root(app)
        && let Ok(students) = fs::read_dir(root)
    {
        for s in students.flatten() {
            for w in fs::read_dir(s.path()).into_iter().flatten().flatten() {
                if let Ok(m) = w.metadata().and_then(|m| m.modified()) {
                    ages.push(now.duration_since(m).map(|d| d.as_secs() / 60).unwrap_or(0));
                }
            }
        }
    }
    ages.sort_unstable();
    ages
}

/// Forget everything (logout).
pub fn clear(app: &AppHandle) {
    if let Ok(r) = root(app) {
        let _ = fs::remove_dir_all(r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("openschool-cache-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_week_comes_back_as_it_was_put_with_its_time() {
        let d = dir("roundtrip");
        put_in(&d, "stu1", 2026, 41, r#"{"a":"б"}"#).unwrap();
        let got = get_from(&d, "stu1", 2026, 41).unwrap();
        assert_eq!(got.json, r#"{"a":"б"}"#);
        assert!(got.saved_at > 1_700_000_000_000, "a real time: {}", got.saved_at);
        assert!(get_from(&d, "stu1", 2026, 42).is_none() && get_from(&d, "other", 2026, 41).is_none());
        put_in(&d, "stu1", 2026, 41, "new").unwrap();
        assert_eq!(get_from(&d, "stu1", 2026, 41).unwrap().json, "new", "a newer copy replaces the older one");
    }

    #[test]
    fn a_student_id_cannot_leave_the_cache_folder() {
        assert_eq!(safe("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe("a b/c\\d"), "abcd");
        assert_eq!(safe("///"), "x");
        let d = dir("escape");
        put_in(&d, "../../outside", 2026, 1, "x").unwrap();
        assert!(!d.parent().unwrap().join("outside").exists());
        assert!(d.join("outside").join("2026-1.json").exists());
    }

    #[test]
    fn only_the_newest_files_are_kept_and_a_huge_week_is_refused() {
        let d = dir("prune");
        for w in 1..=(LIMIT as u32 + 5) {
            put_in(&d, "s", 2026, w, "x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let left = fs::read_dir(d.join("s")).unwrap().count();
        assert_eq!(left, LIMIT);
        assert!(get_from(&d, "s", 2026, 1).is_none() && get_from(&d, "s", 2026, LIMIT as u32 + 5).is_some(), "the oldest went, the newest stayed");
        assert!(put_in(&d, "s", 2026, 99, &"x".repeat(MAX_BYTES + 1)).is_err());
    }
}
