//! Homework attachments: the Bridge downloads the file (it checks the address, the size and the kind of answer, see
//! `bridge/src/download.rs`), this module saves it in the Downloads folder under a safe, free name and, for documents, pictures
//! and media, opens it with the system's default program. Programs, scripts and archives are only saved, never opened.
//!
//! Every saved file is written down in `<app_data>/downloads.json` (which attachment, where it lies, its size), so the page can
//! mark attachments that are already downloaded and list them. The page names a file only by the id of its entry: a path from the
//! page is never opened or deleted. The list is forgotten at logout; the files themselves stay in the Downloads folder.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use openschool_bridge::{attachment_file_name, can_open};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::err;
use crate::AppState;

/// Create the file under a name that is free in `dir` ("a.pdf", "a (1).pdf", …). `create_new` makes the check and the creation one step.
fn save_file(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 0..1000 {
        let candidate = dir.join(if n == 0 { name.to_string() } else { format!("{stem} ({n}){ext}") });
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut f) => {
                f.write_all(bytes)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    f.set_permissions(std::fs::Permissions::from_mode(0o644))?; // never executable
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("too many files with this name"))
}

/// Start a program without a shell; the child is waited for in a thread so it is not left as a zombie.
fn spawn(mut cmd: std::process::Command) -> bool {
    use std::process::Stdio;
    match cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

/// The system's default program for the file or folder. The path is absolute and made by us.
pub(crate) fn open_path(path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    let mut cmd = std::process::Command::new(program);
    cmd.arg(path);
    spawn(cmd)
}

/// `file://` address of a path, every byte outside the plain set percent-encoded (for the file manager's D-Bus call).
fn file_uri(path: &Path) -> String {
    let mut out = String::from("file://");
    for &b in path.to_string_lossy().as_bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Open the folder with the file selected; where the file manager cannot select, just open the folder.
fn reveal_path(path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        // org.freedesktop.FileManager1 is answered by Dolphin, Nautilus, Nemo, Thunar, …
        let mut cmd = std::process::Command::new("dbus-send");
        cmd.args(["--session", "--print-reply", "--reply-timeout=3000", "--dest=org.freedesktop.FileManager1", "--type=method_call", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems"])
            .arg(format!("array:string:{}", file_uri(path)))
            .arg("string:");
        let ok = cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
        ok || path.parent().is_some_and(open_path)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer wants `/select,"C:\…"` as one piece; a Windows file name can not contain `"`.
        let mut cmd = std::process::Command::new("explorer.exe");
        cmd.raw_arg(format!("/select,\"{}\"", path.display()));
        spawn(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-R").arg(path);
        spawn(cmd)
    }
}

// ---------- the list of downloaded files ----------

/// One downloaded attachment as it is kept on disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    id: String,
    /// The attachment's address: how the page knows which attachment the file belongs to.
    link: String,
    /// Full path of the saved file.
    path: PathBuf,
    size: u64,
    /// When it was downloaded, Unix seconds.
    at: u64,
    #[serde(default)]
    subject: String,
    /// Due date of the homework, `YYYY-MM-DD`.
    #[serde(default)]
    due: String,
    #[serde(default)]
    hw: String,
}

/// What the page gets about a downloaded file: the path only for showing, with the home folder as `~`.
#[derive(Serialize, Debug)]
pub struct Download {
    id: String,
    link: String,
    name: String,
    shown: String,
    size: u64,
    at: u64,
    subject: String,
    due: String,
    hw: String,
    /// Opened by the system's program when asked (otherwise "Открыть" shows the file in its folder).
    openable: bool,
}

impl From<&Entry> for Download {
    fn from(e: &Entry) -> Self {
        let name = e.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Download { id: e.id.clone(), link: e.link.clone(), openable: can_open(name.clone()), name, shown: crate::diag::scrub(&e.path.to_string_lossy(), 300), size: e.size, at: e.at, subject: e.subject.clone(), due: e.due.clone(), hw: e.hw.clone() }
    }
}

/// One read-change-write of the list at a time.
static LIST_LOCK: Mutex<()> = Mutex::new(());

fn list_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("downloads.json")).map_err(|e| e.to_string())
}

/// A broken or missing list is an empty list (the files are still in the folder; only the marks are lost).
fn read_list(file: &Path) -> Vec<Entry> {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_list(file: &Path, list: &[Entry]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(list).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, file)
}

/// Entries whose file was deleted or moved away by the user are dropped.
fn prune(list: Vec<Entry>) -> Vec<Entry> {
    list.into_iter().filter(|e| e.path.is_file()).collect()
}

/// Lock the list, read it without the gone files, let `f` change it, write it back when it changed.
fn with_list<T>(file: &Path, f: impl FnOnce(&mut Vec<Entry>) -> T) -> std::io::Result<T> {
    let _guard = LIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let before = read_list(file);
    let mut list = prune(before.clone());
    let out = f(&mut list);
    if list != before {
        write_list(file, &list)?;
    }
    Ok(out)
}

fn new_id(path: &Path, at: u64) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    at.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The entry with this id (the only way the page can point at a file).
fn find(app: &AppHandle, id: &str) -> Result<Entry, String> {
    let file = list_file(app)?;
    with_list(&file, |l| l.iter().find(|e| e.id == id).cloned()).map_err(|e| e.to_string())?.ok_or_else(|| "Файла больше нет: его удалили или переместили.".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Saved {
    file: Download,
    opened: bool,
}

/// Download an attachment of a homework, write it down in the list and, when `open` is set and the kind of file is safe, open it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_material(app: AppHandle, state: State<'_, AppState>, link: String, name: String, open: Option<bool>, subject: Option<String>, due: Option<String>, hw: Option<String>) -> Result<Saved, String> {
    let file = crate::diag::timed("download", state.client().download(link.clone(), 0)).await.map_err(err)?;
    let dir = app.path().download_dir().or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads"))).map_err(|e| e.to_string())?.join("OpenSchool");
    let name = attachment_file_name(name, file.file_name.clone());
    let size = file.bytes.len() as u64;
    let saved = blocking(move || save_file(&dir, &name, &file.bytes)).await?.map_err(|e| format!("не удалось сохранить: {e}"))?;
    let at = now();
    let entry = Entry { id: new_id(&saved, at), link, path: saved.clone(), size, at, subject: subject.unwrap_or_default(), due: due.unwrap_or_default(), hw: hw.unwrap_or_default() };
    let list = list_file(&app)?;
    let e2 = entry.clone();
    // A failed list write is not a failed download: the file is saved, only the "скачан" mark is missing.
    if let Err(e) = blocking(move || with_list(&list, |l| l.push(e2))).await? {
        eprintln!("could not write the downloads list: {e}");
    }
    let opened = open.unwrap_or(true) && can_open(saved.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) && open_path(&saved);
    Ok(Saved { file: Download::from(&entry), opened })
}

/// The downloaded files, newest first.
#[tauri::command]
pub async fn list_downloads(app: AppHandle) -> Result<Vec<Download>, String> {
    let file = list_file(&app)?;
    let mut list = blocking(move || with_list(&file, |l| l.clone())).await?.map_err(|e| e.to_string())?;
    list.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(list.iter().map(Download::from).collect())
}

/// Open a downloaded file with the system's program; kinds that are never opened are shown in their folder instead.
/// Answers `true` when the file was opened, `false` when its folder was shown.
#[tauri::command]
pub async fn open_download(app: AppHandle, id: String) -> Result<bool, String> {
    let e = find(&app, &id)?;
    let name = e.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if can_open(name) {
        if open_path(&e.path) {
            return Ok(true);
        }
        return Err("Не нашлась программа, чтобы открыть файл.".into());
    }
    blocking(move || reveal_path(&e.path)).await?;
    Ok(false)
}

#[tauri::command]
pub async fn reveal_download(app: AppHandle, id: String) -> Result<(), String> {
    let e = find(&app, &id)?;
    if blocking(move || reveal_path(&e.path)).await? { Ok(()) } else { Err("Не удалось открыть папку.".into()) }
}

/// Delete the file from the disk and from the list.
#[tauri::command]
pub async fn delete_download(app: AppHandle, id: String) -> Result<(), String> {
    let file = list_file(&app)?;
    blocking(move || delete_in(&file, &id)).await?
}

fn delete_in(file: &Path, id: &str) -> Result<(), String> {
    with_list(file, |l| {
        let Some(i) = l.iter().position(|e| e.id == id) else { return Err("Файла больше нет: его удалили или переместили.".to_string()) };
        match std::fs::remove_file(&l[i].path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Не удалось удалить: {e}")),
        }
        l.remove(i);
        Ok(())
    })
    .map_err(|e| e.to_string())?
}

/// The Downloads/OpenSchool folder itself (created when missing, so there is something to show).
#[tauri::command]
pub async fn open_downloads_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.path().download_dir().or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads"))).map_err(|e| e.to_string())?.join("OpenSchool");
    let _ = std::fs::create_dir_all(&dir);
    if open_path(&dir) { Ok(()) } else { Err("Не удалось открыть папку.".into()) }
}

/// Forget the list (logout). The files stay where the user can see them.
pub fn clear(app: &AppHandle) {
    if let Ok(f) = list_file(app) {
        let _guard = LIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _ = std::fs::remove_file(f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("openschool-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_free_name_is_found_and_nothing_is_overwritten() {
        let dir = dir("names");
        let a = save_file(&dir, "a.pdf", b"one").unwrap();
        let b = save_file(&dir, "a.pdf", b"two").unwrap();
        let c = save_file(&dir, "noext", b"3").unwrap();
        let d = save_file(&dir, "noext", b"4").unwrap();
        assert_eq!([a.file_name().unwrap(), b.file_name().unwrap(), c.file_name().unwrap(), d.file_name().unwrap()], ["a.pdf", "a (1).pdf", "noext", "noext (1)"]);
        assert_eq!(std::fs::read(&a).unwrap(), b"one", "the first file is untouched");
        assert!(a.parent() == Some(dir.as_path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o111, 0, "never executable");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn entry(d: &Path, name: &str, at: u64) -> Entry {
        let path = save_file(d, name, b"x").unwrap();
        Entry { id: new_id(&path, at), link: format!("https://example.test/{name}"), path, size: 1, at, subject: "S".into(), due: "2026-10-14".into(), hw: "H1".into() }
    }

    #[test]
    fn the_list_survives_a_restart_and_forgets_files_the_user_removed() {
        let d = dir("list");
        let list = d.join("data/downloads.json");
        let (a, b) = (entry(&d, "a.pdf", 1), entry(&d, "b.zip", 2));
        with_list(&list, |l| l.extend([a.clone(), b.clone()])).unwrap();
        assert_eq!(read_list(&list), vec![a.clone(), b.clone()], "written to disk as it was");
        std::fs::remove_file(&b.path).unwrap(); // deleted in the file manager
        let now = with_list(&list, |l| l.clone()).unwrap();
        assert_eq!(now, vec![a.clone()]);
        assert_eq!(read_list(&list), vec![a], "the gone file is dropped from the disk copy too");
        std::fs::write(&list, b"{broken").unwrap();
        assert!(with_list(&list, |l| l.clone()).unwrap().is_empty(), "a broken list is an empty list, not an error");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn delete_removes_the_file_and_the_entry_and_only_by_a_known_id() {
        let d = dir("delete");
        let list = d.join("downloads.json");
        let (a, b) = (entry(&d, "a.pdf", 1), entry(&d, "b.pdf", 2));
        with_list(&list, |l| l.extend([a.clone(), b.clone()])).unwrap();
        assert!(delete_in(&list, "no-such-id").is_err());
        assert!(a.path.is_file() && b.path.is_file(), "an unknown id deletes nothing");
        delete_in(&list, &a.id).unwrap();
        assert!(!a.path.exists() && b.path.is_file());
        assert_eq!(read_list(&list), vec![b]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_file_manager_address_is_percent_encoded() {
        assert_eq!(file_uri(Path::new("/home/u/Загрузки/OpenSchool/a b&c#.pdf")), "file:///home/u/%D0%97%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B8/OpenSchool/a%20b%26c%23.pdf");
    }
}
