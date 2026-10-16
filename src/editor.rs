use crate::annotation::{Doc, Point, Rgb, Shape, Tool, ALL_TOOLS, PALETTE};
use crate::view::View;
use crate::{render, state};
use gtk4::prelude::*;
use gtk4::{gdk, glib};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

const BACKGROUND: f64 = 0x1e as f64 / 255.0;
const COLOR_NAMES: [&str; 6] = ["Vermelho", "Amarelo", "Verde", "Azul", "Preto", "Branco"];
const CSS: &str = "
.printmark-bar { border-radius: 12px; padding: 6px; }
.printmark-bar button { padding: 4px 10px; }
.printmark-bar button.printmark-copy { padding: 6px 18px; }
.printmark-bar button.printmark-swatch-button { padding: 4px; }
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
    // Task 7: text editing state goes here.
    // Task 8: `image: PathBuf` (clean file) and `fn finish(&self, action: Finish)` go here.
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
}

pub fn open(app: &gtk4::Application, image: PathBuf) {
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
        area.set_draw_func(move |_, cr, w, h| {
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
            for s in e.doc.shapes.iter().chain(e.draft.as_ref()) {
                render::draw_shape(cr, s);
            }
        });
    }
    // Resize refits (in the draw func) as long as the user hasn't zoomed/panned.
    area.connect_resize(|a, _, _| a.queue_draw());

    let drag = gtk4::GestureDrag::new();
    drag.set_button(gdk::BUTTON_PRIMARY);
    {
        let ed = ed.clone();
        let area = area.clone();
        drag.connect_drag_begin(move |_, x, y| {
            let mut e = ed.borrow_mut();
            let p = e.view.to_image(x, y);
            if e.tool == Tool::Number {
                let s = Shape::Number { at: p, n: e.doc.next_number(), color: e.rgb() };
                e.doc.push(s);
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
        b.connect_toggled(move |b| {
            if b.is_active() {
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
                ed.borrow_mut().color = i;
                area.queue_draw();
            }
        });
        bar.append(&b);
        color_buttons.push(b);
    }
    bar.append(&gtk4::Separator::new(gtk4::Orientation::Vertical));

    let undo = move |ed: &RefCell<Editor>, area: &gtk4::DrawingArea, redo: bool| {
        let mut e = ed.borrow_mut();
        if redo { e.doc.redo() } else { e.doc.undo() };
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

    // Task 8 replaces these closes with finish(Discard) / finish(Copy).
    let discard = gtk4::Button::builder()
        .label("Descartar")
        .tooltip_text("Descartar (Esc)")
        .focus_on_click(false)
        .build();
    discard.connect_clicked(glib::clone!(#[weak] window, move |_| window.close()));
    bar.append(&discard);
    let copy = gtk4::Button::builder()
        .label("Copiar")
        .tooltip_text("Copiar (Ctrl+C)")
        .focus_on_click(false)
        .css_classes(["suggested-action", "printmark-copy"])
        .build();
    copy.connect_clicked(glib::clone!(#[weak] window, move |_| window.close()));
    bar.append(&copy);

    let keys = gtk4::EventControllerKey::new();
    // Capture phase: shortcuts win over whatever button happens to hold focus.
    keys.set_propagation_phase(gtk4::PropagationPhase::Capture);
    {
        let ed = ed.clone();
        let area = area.clone();
        keys.connect_key_pressed(move |_, key, _, mods| {
            let ctrl = mods.contains(gdk::ModifierType::CONTROL_MASK);
            let shift = mods.contains(gdk::ModifierType::SHIFT_MASK);
            let other = mods.intersects(gdk::ModifierType::ALT_MASK | gdk::ModifierType::SUPER_MASK);
            let lower = key.to_lower();
            if key == gdk::Key::Escape && !ctrl && !other {
                discard.emit_clicked();
            } else if ctrl && !other && lower == gdk::Key::z {
                undo(&ed, &area, shift);
            } else if ctrl && !shift && !other && lower == gdk::Key::c {
                copy.emit_clicked();
            } else if ctrl || other {
                return glib::Propagation::Proceed;
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

    // Remember tool/color however the window closes (buttons, Esc, title bar).
    window.connect_close_request(move |_| {
        let e = ed.borrow();
        if let Err(err) = state::save(&state::path(), state::Prefs { tool: e.tool, color: e.color }) {
            eprintln!("printmark: saving state: {err}");
        }
        glib::Propagation::Proceed
    });

    let overlay = gtk4::Overlay::new();
    overlay.set_child(Some(&area));
    overlay.add_overlay(&bar);
    window.set_child(Some(&overlay));
    window.maximize();
    window.present();
}
