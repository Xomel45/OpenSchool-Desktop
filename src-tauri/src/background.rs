//! The user's own background (picture, GIF or video): one file kept in the app data directory (`bg-<millis>.<ext>`).
//!
//! The web view gets it from a tiny HTTP server bound to 127.0.0.1 that serves only that file (random token in the path,
//! range requests supported). Tauri's `asset:` protocol was tried first: WebKitGTK shows pictures from it but refuses
//! videos (MediaError 4), while plain HTTP is the path every web view plays video from.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{ipc::InvokeBody, AppHandle, Manager};

/// What the web view can play without extra codecs on every platform we target.
const EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "webm"];
pub const MAX_BYTES: usize = 300 * 1024 * 1024;

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("background"))
}

/// The extension, lower case, if it is one we accept.
pub fn clean_ext(raw: &str) -> Option<String> {
    let ext = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

fn remove_all(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("bg") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn stored_file(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.is_file()
            && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("bg"))
            && p.extension().is_some_and(|x| EXTENSIONS.contains(&x.to_string_lossy().to_ascii_lowercase().as_str()))
    })
}

// ---------- the local file server ----------

struct Server {
    port: u16,
    token: String,
    file: Mutex<Option<PathBuf>>,
}

static SERVER: OnceLock<Server> = OnceLock::new();

fn random_token() -> String {
    let mut s = String::new();
    for _ in 0..2 {
        // RandomState is keyed from the OS random generator.
        s.push_str(&format!("{:016x}", RandomState::new().build_hasher().finish()));
    }
    s
}

fn server() -> Result<&'static Server, String> {
    if let Some(s) = SERVER.get() {
        return Ok(s);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let s = SERVER.get_or_init(|| Server { port, token: random_token(), file: Mutex::new(None) });
    // If two callers raced, the loser's listener is simply dropped; only the winner's port is announced.
    if s.port == port {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let _ = handle(stream);
                });
            }
        });
    }
    Ok(s)
}

/// Point the server at `file` and return the URL the web view should use.
fn publish(file: &Path) -> Result<String, String> {
    let s = server()?;
    *s.file.lock().map_err(|e| e.to_string())? = Some(file.to_path_buf());
    let name = file.file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    Ok(format!("http://127.0.0.1:{}/{}/{}", s.port, s.token, name))
}

/// `Range: bytes=a-b`, `bytes=a-`, `bytes=-n`. `None` = not satisfiable.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

fn respond(stream: &mut TcpStream, status: &str, extra: &str, len: u64) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n{extra}Content-Length: {len}\r\nConnection: close\r\n\r\n")
}

fn handle(mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk)?;
        if n == 0 || buf.len() > 16 * 1024 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = text.lines();
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let range = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("range").then(|| v.to_string())
    });

    let Some(s) = SERVER.get() else { return respond(&mut stream, "503 Service Unavailable", "", 0) };
    let file = s.file.lock().ok().and_then(|f| f.clone());
    let allowed = file.as_ref().and_then(|f| f.file_name()).and_then(|n| n.to_str()).map(|n| format!("/{}/{}", s.token, n));
    let (Some(file), Some(allowed)) = (file, allowed) else { return respond(&mut stream, "404 Not Found", "", 0) };
    if !(method == "GET" || method == "HEAD") || path != allowed {
        return respond(&mut stream, "404 Not Found", "", 0);
    }
    let Ok(mut f) = std::fs::File::open(&file) else { return respond(&mut stream, "404 Not Found", "", 0) };
    let len = f.metadata()?.len();
    let ct = content_type(&file);
    let (status, start, end, extra) = match range.as_deref() {
        None => ("200 OK", 0, len.saturating_sub(1), format!("Content-Type: {ct}\r\nAccept-Ranges: bytes\r\n")),
        Some(r) => match parse_range(r, len) {
            Some((a, b)) => ("206 Partial Content", a, b, format!("Content-Type: {ct}\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {a}-{b}/{len}\r\n")),
            None => return respond(&mut stream, "416 Range Not Satisfiable", &format!("Content-Range: bytes */{len}\r\n"), 0),
        },
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };
    respond(&mut stream, status, &extra, body_len)?;
    if method == "HEAD" || body_len == 0 {
        return Ok(());
    }
    f.seek(SeekFrom::Start(start))?;
    let mut left = body_len;
    let mut data = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = data.len().min(left as usize);
        let n = f.read(&mut data[..want])?;
        if n == 0 {
            break;
        }
        stream.write_all(&data[..n])?; // the player closing the connection (seeking) ends here quietly
        left -= n as u64;
    }
    Ok(())
}

// ---------- commands ----------

/// Store the picked file (raw request body, extension in the `ext` header) and return the URL to show it from.
#[tauri::command]
pub async fn set_background(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let ext = request
        .headers()
        .get("ext")
        .and_then(|v| v.to_str().ok())
        .and_then(clean_ext)
        .ok_or("Этот формат не поддерживается. Подойдут: PNG, JPG, WebP, GIF, AVIF, MP4, WebM")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("файл не получен".into()) };
    if bytes.is_empty() {
        return Err("файл пустой".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("Файл больше 300 МБ".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || store(&app, &ext, &bytes)).await.map_err(|e| e.to_string())?
}

/// Replace the stored background with `bytes` (extension already checked) and return the URL to show it from.
pub fn store(app: &AppHandle, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    remove_all(&dir);
    // A new name every time, so the web view never shows a cached older file.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let path = dir.join(format!("bg-{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    publish(&path)
}

pub fn stored_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Ok(stored_file(&dir(app)?))
}

/// URL of the stored background, if there is one.
#[tauri::command]
pub fn background_path(app: AppHandle) -> Result<Option<String>, String> {
    match stored_file(&dir(&app)?) {
        Some(f) => publish(&f).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn clear_background(app: AppHandle) -> Result<(), String> {
    if let Some(Ok(mut f)) = SERVER.get().map(|s| s.file.lock()) {
        *f = None;
    }
    remove_all(&dir(&app)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{clean_ext, parse_range, publish};
    use std::io::{Read, Write};

    fn get(url: &str, extra: &str) -> Vec<u8> {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = std::net::TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n").unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn the_server_serves_only_the_published_file_with_ranges() {
        let dir = std::env::temp_dir().join(format!("openschool-bg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bg-1.mp4");
        let data: Vec<u8> = (0..=255u8).cycle().take(200_000).collect();
        std::fs::write(&file, &data).unwrap();
        let url = publish(&file).unwrap();

        let full = get(&url, "");
        let head_end = full.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let head = String::from_utf8_lossy(&full[..head_end]).to_string();
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(head.contains("Content-Type: video/mp4") && head.contains("Accept-Ranges: bytes"));
        assert_eq!(&full[head_end..], &data[..]);

        let part = get(&url, "Range: bytes=1000-1999\r\n");
        let head_end = part.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let head = String::from_utf8_lossy(&part[..head_end]).to_string();
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 1000-1999/200000"));
        assert_eq!(&part[head_end..], &data[1000..2000]);

        let late = get(&url, "Range: bytes=999999-\r\n");
        assert!(String::from_utf8_lossy(&late).starts_with("HTTP/1.1 416"));

        // wrong token or another path: nothing is served
        let wrong = get(&url.replace("/bg-1.mp4", "/other.mp4"), "");
        assert!(String::from_utf8_lossy(&wrong).starts_with("HTTP/1.1 404"));
        let (base, _) = url.rsplit_once('/').unwrap();
        let (base, _) = base.rsplit_once('/').unwrap();
        let bad_token = get(&format!("{base}/deadbeef/bg-1.mp4"), "");
        assert!(String::from_utf8_lossy(&bad_token).starts_with("HTTP/1.1 404"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extensions_are_whitelisted() {
        assert_eq!(clean_ext("MP4").as_deref(), Some("mp4"));
        assert_eq!(clean_ext(".webp").as_deref(), Some("webp"));
        assert_eq!(clean_ext("exe"), None);
        assert_eq!(clean_ext("../x"), None);
        assert_eq!(clean_ext(""), None);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }
}
