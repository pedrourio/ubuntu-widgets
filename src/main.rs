mod annotation;
mod capture;
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
                Ok(p) => match capture::store(&p, &capture::screenshots_dir(), &glib::DateTime::now_local().unwrap()) {
                    Ok(p) => println!("{}", p.display()),
                    Err(e) => {
                        eprintln!("printmark: {e}");
                        std::process::exit(1);
                    }
                },
            }
            app.quit();
        });
    });
    app.run()
}
