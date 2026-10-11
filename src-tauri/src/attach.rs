//! Homework attachments: the Bridge downloads the file (it checks the address, the size and the kind of answer, see
//! `bridge/src/download.rs`), this module saves it in the Downloads folder under a safe, free name and, for documents, pictures
//! and media, opens it with the system's default program. Programs, scripts and archives are only saved, never opened.

use std::io::Write;
use std::path::{Path, PathBuf};

use openschool_bridge::{attachment_file_name, can_open};
use serde::Serialize;
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

/// The system's default program for the file. The path is absolute and made by us; no shell is involved.
fn open_path(path: &Path) -> bool {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    match Command::new(program).arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait(); // not left as a zombie
            });
            true
        }
        Err(_) => false,
    }
}

#[derive(Serialize)]
pub struct Saved {
    /// Where the file is (the home folder is shown as `~`).
    path: String,
    opened: bool,
}

/// Download an attachment of a homework and open it (when it is a kind of file that is safe to open).
#[tauri::command]
pub async fn download_material(app: AppHandle, state: State<'_, AppState>, link: String, name: String) -> Result<Saved, String> {
    let file = crate::diag::timed("download", state.client().download(link, 0)).await.map_err(err)?;
    let dir = app.path().download_dir().or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads"))).map_err(|e| e.to_string())?.join("OpenSchool");
    let name = attachment_file_name(name, file.file_name.clone());
    let saved = tauri::async_runtime::spawn_blocking(move || save_file(&dir, &name, &file.bytes)).await.map_err(|e| e.to_string())?.map_err(|e| format!("не удалось сохранить: {e}"))?;
    let opened = can_open(saved.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) && open_path(&saved);
    Ok(Saved { path: crate::diag::scrub(&saved.to_string_lossy(), 300), opened })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_name_is_found_and_nothing_is_overwritten() {
        let dir = std::env::temp_dir().join(format!("openschool-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
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
}
