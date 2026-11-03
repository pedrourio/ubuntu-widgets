use ashpd::desktop::screenshot::Screenshot;
use gtk4::gio::prelude::FileExt;
use gtk4::glib;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub enum CaptureError {
    Cancelled,
    Failed(String),
}

pub async fn take() -> Result<PathBuf, CaptureError> {
    let fail = |e: ashpd::Error| match e {
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => CaptureError::Cancelled,
        e => CaptureError::Failed(e.to_string()),
    };
    let shot = Screenshot::request()
        .interactive(true)
        .modal(true)
        .send()
        .await
        .map_err(fail)?
        .response()
        .map_err(fail)?;
    gtk4::gio::File::for_uri(shot.uri().as_str())
        .path()
        .ok_or_else(|| CaptureError::Failed(format!("portal returned a non-file URI: {}", shot.uri())))
}

pub fn screenshots_dir() -> PathBuf {
    glib::user_special_dir(glib::UserDirectory::Pictures)
        .unwrap_or_else(|| glib::home_dir().join("Imagens"))
        .join("Capturas de tela")
}

pub fn store(src: &Path, dir: &Path, now: &glib::DateTime) -> io::Result<PathBuf> {
    if src.parent() == Some(dir) {
        return Ok(src.to_path_buf());
    }
    fs::create_dir_all(dir)?;
    let stamp = now
        .format("%Y-%m-%d %H-%M-%S")
        .map_err(|e| io::Error::other(e.to_string()))?;
    let base = format!("Captura de tela de {stamp}");
    let mut dst = dir.join(format!("{base}.png"));
    let mut n = 2;
    while dst.exists() {
        dst = dir.join(format!("{base} ({n}).png"));
        n += 1;
    }
    if fs::rename(src, &dst).is_err() {
        fs::copy(src, &dst)?;
        let _ = fs::remove_file(src);
    }
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> glib::DateTime {
        glib::DateTime::from_local(2026, 10, 16, 9, 12, 12.0).unwrap()
    }
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("printmark-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn store_moves_into_dir_with_native_name() {
        let t = tmp("move");
        let src = t.join("a/x.png");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, b"png").unwrap();
        let dir = t.join("out");
        let got = store(&src, &dir, &now()).unwrap();
        assert_eq!(got, dir.join("Captura de tela de 2026-10-16 09-12-12.png"));
        assert!(got.exists());
        assert!(!src.exists());
    }

    #[test]
    fn store_same_second_gets_suffix() {
        let t = tmp("suffix");
        let dir = t.join("out");
        fs::create_dir_all(&dir).unwrap();
        let first = dir.join("Captura de tela de 2026-10-16 09-12-12.png");
        fs::write(&first, b"one").unwrap();
        let src = t.join("x.png");
        fs::write(&src, b"two").unwrap();
        let got = store(&src, &dir, &now()).unwrap();
        assert_eq!(got, dir.join("Captura de tela de 2026-10-16 09-12-12 (2).png"));
        assert_eq!(fs::read(&first).unwrap(), b"one");
    }

    #[test]
    fn store_already_in_dir_is_noop() {
        let t = tmp("noop");
        let src = t.join("foo.png");
        fs::write(&src, b"png").unwrap();
        assert_eq!(store(&src, &t, &now()).unwrap(), src);
        assert!(src.exists());
    }
}
