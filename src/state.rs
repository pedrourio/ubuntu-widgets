use crate::annotation::{Tool, PALETTE};
use gtk4::glib;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Prefs { pub tool: Tool, pub color: usize }

impl Default for Prefs {
    fn default() -> Self { Prefs { tool: Tool::Arrow, color: 0 } }
}

pub fn path() -> PathBuf {
    glib::user_config_dir().join("printmark").join("state")
}

pub fn load(p: &Path) -> Prefs {
    let mut prefs = Prefs::default();
    let Ok(text) = std::fs::read_to_string(p) else { return prefs };
    for line in text.lines() {
        match line.split_once('=') {
            Some(("tool", v)) => if let Some(t) = Tool::from_name(v.trim()) { prefs.tool = t },
            Some(("color", v)) => if let Ok(c) = v.trim().parse::<usize>() {
                if c < PALETTE.len() { prefs.color = c }
            },
            _ => {}
        }
    }
    prefs
}

pub fn save(p: &Path, prefs: Prefs) -> std::io::Result<()> {
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir)?; }
    std::fs::write(p, format!("tool={}\ncolor={}\n", prefs.tool.name(), prefs.color))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("printmark-{}-{}", std::process::id(), name))
    }

    #[test] fn save_then_load() {
        let d = dir("save_then_load"); let p = d.join("sub").join("state");
        save(&p, Prefs { tool: Tool::Redact, color: 3 }).unwrap();
        assert_eq!(load(&p), Prefs { tool: Tool::Redact, color: 3 });
        fs::remove_dir_all(&d).unwrap();
    }
    #[test] fn missing_file_is_default() {
        let missing = dir("missing").join("state");
        assert_eq!(load(&missing), Prefs::default());
    }
    #[test] fn garbage_falls_back_per_field() {
        let d = dir("garbage"); fs::create_dir_all(&d).unwrap(); let p = d.join("state");
        fs::write(&p, "tool=rect\ncolor=99\n\u{0}junk").unwrap();
        assert_eq!(load(&p), Prefs { tool: Tool::Rect, color: 0 });
        fs::remove_dir_all(&d).unwrap();
    }
}
