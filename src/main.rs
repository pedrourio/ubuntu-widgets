mod annotation;
mod capture;
mod clipboard;
mod editor;
mod render;
mod state;
mod view;

use gtk4::prelude::*;
use gtk4::{gio, glib};

fn main() -> glib::ExitCode {
    let app = gtk4::Application::builder()
        .application_id("io.github.printmark.Printmark")
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();
    app.connect_activate(|app| {
        let guard = app.hold();
        let app = app.clone();
        glib::spawn_future_local(async move {
            let _guard = guard;
            match capture::take().await {
                Err(capture::CaptureError::Cancelled) => {}
                Err(capture::CaptureError::Failed(e)) => {
                    eprintln!("printmark: {e}");
                    app.quit();
                    std::process::exit(1);
                }
                Ok(p) => {
                    let t0 = std::time::Instant::now();
                    let t0 = std::env::var("PRINTMARK_TIMING").is_ok_and(|v| v == "1").then_some(t0);
                    match capture::store(&p, &capture::screenshots_dir(), &glib::DateTime::now_local().unwrap()) {
                        // The window holds the app from here; `_guard` can drop.
                        Ok(p) => return editor::open(&app, p, t0),
                        Err(e) => {
                            eprintln!("printmark: {e}");
                            std::process::exit(1);
                        }
                    }
                }
            }
            app.quit();
        });
    });
    app.run()
}
