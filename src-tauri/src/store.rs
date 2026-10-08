//! Session persistence in the OS secret store: Secret Service (KWallet / GNOME Keyring) on Linux,
//! Credential Manager on Windows. Cookies are credentials, so they never go to a plain file.
//!
//! One secret can be too small for a whole session (Windows keeps about 1280 characters per
//! credential), so the JSON is split into chunks: `gosuslugi-session` holds the chunk count and
//! `gosuslugi-session.N` the pieces. A value that is not a number is read as the old single-entry
//! format.

use openschool_bridge::SessionCookie;

#[cfg(not(test))]
const SERVICE: &str = "openschool";
/// Tests use a separate service so they never touch a real saved session.
#[cfg(test)]
const SERVICE: &str = "openschool-test";
const INDEX: &str = "gosuslugi-session";
/// Characters per chunk; safely below Windows' limit.
const CHUNK_CHARS: usize = 900;
/// Upper bound when cleaning up after a lost index.
const MAX_CHUNKS: usize = 32;

fn entry(user: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, user)
}

fn chunk_name(n: usize) -> String {
    format!("{INDEX}.{n}")
}

/// Split on char boundaries so a multi-byte character is never cut in half.
fn split_chunks(s: &str, max_chars: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    chars.chunks(max_chars).map(|c| c.iter().collect()).collect()
}

pub fn save(cookies: &[SessionCookie]) -> keyring::Result<()> {
    let pairs: Vec<(&str, &str)> = cookies.iter().map(|c| (c.name.as_str(), c.value.as_str())).collect();
    let json = serde_json::to_string(&pairs).expect("cookie pairs serialize");
    let chunks = split_chunks(&json, CHUNK_CHARS);
    for (n, chunk) in chunks.iter().enumerate() {
        entry(&chunk_name(n))?.set_password(chunk)?;
    }
    entry(INDEX)?.set_password(&chunks.len().to_string())?;
    remove_chunks_from(chunks.len());
    Ok(())
}

/// `Ok(None)` when nothing is stored yet.
pub fn load() -> keyring::Result<Option<Vec<SessionCookie>>> {
    let head = match entry(INDEX)?.get_password() {
        Ok(h) => h,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e),
    };
    let json = match head.parse::<usize>() {
        Ok(count) => {
            let mut json = String::new();
            for n in 0..count {
                match entry(&chunk_name(n))?.get_password() {
                    Ok(part) => json.push_str(&part),
                    Err(keyring::Error::NoEntry) => return Ok(None), // incomplete, treat as absent
                    Err(e) => return Err(e),
                }
            }
            json
        }
        Err(_) => head, // old format: the JSON itself
    };
    let pairs: Vec<(String, String)> = serde_json::from_str(&json).unwrap_or_default();
    Ok((!pairs.is_empty()).then(|| pairs.into_iter().map(|(name, value)| SessionCookie { name, value }).collect()))
}

fn remove_chunks_from(first: usize) {
    for n in first..MAX_CHUNKS {
        match entry(&chunk_name(n)).map(|e| e.delete_credential()) {
            Ok(Ok(())) => {}
            _ => break, // first missing chunk ends the run
        }
    }
}

pub fn clear() {
    if let Ok(e) = entry(INDEX) {
        let _ = e.delete_credential();
    }
    remove_chunks_from(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_rejoin_to_the_original() {
        let s = "а".repeat(2000) + &"b".repeat(1234);
        let parts = split_chunks(&s, CHUNK_CHARS);
        assert!(parts.iter().all(|p| p.chars().count() <= CHUNK_CHARS));
        assert_eq!(parts.concat(), s);
    }

    #[test]
    fn empty_input_has_no_chunks_and_short_input_has_one() {
        assert!(split_chunks("", CHUNK_CHARS).is_empty());
        assert_eq!(split_chunks("abc", CHUNK_CHARS), vec!["abc"]);
    }

    /// Needs a running secret store; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn roundtrip_through_the_real_store_with_chunks_and_cleanup() {
        clear();
        assert!(load().unwrap().is_none());

        let big: Vec<SessionCookie> = (0..6)
            .map(|i| SessionCookie { name: format!("c{i}"), value: format!("{i}").repeat(400) })
            .collect(); // ~2500 characters of JSON: several chunks
        save(&big).unwrap();
        let back = load().unwrap().expect("saved session");
        assert_eq!(back.len(), 6);
        assert!(back.iter().zip(&big).all(|(a, b)| a.name == b.name && a.value == b.value));

        // Saving something smaller must drop the leftover chunks.
        save(&big[..1]).unwrap();
        assert_eq!(load().unwrap().unwrap().len(), 1);
        assert!(entry(&chunk_name(2)).unwrap().get_password().is_err(), "stale chunk left behind");

        clear();
        assert!(load().unwrap().is_none());
    }

    #[test]
    fn a_realistic_session_needs_two_chunks() {
        // The captured session was ~1450 characters: one entry is too big for Windows.
        assert_eq!(split_chunks(&"x".repeat(1450), CHUNK_CHARS).len(), 2);
    }
}
