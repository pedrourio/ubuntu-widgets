use gtk4::prelude::*;
use gtk4::{gdk, glib};
use std::cell::RefCell;
use std::rc::Rc;

/// Puts `png` on the clipboard, then destroys the window. The clipboard must be
/// set first: Wayland ties the selection to an input serial of a focused surface.
/// The process lingers (app held) only while it still owns the clipboard.
pub fn hand_off(app: &gtk4::Application, window: &gtk4::ApplicationWindow, png: glib::Bytes) {
    // Raw PNG bytes: a Texture would decode here and re-encode on every paste.
    let provider = gdk::ContentProvider::for_bytes("image/png", &png);
    let cb = WidgetExt::display(window).clipboard();
    match cb.set_content(Some(&provider)) {
        Ok(()) => {
            let guard = Rc::new(RefCell::new(Some(app.hold())));
            cb.connect_changed(move |cb| {
                if !cb.is_local() {
                    let g = guard.borrow_mut().take();
                    drop(g); // released outside the borrow; lets the app exit
                }
            });
        }
        Err(e) => eprintln!("printmark: clipboard: {e}"),
    }
    window.destroy();
}
