//! Screen eyedropper.
//!
//! GTK's own picker (the pipette inside its colour dialog) breaks on Plasma 6: KWin answers
//! `ColorPicker.pick()` with a struct `(u)`, GTK reads it as a bare `u` and returns garbage
//! (a transparent "#007FFE" and glib criticals). So the app asks KWin itself and parses the reply
//! the way it is actually sent.

/// `Ok(None)` means the user cancelled (Esc).
pub fn pick() -> Result<Option<String>, String> {
    imp::pick()
}

pub fn available() -> bool {
    imp::available()
}

/// KWin sends a colour as ARGB. Alpha 0 means "nothing was picked".
fn argb_to_hex(argb: u32) -> Option<String> {
    if argb >> 24 == 0 {
        return None;
    }
    Some(format!("#{:06X}", argb & 0x00FF_FFFF))
}

#[cfg(target_os = "linux")]
mod imp {
    use std::time::Duration;

    use dbus::blocking::Connection;

    pub fn available() -> bool {
        let Ok(conn) = Connection::new_session() else { return false };
        let bus = conn.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", Duration::from_secs(2));
        let owned: Result<(bool,), _> = bus.method_call("org.freedesktop.DBus", "NameHasOwner", ("org.kde.KWin",));
        matches!(owned, Ok((true,)))
    }

    pub fn pick() -> Result<Option<String>, String> {
        let conn = Connection::new_session().map_err(|e| e.to_string())?;
        // The call blocks until the user clicks, so the timeout is generous.
        let kwin = conn.with_proxy("org.kde.KWin", "/ColorPicker", Duration::from_secs(120));
        let reply: Result<((u32,),), dbus::Error> = kwin.method_call("org.kde.kwin.ColorPicker", "pick", ());
        match reply {
            Ok(((argb,),)) => Ok(super::argb_to_hex(argb)),
            Err(e) if e.message().is_some_and(|m| m.to_lowercase().contains("cancel")) => Ok(None),
            Err(e) => Err(e.message().unwrap_or("the eyedropper failed").to_string()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    pub fn available() -> bool {
        false
    }
    pub fn pick() -> Result<Option<String>, String> {
        Err("the eyedropper is not available on this system".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argb_is_formatted_as_rgb_hex() {
        assert_eq!(argb_to_hex(0xFF00_7FFE).as_deref(), Some("#007FFE"));
        assert_eq!(argb_to_hex(0xFF25_63EB).as_deref(), Some("#2563EB"));
        assert_eq!(argb_to_hex(0xFF00_0000).as_deref(), Some("#000000"));
    }

    #[test]
    fn a_transparent_reply_means_nothing_was_picked() {
        assert_eq!(argb_to_hex(0), None);
        assert_eq!(argb_to_hex(0x00FF_FFFF), None);
    }

    /// Interactive: click any pixel when asked. Run with `cargo test kwin_pick_manual -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn kwin_pick_manual() {
        println!("available: {}", available());
        println!("picked: {:?}", pick());
    }
}
