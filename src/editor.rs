use crate::annotation::{Doc, Point, Rgb, Shape, Tool, ALL_TOOLS, PALETTE};
use crate::view::View;
use crate::{clipboard, render, state};
use gtk4::prelude::*;
use gtk4::{gdk, glib};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Instant;

const BACKGROUND: f64 = 0x1e as f64 / 255.0;
const COLOR_NAMES: [&str; 6] = ["Vermelho", "Amarelo", "Verde", "Azul", "Preto", "Branco"];
const CSS: &str = "
.printmark-bar { border-radius: 12px; padding: 6px; }
.printmark-bar button { padding: 4px 10px; }
.printmark-bar button.printmark-copy { padding: 6px 18px; }
.printmark-bar button.printmark-swatch-button { padding: 4px; }
.printmark-key { font-size: smaller; }
.printmark-swatch { min-width: 18px; min-height: 18px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.6); }
";

struct Editor {
    doc: Doc,
    draft: Option<Shape>,
    view: View,
    /// Set by the first zoom/pan; until then the view refits on every draw/resize.
    manual_view: bool,
    pointer: (f64, f64),
    tool: Tool,
    color: usize,
    base: cairo::ImageSurface,
    /// A `Shape::Text` being typed (drawn with a caret, not yet in `doc`).
    editing: Option<Shape>,
    /// The clean PNG on disk (what Descartar puts on the clipboard).
    image: PathBuf,
}

#[derive(Clone, Copy)]
enum Finish {
    Copy,
    Discard,
}

impl Editor {
    fn rgb(&self) -> Rgb {
        PALETTE[self.color]
    }

    /// Draft for a drag starting at `p` (image coords); None for tools that don't drag.
    fn start_shape(&self, p: Point) -> Option<Shape> {
        let color = self.rgb();
        Some(match self.tool {
            Tool::Arrow => Shape::Arrow { from: p, to: p, color },
            Tool::Rect => Shape::Rect { a: p, b: p, color },
            Tool::Ellipse => Shape::Ellipse { a: p, b: p, color },
            Tool::Redact => Shape::Redact { a: p, b: p },
            Tool::Pen => Shape::Pen { points: vec![p], color },
            Tool::Highlight => Shape::Highlight { points: vec![p], color },
            Tool::Text | Tool::Number => return None,
        })
    }

    fn extend_draft(&mut self, p: Point) {
        match &mut self.draft {
            Some(Shape::Arrow { to, .. }) => *to = p,
            Some(Shape::Rect { b, .. } | Shape::Ellipse { b, .. } | Shape::Redact { b, .. }) => *b = p,
            Some(Shape::Pen { points, .. } | Shape::Highlight { points, .. }) => points.push(p),
            _ => {}
        }
    }

    fn text_mut(&mut self) -> Option<&mut String> {
        match &mut self.editing {
            Some(Shape::Text { text, .. }) => Some(text),
            _ => None,
        }
    }

    /// Pops one whole char (not a byte) of the text being typed.
    fn backspace(&mut self) -> Option<char> {
        self.text_mut().and_then(String::pop)
    }

    /// Ends editing; `doc.push` drops empty/whitespace-only text.
    fn commit_text(&mut self) {
        if let Some(s) = self.editing.take() {
            self.doc.push(s);
        }
    }

    /// PNG bytes for the clipboard. Copy never falls back to the clean image: a
    /// tarja must not leak, so a failed export yields None (the editor stays open).
    fn png(&self, f: Finish) -> Option<Vec<u8>> {
        if let Finish::Copy = f {
            return render::export_png(&self.base, &self.doc.shapes)
                .inspect_err(|e| eprintln!("printmark: export failed, nothing copied: {e}"))
                .ok();
        }
        std::fs::read(&self.image)
            .inspect_err(|e| eprintln!("printmark: {}: {e}", self.image.display()))
            .ok()
            .or_else(|| render::export_png(&self.base, &[]).ok())
    }
}

/// Detaches the IM before committing so dead-key state can't leak into shortcuts.
/// No borrow is held while touching the IM: reset/focus_out may emit `commit`.
fn stop_editing(ed: &RefCell<Editor>, keys: &gtk4::EventControllerKey, im: &gtk4::IMMulticontext) {
    if ed.borrow().editing.is_none() {
        return;
    }
    keys.set_im_context(None::<&gtk4::IMContext>);
    im.focus_out();
    im.reset();
    ed.borrow_mut().commit_text();
}

/// `t0`: the portal response time, set only when PRINTMARK_TIMING=1.
pub fn open(app: &gtk4::Application, image: PathBuf, t0: Option<Instant>) {
    let base = match std::fs::File::open(&image)
        .map_err(|e| e.to_string())
        .and_then(|mut f| cairo::ImageSurface::create_from_png(&mut f).map_err(|e| e.to_string()))
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("printmark: {}: {e}", image.display());
            std::process::exit(1);
        }
    };
    let prefs = state::load(&state::path());
    let ed = Rc::new(RefCell::new(Editor {
        doc: Doc::default(),
        draft: None,
        view: View { scale: 1.0, ox: 0.0, oy: 0.0 },
        manual_view: false,
        pointer: (0.0, 0.0),
        tool: prefs.tool,
        color: prefs.color,
        base,
        editing: None,
        image,
    }));

    let window = gtk4::ApplicationWindow::builder().application(app).title("printmark").build();
    let provider = gtk4::CssProvider::new();
    let swatch_css: String = PALETTE
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                ".printmark-swatch-{i} {{ background-color: rgb({},{},{}); }}\n",
                (c.r * 255.0).round(),
                (c.g * 255.0).round(),
                (c.b * 255.0).round()
            )
        })
        .collect();
    provider.load_from_string(&format!("{CSS}{swatch_css}"));
    gtk4::style_context_add_provider_for_display(
        &WidgetExt::display(&window),
        &provider,
        gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    let area = gtk4::DrawingArea::builder().hexpand(true).vexpand(true).build();
    {
        let ed = ed.clone();
        let t0 = Cell::new(t0);
        area.set_draw_func(move |_, cr, w, h| {
            if let Some(t) = t0.take() {
                eprintln!("printmark: {} ms from portal response to first draw", t.elapsed().as_millis());
            }
            let mut e = ed.borrow_mut();
            // Never fit on a 0×0 allocation: scale 0 would make to_image return NaN.
            if !e.manual_view && w > 0 && h > 0 {
                e.view = View::fit(
                    e.base.width() as f64,
                    e.base.height() as f64,
                    w as f64,
                    h as f64,
                );
            }
            cr.set_source_rgb(BACKGROUND, BACKGROUND, BACKGROUND);
            let _ = cr.paint();
            cr.translate(e.view.ox, e.view.oy);
            cr.scale(e.view.scale, e.view.scale);
            if cr.set_source_surface(&e.base, 0.0, 0.0).is_ok() {
                let _ = cr.paint();
            }
            for s in e.doc.shapes.iter().chain(e.draft.as_ref()).chain(e.editing.as_ref()) {
                render::draw_shape(cr, s);
            }
            if let Some(Shape::Text { at, text, color }) = &e.editing {
                render::draw_caret(cr, *at, text, *color);
            }
        });
    }

    // Typing goes through the IM so dead keys and ç/ã compose. It is attached to
    // the key controller only while editing (the IM filters keys before
    // key-pressed fires, so attached it would swallow the letter shortcuts).
    let keys = gtk4::EventControllerKey::new();
    let im = gtk4::IMMulticontext::new();
    im.set_client_widget(Some(&area));
    {
        let ed = ed.clone();
        let area = area.clone();
        im.connect_commit(move |_, s| {
            if let Some(text) = ed.borrow_mut().text_mut() {
                text.push_str(s);
            }
            area.queue_draw();
        });
    }
    // Resize refits (in the draw func) as long as the user hasn't zoomed/panned.
    area.connect_resize(|a, _, _| a.queue_draw());

    let drag = gtk4::GestureDrag::new();
    drag.set_button(gdk::BUTTON_PRIMARY);
    {
        let ed = ed.clone();
        let area = area.clone();
        let (keys, im) = (keys.clone(), im.clone());
        drag.connect_drag_begin(move |_, x, y| {
            // Any click ends the text being typed; with Texto it starts a new one.
            stop_editing(&ed, &keys, &im);
            let mut e = ed.borrow_mut();
            let p = e.view.to_image(x, y);
            match e.tool {
                Tool::Number => {
                    let s = Shape::Number { at: p, n: e.doc.next_number(), color: e.rgb() };
                    e.doc.push(s);
                }
                Tool::Text => {
                    e.editing = Some(Shape::Text { at: p, text: String::new(), color: e.rgb() });
                    drop(e);
                    keys.set_im_context(Some(&im));
                    im.focus_in();
                    area.queue_draw();
                    return;
                }
                _ => {}
            }
            e.draft = e.start_shape(p);
            area.queue_draw();
        });
    }
    let drag_to = {
        let ed = ed.clone();
        let area = area.clone();
        move |g: &gtk4::GestureDrag, dx: f64, dy: f64| {
            let Some((sx, sy)) = g.start_point() else { return };
            let mut e = ed.borrow_mut();
            let p = e.view.to_image(sx + dx, sy + dy);
            e.extend_draft(p);
            area.queue_draw();
        }
    };
    drag.connect_drag_update(drag_to.clone());
    {
        let ed = ed.clone();
        let area = area.clone();
        drag.connect_drag_end(move |g, dx, dy| {
            drag_to(g, dx, dy);
            let mut e = ed.borrow_mut();
            if let Some(s) = e.draft.take() {
                e.doc.push(s); // degenerate (e.g. click without drag) is dropped here
            }
            area.queue_draw();
        });
    }
    area.add_controller(drag);

    let motion = gtk4::EventControllerMotion::new();
    {
        let ed = ed.clone();
        motion.connect_motion(move |_, x, y| ed.borrow_mut().pointer = (x, y));
    }
    area.add_controller(motion);

    let scroll = gtk4::EventControllerScroll::new(gtk4::EventControllerScrollFlags::BOTH_AXES);
    {
        let ed = ed.clone();
        let area = area.clone();
        scroll.connect_scroll(move |c, dx, dy| {
            let mods = c.current_event_state();
            let mut e = ed.borrow_mut();
            if mods.contains(gdk::ModifierType::CONTROL_MASK) {
                if dy == 0.0 {
                    return glib::Propagation::Proceed;
                }
                let (px, py) = e.pointer;
                e.view.zoom_at(if dy < 0.0 { 1.1 } else { 1.0 / 1.1 }, px, py);
            } else {
                let step = if c.unit() == gdk::ScrollUnit::Wheel { 60.0 } else { 1.0 };
                let (dx, dy) = if mods.contains(gdk::ModifierType::SHIFT_MASK) {
                    (dx + dy, 0.0)
                } else {
                    (dx, dy)
                };
                e.view.pan(-dx * step, -dy * step);
            }
            e.manual_view = true;
            area.queue_draw();
            glib::Propagation::Stop
        });
    }
    area.add_controller(scroll);

    // Toolbar. Buttons are the single source of truth for tool/color: keyboard
    // shortcuts call set_active, and the toggled handlers update the editor.
    let bar = gtk4::Box::builder()
        .orientation(gtk4::Orientation::Horizontal)
        .spacing(4)
        .halign(gtk4::Align::Center)
        .valign(gtk4::Align::End)
        .margin_bottom(18)
        .css_classes(["osd", "printmark-bar"])
        .build();

    let mut tool_buttons: Vec<gtk4::ToggleButton> = Vec::new();
    for tool in ALL_TOOLS {
        let label = tool.label();
        let b = gtk4::ToggleButton::builder()
            .label(label.split(" (").next().unwrap_or(label))
            .tooltip_text(label)
            .focus_on_click(false)
            .build();
        if let Some(first) = tool_buttons.first() {
            b.set_group(Some(first));
        }
        b.set_active(tool == prefs.tool);
        let ed = ed.clone();
        let area = area.clone();
        let (keys, im) = (keys.clone(), im.clone());
        b.connect_toggled(move |b| {
            if b.is_active() {
                stop_editing(&ed, &keys, &im);
                ed.borrow_mut().tool = tool;
                area.queue_draw();
            }
        });
        bar.append(&b);
        tool_buttons.push(b);
    }
    bar.append(&gtk4::Separator::new(gtk4::Orientation::Vertical));

    let mut color_buttons: Vec<gtk4::ToggleButton> = Vec::new();
    for (i, name) in COLOR_NAMES.iter().enumerate() {
        let dot = gtk4::Box::builder()
            .css_classes(["printmark-swatch", &format!("printmark-swatch-{i}")])
            .build();
        let b = gtk4::ToggleButton::builder()
            .child(&dot)
            .tooltip_text(format!("{name} ({})", i + 1))
            .focus_on_click(false)
            .css_classes(["printmark-swatch-button"])
            .build();
        if let Some(first) = color_buttons.first() {
            b.set_group(Some(first));
        }
        b.set_active(i == prefs.color);
        let ed = ed.clone();
        let area = area.clone();
        b.connect_toggled(move |b| {
            if b.is_active() {
                let mut e = ed.borrow_mut();
                e.color = i;
                if let Some(Shape::Text { color, .. }) = &mut e.editing {
                    *color = PALETTE[i];
                }
                area.queue_draw();
            }
        });
        bar.append(&b);
        color_buttons.push(b);
    }
    bar.append(&gtk4::Separator::new(gtk4::Orientation::Vertical));

    let undo = move |ed: &RefCell<Editor>, area: &gtk4::DrawingArea, redo: bool| {
        let mut e = ed.borrow_mut();
        // While typing, undo removes the last typed char first.
        if redo {
            e.doc.redo();
        } else if e.backspace().is_none() {
            e.doc.undo();
        }
        area.queue_draw();
    };
    let undo_button = gtk4::Button::builder()
        .label("Desfazer")
        .tooltip_text("Desfazer (Ctrl+Z)")
        .focus_on_click(false)
        .build();
    {
        let ed = ed.clone();
        let area = area.clone();
        undo_button.connect_clicked(move |_| undo(&ed, &area, false));
    }
    bar.append(&undo_button);

    let spacer = gtk4::Box::builder().width_request(24).build();
    bar.append(&spacer);

    // Runs at most once: commits typed text, saves prefs, hands the PNG to the
    // clipboard and destroys the window. No borrow is held across hand_off.
    let finish: Rc<dyn Fn(Finish)> = {
        let ed = ed.clone();
        let (keys, im) = (keys.clone(), im.clone());
        let app = app.clone();
        let window = window.downgrade();
        let done = Cell::new(false);
        Rc::new(move |f| {
            let Some(window) = window.upgrade() else { return };
            if done.replace(true) {
                return;
            }
            stop_editing(&ed, &keys, &im);
            let png = {
                let e = ed.borrow();
                let png = e.png(f);
                if png.is_none() && matches!(f, Finish::Copy) {
                    // Export failed: keep the editor open so the user can retry or Esc.
                    drop(e);
                    done.set(false);
                    return;
                }
                if let Err(err) = state::save(&state::path(), state::Prefs { tool: e.tool, color: e.color }) {
                    eprintln!("printmark: saving state: {err}");
                }
                png
            };
            match png {
                Some(png) => clipboard::hand_off(&app, &window, glib::Bytes::from_owned(png)),
                None => window.destroy(),
            }
        })
    };
    let discard = gtk4::Button::builder()
        .child(&key_label("Descartar", "Esc"))
        .tooltip_text("Descartar (Esc)")
        .focus_on_click(false)
        .build();
    {
        let finish = finish.clone();
        discard.connect_clicked(move |_| finish(Finish::Discard));
    }
    bar.append(&discard);
    let copy = gtk4::Button::builder()
        .child(&key_label("Copiar", "Ctrl+C"))
        .tooltip_text("Copiar (Ctrl+C)")
        .focus_on_click(false)
        .css_classes(["suggested-action", "printmark-copy"])
        .build();
    {
        let finish = finish.clone();
        copy.connect_clicked(move |_| finish(Finish::Copy));
    }
    bar.append(&copy);

    // Capture phase: shortcuts win over whatever button happens to hold focus.
    keys.set_propagation_phase(gtk4::PropagationPhase::Capture);
    {
        let ed = ed.clone();
        let area = area.clone();
        let keys_ = keys.clone();
        keys.connect_key_pressed(move |_, key, _, mods| {
            let ctrl = mods.contains(gdk::ModifierType::CONTROL_MASK);
            let shift = mods.contains(gdk::ModifierType::SHIFT_MASK);
            let other = mods.intersects(gdk::ModifierType::ALT_MASK | gdk::ModifierType::SUPER_MASK);
            let lower = key.to_lower();
            // Printable keys never get here while editing: the IM consumed them.
            let editing = ed.borrow().editing.is_some();
            if key == gdk::Key::Escape && !ctrl && !other {
                if editing {
                    stop_editing(&ed, &keys_, &im);
                    area.queue_draw();
                } else {
                    discard.emit_clicked();
                }
            } else if ctrl && !other && lower == gdk::Key::z {
                undo(&ed, &area, shift);
            } else if ctrl && !shift && !other && lower == gdk::Key::c {
                copy.emit_clicked();
            } else if ctrl || other {
                return glib::Propagation::Proceed;
            } else if editing {
                if let Some(text) = ed.borrow_mut().text_mut() {
                    match key {
                        gdk::Key::BackSpace => {
                            text.pop();
                        }
                        gdk::Key::Return | gdk::Key::KP_Enter => text.push('\n'),
                        _ => {}
                    }
                }
                area.queue_draw();
            } else if let Some(c) = key.to_unicode() {
                if let Some(d) = c.to_digit(10).filter(|d| (1..=6).contains(d)) {
                    color_buttons[d as usize - 1].set_active(true);
                } else if let Some(t) = Tool::from_key(c) {
                    let i = ALL_TOOLS.iter().position(|x| *x == t).unwrap_or(0);
                    tool_buttons[i].set_active(true);
                } else {
                    return glib::Propagation::Proceed;
                }
            } else {
                return glib::Propagation::Proceed;
            }
            glib::Propagation::Stop
        });
    }
    window.add_controller(keys);

    // Closing from the title bar / Alt+F4 is Descartar; finish destroys the window.
    window.connect_close_request(move |_| {
        finish(Finish::Discard);
        glib::Propagation::Stop
    });

    let overlay = gtk4::Overlay::new();
    overlay.set_child(Some(&area));
    overlay.add_overlay(&bar);
    window.set_child(Some(&overlay));
    window.maximize();
    window.present();
}

/// Button content: the action plus its key, dimmer and smaller.
fn key_label(text: &str, key: &str) -> gtk4::Box {
    let b = gtk4::Box::new(gtk4::Orientation::Horizontal, 8);
    b.append(&gtk4::Label::new(Some(text)));
    let k = gtk4::Label::new(Some(key));
    k.add_css_class("dim-label");
    k.add_css_class("printmark-key");
    b.append(&k);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor() -> Editor {
        Editor {
            doc: Doc::default(),
            draft: None,
            view: View { scale: 1.0, ox: 0.0, oy: 0.0 },
            manual_view: false,
            pointer: (0.0, 0.0),
            tool: Tool::Text,
            color: 0,
            base: cairo::ImageSurface::create(cairo::Format::ARgb32, 4, 4).unwrap(),
            editing: Some(Shape::Text { at: Point { x: 0.0, y: 0.0 }, text: String::new(), color: PALETTE[0] }),
            image: PathBuf::from("/nonexistent/printmark-clean.png"),
        }
    }

    #[test]
    fn discard_reads_clean_file_copy_exports() {
        let mut e = editor();
        e.image = std::env::temp_dir().join(format!("printmark-{}-clean.png", std::process::id()));
        std::fs::write(&e.image, b"clean bytes").unwrap();
        assert_eq!(e.png(Finish::Discard).unwrap(), b"clean bytes");
        let copy = e.png(Finish::Copy).unwrap();
        assert!(copy.starts_with(b"\x89PNG"));
        std::fs::remove_file(&e.image).unwrap();
        // Clean file gone: Descartar still yields the clean image, never nothing.
        assert!(e.png(Finish::Discard).unwrap().starts_with(b"\x89PNG"));
    }

    #[test]
    fn failed_copy_export_never_yields_clean_bytes() {
        let mut e = editor();
        e.image = std::env::temp_dir().join(format!("printmark-{}-clean-fail.png", std::process::id()));
        std::fs::write(&e.image, b"clean bytes").unwrap();
        // NaN puts the cairo context in an error state, so export_png fails
        // (pushed directly: Doc::push would drop it as degenerate).
        e.doc.shapes.push(Shape::Ellipse { a: Point { x: f64::NAN, y: 0.0 }, b: Point { x: 3.0, y: 3.0 }, color: PALETTE[0] });
        let copy = e.png(Finish::Copy);
        std::fs::remove_file(&e.image).unwrap();
        assert!(copy.is_none());
    }

    #[test]
    fn backspace_pops_whole_chars() {
        let mut e = editor();
        e.text_mut().unwrap().push_str("Atenção");
        assert_eq!(e.backspace(), Some('o'));
        assert_eq!(e.backspace(), Some('ã'));
        assert_eq!(e.backspace(), Some('ç'));
        assert_eq!(e.text_mut().unwrap(), "Aten");
    }

    #[test]
    fn commit_keeps_text_and_drops_empty() {
        let mut e = editor();
        e.text_mut().unwrap().push_str("é");
        e.commit_text();
        assert!(e.editing.is_none());
        assert_eq!(e.doc.shapes.len(), 1);

        let mut e = editor();
        e.text_mut().unwrap().push_str(" \n");
        e.commit_text();
        assert!(e.editing.is_none());
        assert!(e.doc.shapes.is_empty());
        assert_eq!(e.backspace(), None); // not editing: Ctrl+Z falls through to doc.undo
    }
}
