use gtk4::prelude::*;
use gtk4::{gdk, glib};
use std::cell::RefCell;
use std::rc::Rc;

/// Puts `png` on the clipboard, then destroys the window. The clipboard must be
/// set first: Wayland ties the selection to an input serial of a focused surface.
/// The process lingers (app held) only while it still owns the clipboard.
pub fn hand_off(app: &gtk4::Application, window: &gtk4::ApplicationWindow, png: glib::Bytes) {
    match gdk::Texture::from_bytes(&png) {
        Ok(tex) => {
            let cb = WidgetExt::display(window).clipboard();
            cb.set_texture(&tex);
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
