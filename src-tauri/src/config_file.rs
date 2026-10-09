//! Export / import of the look of the app as one `.cfg` file, which is an ordinary ZIP archive:
//!
//! * `config.json` - style, theme, accent colour and background settings (the UI builds and checks it);
//! * `background.<ext>` - the picture, GIF or video, when one is set.
//!
//! An imported archive is untrusted: only these two names are read, sizes are capped while reading
//! (the declared size is not believed) and the media extension must be on the same whitelist as the picker.

use std::io::{Cursor, Read, Write};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::background;

const CONFIG_NAME: &str = "config.json";
const MEDIA_PREFIX: &str = "background.";
const MAX_CONFIG: u64 = 64 * 1024;

pub struct Media {
    pub ext: String,
    pub bytes: Vec<u8>,
}

/// Build the archive in memory. Pictures and videos are already compressed, so they are only stored.
pub fn build_archive(config: &str, media: Option<&Media>) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let err = |e: zip::result::ZipError| e.to_string();
    zip.start_file(CONFIG_NAME, SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).map_err(err)?;
    zip.write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(m) = media {
        zip.start_file(format!("{MEDIA_PREFIX}{}", m.ext), SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true)).map_err(err)?;
        zip.write_all(&m.bytes).map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(err)?.into_inner())
}

/// Read `config.json` and the optional media out of an archive; anything else inside is ignored.
pub fn read_archive(data: &[u8]) -> Result<(String, Option<Media>), String> {
    let mut zip = ZipArchive::new(Cursor::new(data)).map_err(|_| "Это не файл настроек OpenSchool (не удалось открыть как архив)".to_string())?;
    let mut config = None;
    let mut media = None;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name == CONFIG_NAME {
            let mut buf = Vec::new();
            f.by_ref().take(MAX_CONFIG + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if buf.len() as u64 > MAX_CONFIG {
                return Err("Файл настроек слишком большой".into());
            }
            config = Some(String::from_utf8(buf).map_err(|_| "config.json не в UTF-8".to_string())?);
        } else if let Some(ext) = name.strip_prefix(MEDIA_PREFIX).and_then(background::clean_ext) {
            let mut buf = Vec::new();
            f.by_ref().take(background::MAX_BYTES as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if buf.len() > background::MAX_BYTES {
                return Err("Фон в архиве больше 300 МБ".into());
            }
            if media.is_some() {
                return Err("В архиве больше одного файла фона".into()); // never silently pick one of two
            }
            media = Some(Media { ext, bytes: buf });
        }
    }
    Ok((config.ok_or("В архиве нет config.json")?, media))
}

#[derive(Serialize)]
pub struct Imported {
    config: String,
    /// URL of the imported background, if the archive had one.
    background: Option<String>,
}

/// Ask where to save, then write the archive. `None` = the user cancelled.
#[tauri::command]
pub async fn export_config(app: AppHandle, config: String) -> Result<Option<String>, String> {
    let media = match background::stored_path(&app)? {
        Some(p) => {
            let ext = p.extension().and_then(|e| e.to_str()).and_then(background::clean_ext).ok_or("неизвестный формат фона")?;
            Some(Media { ext, bytes: std::fs::read(&p).map_err(|e| e.to_string())? })
        }
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let archive = build_archive(&config, media.as_ref())?;
        let picked = app.dialog().file().set_title("Экспорт настроек").set_file_name("openschool.cfg").add_filter("Настройки OpenSchool", &["cfg"]).blocking_save_file();
        let Some(path) = picked else { return Ok(None) };
        let mut path = path.into_path().map_err(|e| e.to_string())?;
        if path.extension().is_none() {
            path.set_extension("cfg");
        }
        std::fs::write(&path, archive).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ask for a file and read it. The background it carries replaces the current one. `None` = cancelled.
#[tauri::command]
pub async fn import_config(app: AppHandle) -> Result<Option<Imported>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app.dialog().file().set_title("Импорт настроек").add_filter("Настройки OpenSchool", &["cfg", "zip"]).blocking_pick_file();
        let Some(path) = picked else { return Ok(None) };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if size > background::MAX_BYTES as u64 + MAX_CONFIG + 4096 {
            return Err("Файл слишком большой".into());
        }
        let (config, media) = read_archive(&std::fs::read(&path).map_err(|e| e.to_string())?)?;
        let background = match media {
            Some(m) => Some(background::store(&app, &m.ext, &m.bytes)?),
            None => None,
        };
        Ok(Some(Imported { config, background }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_and_without_media() {
        let media = Media { ext: "mp4".into(), bytes: (0..=255u8).cycle().take(100_000).collect() };
        let a = build_archive("{\"a\":1}", Some(&media)).unwrap();
        assert_eq!(&a[..2], b"PK", "must be a real zip");
        if let Ok(p) = std::env::var("OPENSCHOOL_TEST_CFG") {
            std::fs::write(p, &a).unwrap(); // lets a script open the archive with ordinary zip tools
        }
        let (cfg, m) = read_archive(&a).unwrap();
        assert_eq!(cfg, "{\"a\":1}");
        let m = m.unwrap();
        assert_eq!((m.ext.as_str(), m.bytes == media.bytes), ("mp4", true));
        let (cfg, m) = read_archive(&build_archive("{}", None).unwrap()).unwrap();
        assert_eq!(cfg, "{}");
        assert!(m.is_none());
    }

    fn zip_with(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut z = ZipWriter::new(Cursor::new(Vec::new()));
        for (n, b) in entries {
            z.start_file(*n, SimpleFileOptions::default()).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap().into_inner()
    }

    #[test]
    fn foreign_entries_and_bad_media_are_ignored_or_rejected() {
        let a = zip_with(&[("config.json", b"{}".to_vec()), ("../evil.sh", b"x".to_vec()), ("background.exe", b"x".to_vec()), ("sub/config.json", b"{\"no\":1}".to_vec())]);
        let (cfg, m) = read_archive(&a).unwrap();
        assert_eq!(cfg, "{}");
        assert!(m.is_none());
        assert!(read_archive(&zip_with(&[("background.png", b"x".to_vec())])).is_err(), "no config.json");
        assert!(read_archive(&zip_with(&[("config.json", vec![b' '; 70_000])])).is_err(), "config too big");
        assert!(read_archive(b"not a zip at all").is_err());
        assert!(read_archive(&zip_with(&[("config.json", vec![0xff, 0xfe])])).is_err(), "not utf-8");
        let two = zip_with(&[("config.json", b"{}".to_vec()), ("background.png", b"x".to_vec()), ("background.mp4", b"y".to_vec())]);
        assert!(read_archive(&two).is_err(), "two backgrounds in one archive are refused, not silently resolved");
    }
}
