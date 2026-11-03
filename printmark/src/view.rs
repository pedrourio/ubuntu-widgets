use crate::annotation::Point;

/// widget = image * scale + offset
#[derive(Clone, Copy, Debug)]
pub struct View { pub scale: f64, pub ox: f64, pub oy: f64 }

impl View {
    pub fn fit(img_w: f64, img_h: f64, win_w: f64, win_h: f64) -> View {
        let scale = 1.0_f64.min(win_w / img_w).min(win_h / img_h);
        View { scale, ox: (win_w - img_w * scale) / 2.0, oy: (win_h - img_h * scale) / 2.0 }
    }
    pub fn to_image(&self, wx: f64, wy: f64) -> Point {
        Point { x: (wx - self.ox) / self.scale, y: (wy - self.oy) / self.scale }
    }
    #[cfg(test)]
    pub fn to_widget(&self, p: Point) -> (f64, f64) {
        (p.x * self.scale + self.ox, p.y * self.scale + self.oy)
    }
    pub fn zoom_at(&mut self, factor: f64, wx: f64, wy: f64) {
        let p = self.to_image(wx, wy);
        self.scale = (self.scale * factor).clamp(0.1, 8.0);
        self.ox = wx - p.x * self.scale;
        self.oy = wy - p.y * self.scale;
    }
    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.ox += dx;
        self.oy += dy;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn fit_small_image_is_1to1_centered() { let v = View::fit(800.0, 600.0, 1920.0, 1080.0); assert_eq!(v.scale, 1.0); assert_eq!((v.ox, v.oy), (560.0, 240.0)); }
    #[test] fn fit_three_monitor_capture() { let v = View::fit(5760.0, 1080.0, 1920.0, 1040.0); assert!((v.scale - 1.0/3.0).abs() < 1e-9); }
    #[test] fn round_trip_under_fit_and_zoom() {
        let mut v = View::fit(5760.0, 1080.0, 1920.0, 1040.0);
        v.zoom_at(1.1, 700.0, 300.0); v.zoom_at(1.1, 700.0, 300.0); v.pan(-37.5, 12.25);
        let p = Point { x: 4321.5, y: 777.25 };
        let (wx, wy) = v.to_widget(p); let q = v.to_image(wx, wy);
        assert!((p.x - q.x).abs() < 1e-6 && (p.y - q.y).abs() < 1e-6);
    }
    #[test] fn zoom_keeps_point_under_cursor() {
        let mut v = View::fit(5760.0, 1080.0, 1920.0, 1040.0);
        let before = v.to_image(700.0, 300.0);
        v.zoom_at(1.5, 700.0, 300.0);
        let after = v.to_image(700.0, 300.0);
        assert!((before.x - after.x).abs() < 1e-9 && (before.y - after.y).abs() < 1e-9);
    }
    #[test] fn zoom_is_clamped() {
        let mut v = View::fit(800.0, 600.0, 1920.0, 1080.0);
        for _ in 0..100 { v.zoom_at(2.0, 10.0, 10.0); }
        assert_eq!(v.scale, 8.0);
        for _ in 0..100 { v.zoom_at(0.5, 10.0, 10.0); }
        assert_eq!(v.scale, 0.1);
    }
}
