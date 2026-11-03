use crate::annotation::{Point, Rgb, Shape, PALETTE};
use cairo::{Antialias, Context, FontSlant, FontWeight, Format, ImageSurface, LineCap, LineJoin};
use std::f64::consts::PI;

const STROKE: f64 = 4.0;
const HIGHLIGHT_W: f64 = 20.0;
const HIGHLIGHT_ALPHA: f64 = 0.4;
const TEXT_SIZE: f64 = 24.0;
const NUM_R: f64 = 16.0;
const NUM_SIZE: f64 = 18.0;
const HEAD_LEN: f64 = 18.0;

/// (x, y, w, h) snapped outward to whole pixels so no original pixel survives.
pub fn redact_rect(a: Point, b: Point) -> (f64, f64, f64, f64) {
    let x = a.x.min(b.x).floor();
    let y = a.y.min(b.y).floor();
    (x, y, a.x.max(b.x).ceil() - x, a.y.max(b.y).ceil() - y)
}

fn rgba(cr: &Context, c: Rgb, a: f64) {
    cr.set_source_rgba(c.r, c.g, c.b, a);
}

fn path(cr: &Context, pts: &[Point]) {
    cr.set_line_join(LineJoin::Round);
    cr.set_line_cap(LineCap::Round);
    for (i, p) in pts.iter().enumerate() {
        if i == 0 { cr.move_to(p.x, p.y) } else { cr.line_to(p.x, p.y) }
    }
}

fn font(cr: &Context, size: f64) {
    cr.select_font_face("Sans", FontSlant::Normal, FontWeight::Bold);
    cr.set_font_size(size);
}

pub fn draw_shape(cr: &Context, s: &Shape) {
    let _ = cr.save();
    cr.set_line_width(STROKE);
    match s {
        Shape::Arrow { from, to, color } => {
            rgba(cr, *color, 1.0);
            cr.set_line_cap(LineCap::Round);
            cr.move_to(from.x, from.y);
            cr.line_to(to.x, to.y);
            let _ = cr.stroke();
            let back = (from.y - to.y).atan2(from.x - to.x);
            let spread = 25f64.to_radians();
            cr.move_to(to.x, to.y);
            for sgn in [-1.0, 1.0] {
                let t = back + sgn * spread;
                cr.line_to(to.x + HEAD_LEN * t.cos(), to.y + HEAD_LEN * t.sin());
            }
            cr.close_path();
            let _ = cr.fill();
        }
        Shape::Rect { a, b, color } => {
            rgba(cr, *color, 1.0);
            cr.set_line_join(LineJoin::Miter);
            cr.rectangle(a.x.min(b.x), a.y.min(b.y), (b.x - a.x).abs(), (b.y - a.y).abs());
            let _ = cr.stroke();
        }
        Shape::Ellipse { a, b, color } => {
            rgba(cr, *color, 1.0);
            let (cx, cy) = ((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
            let (rx, ry) = (((b.x - a.x) / 2.0).abs().max(0.01), ((b.y - a.y) / 2.0).abs().max(0.01));
            let _ = cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.arc(0.0, 0.0, 1.0, 0.0, 2.0 * PI);
            let _ = cr.restore();
            let _ = cr.stroke();
        }
        Shape::Pen { points, color } => {
            rgba(cr, *color, 1.0);
            path(cr, points);
            let _ = cr.stroke();
        }
        Shape::Highlight { points, color } => {
            rgba(cr, *color, HIGHLIGHT_ALPHA);
            cr.set_line_width(HIGHLIGHT_W);
            path(cr, points);
            let _ = cr.stroke();
        }
        Shape::Text { at, text, color } => {
            rgba(cr, *color, 1.0);
            font(cr, TEXT_SIZE);
            for (i, line) in text.split('\n').enumerate() {
                // `at` is the top-left of the text block
                let ascent = cr.font_extents().map(|e| e.ascent()).unwrap_or(TEXT_SIZE);
                cr.move_to(at.x, at.y + ascent + i as f64 * TEXT_SIZE * 1.2);
                let _ = cr.show_text(line);
            }
        }
        Shape::Number { at, n, color } => {
            rgba(cr, *color, 1.0);
            cr.arc(at.x, at.y, NUM_R, 0.0, 2.0 * PI);
            let _ = cr.fill();
            let dark = *color == PALETTE[1] || *color == PALETTE[5];
            cr.set_source_rgb(if dark { 0.0 } else { 1.0 }, if dark { 0.0 } else { 1.0 }, if dark { 0.0 } else { 1.0 });
            font(cr, NUM_SIZE);
            let t = n.to_string();
            if let Ok(e) = cr.text_extents(&t) {
                cr.move_to(
                    at.x - (e.x_bearing() + e.width() / 2.0),
                    at.y - (e.y_bearing() + e.height() / 2.0),
                );
                let _ = cr.show_text(&t);
            }
        }
        Shape::Redact { a, b } => {
            cr.set_antialias(Antialias::None);
            let (x, y, w, h) = redact_rect(*a, *b);
            cr.set_source_rgba(0.0, 0.0, 0.0, 1.0);
            cr.rectangle(x, y, w, h);
            let _ = cr.fill();
        }
    }
    let _ = cr.restore();
}

/// Thin caret after the last char of a text being typed; same metrics as `Shape::Text`.
pub fn draw_caret(cr: &Context, at: Point, text: &str, color: Rgb) {
    let _ = cr.save();
    rgba(cr, color, 1.0);
    font(cr, TEXT_SIZE);
    let (i, last) = text.split('\n').enumerate().last().unwrap_or((0, ""));
    let x = at.x + cr.text_extents(last).map(|e| e.x_advance()).unwrap_or(0.0);
    let h = cr.font_extents().map(|e| e.ascent() + e.descent()).unwrap_or(TEXT_SIZE);
    cr.rectangle(x + 1.0, at.y + i as f64 * TEXT_SIZE * 1.2, 2.0, h);
    let _ = cr.fill();
    let _ = cr.restore();
}

pub fn export_png(base: &ImageSurface, shapes: &[Shape]) -> Result<Vec<u8>, cairo::Error> {
    let out = ImageSurface::create(Format::ARgb32, base.width(), base.height())?;
    {
        let cr = Context::new(&out)?;
        cr.set_source_surface(base, 0.0, 0.0)?;
        cr.paint()?;
        for s in shapes {
            draw_shape(&cr, s);
        }
        // draw_shape swallows errors; a sticky context error would skip shapes (even a Redact) silently.
        cr.status()?;
    }
    let mut buf = Vec::new();
    out.write_to_png(&mut buf).map_err(|e| match e {
        cairo::IoError::Cairo(c) => c,
        cairo::IoError::Io(_) => cairo::Error::WriteError,
    })?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(w: i32, h: i32) -> ImageSurface {
        let s = ImageSurface::create(Format::ARgb32, w, h).unwrap();
        let cr = Context::new(&s).unwrap();
        cr.set_source_rgb(1.0, 1.0, 1.0);
        cr.paint().unwrap();
        drop(cr);
        s
    }

    fn px(png: &[u8], x: i32, y: i32) -> [u8; 4] {
        let mut s = ImageSurface::create_from_png(&mut &png[..]).unwrap();
        let stride = s.stride() as usize;
        let d = s.data().unwrap();
        let i = y as usize * stride + x as usize * 4;
        [d[i + 2], d[i + 1], d[i], d[i + 3]] // BGRA -> RGBA (opaque, so premultiply is moot)
    }

    fn p(x: f64, y: f64) -> Point { Point { x, y } }

    #[test]
    fn export_keeps_original_size() {
        let png = export_png(&white(5760, 1080), &[]).unwrap();
        let s = ImageSurface::create_from_png(&mut &png[..]).unwrap();
        assert_eq!((s.width(), s.height()), (5760, 1080));
    }

    #[test]
    fn redact_reversed_fractional_is_fully_black() {
        let shapes = [Shape::Redact { a: p(50.7, 40.3), b: p(10.2, 10.9) }];
        let png = export_png(&white(64, 64), &shapes).unwrap();
        for y in 10..41 { for x in 10..51 { assert_eq!(px(&png, x, y), [0, 0, 0, 255], "({x},{y})"); } }
        assert_eq!(px(&png, 9, 9), [255, 255, 255, 255]);
    }

    #[test]
    fn redact_rect_snaps_outward() {
        assert_eq!(redact_rect(p(50.7, 40.3), p(10.2, 10.9)), (10.0, 10.0, 41.0, 31.0));
    }

    #[test]
    fn rect_is_drawn_in_color() {
        let shapes = [Shape::Rect { a: p(10.0, 10.0), b: p(50.0, 50.0), color: PALETTE[0] }];
        let png = export_png(&white(64, 64), &shapes).unwrap();
        let c = px(&png, 10, 30);
        assert!(c[0] > 200 && c[1] < 60, "{c:?}");
    }

    #[test]
    fn highlight_overlap_does_not_stack() {
        let pts = vec![p(10.0, 10.0), p(50.0, 50.0), p(10.0, 50.0), p(50.0, 10.0)];
        let shapes = [Shape::Highlight { points: pts, color: PALETTE[1] }];
        let png = export_png(&white(64, 64), &shapes).unwrap();
        let single = px(&png, 20, 20);
        assert_ne!(single, [255, 255, 255, 255]);
        assert_eq!(px(&png, 30, 30), single);
    }

    #[test]
    fn export_fails_on_context_error() {
        let shapes = [Shape::Ellipse { a: p(f64::NAN, 0.0), b: p(10.0, 10.0), color: PALETTE[0] }];
        assert!(export_png(&white(64, 64), &shapes).is_err());
    }
}
