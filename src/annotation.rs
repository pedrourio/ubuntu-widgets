#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool { Arrow, Rect, Ellipse, Pen, Highlight, Text, Number, Redact }

pub const ALL_TOOLS: [Tool; 8] = [
    Tool::Arrow, Tool::Rect, Tool::Ellipse, Tool::Pen,
    Tool::Highlight, Tool::Text, Tool::Number, Tool::Redact,
];

impl Tool {
    pub fn key(self) -> char {
        match self {
            Tool::Arrow => 'a', Tool::Rect => 'r', Tool::Ellipse => 'e', Tool::Pen => 'p',
            Tool::Highlight => 'h', Tool::Text => 't', Tool::Number => 'n', Tool::Redact => 'b',
        }
    }
    pub fn from_key(c: char) -> Option<Tool> {
        let c = c.to_ascii_lowercase();
        ALL_TOOLS.into_iter().find(|t| t.key() == c)
    }
    pub fn name(self) -> &'static str {
        match self {
            Tool::Arrow => "arrow", Tool::Rect => "rect", Tool::Ellipse => "ellipse",
            Tool::Pen => "pen", Tool::Highlight => "highlight", Tool::Text => "text",
            Tool::Number => "number", Tool::Redact => "redact",
        }
    }
    pub fn from_name(s: &str) -> Option<Tool> {
        ALL_TOOLS.into_iter().find(|t| t.name() == s)
    }
    pub fn label(self) -> &'static str {
        match self {
            Tool::Arrow => "Seta (A)", Tool::Rect => "Retângulo (R)", Tool::Ellipse => "Elipse (E)",
            Tool::Pen => "Caneta (P)", Tool::Highlight => "Marca-texto (H)", Tool::Text => "Texto (T)",
            Tool::Number => "Número (N)", Tool::Redact => "Tarja (B)",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rgb { pub r: f64, pub g: f64, pub b: f64 }

const fn hex(v: u32) -> Rgb {
    Rgb {
        r: ((v >> 16) & 0xff) as f64 / 255.0,
        g: ((v >> 8) & 0xff) as f64 / 255.0,
        b: (v & 0xff) as f64 / 255.0,
    }
}

/// vermelho (default), amarelo, verde, azul, preto, branco
pub const PALETTE: [Rgb; 6] = [
    hex(0xe01b24), hex(0xf6d32d), hex(0x33d17a), hex(0x3584e4), hex(0x000000), hex(0xffffff),
];

/// Always image coordinates.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Point { pub x: f64, pub y: f64 }

#[derive(Clone, PartialEq, Debug)]
pub enum Shape {
    Arrow { from: Point, to: Point, color: Rgb },
    Rect { a: Point, b: Point, color: Rgb },
    Ellipse { a: Point, b: Point, color: Rgb },
    Pen { points: Vec<Point>, color: Rgb },
    Highlight { points: Vec<Point>, color: Rgb },
    #[cfg_attr(not(test), expect(dead_code, reason = "created by text editing (Task 7)"))]
    Text { at: Point, text: String, color: Rgb },
    Number { at: Point, n: u32, color: Rgb },
    Redact { a: Point, b: Point },
}

impl Shape {
    pub fn is_degenerate(&self) -> bool {
        let pts: &[Point] = match self {
            Shape::Arrow { from, to, .. } => &[*from, *to],
            Shape::Rect { a, b, .. } | Shape::Ellipse { a, b, .. } | Shape::Redact { a, b } => &[*a, *b],
            Shape::Pen { points, .. } | Shape::Highlight { points, .. } => points,
            Shape::Text { at, .. } | Shape::Number { at, .. } => &[*at],
        };
        if pts.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
            return true;
        }
        let d = |a: &Point, b: &Point| ((b.x - a.x).abs(), (b.y - a.y).abs());
        match self {
            Shape::Arrow { from, to, .. } => {
                let (dx, dy) = d(from, to);
                dx < 2.0 && dy < 2.0
            }
            Shape::Rect { a, b, .. } | Shape::Ellipse { a, b, .. } | Shape::Redact { a, b } => {
                let (dx, dy) = d(a, b);
                dx < 2.0 || dy < 2.0
            }
            Shape::Pen { points, .. } | Shape::Highlight { points, .. } => points.len() < 2,
            Shape::Text { text, .. } => text.trim().is_empty(),
            Shape::Number { .. } => false,
        }
    }
}

#[derive(Default)]
pub struct Doc {
    pub shapes: Vec<Shape>,
    redo: Vec<Shape>,
}

impl Doc {
    pub fn push(&mut self, s: Shape) -> bool {
        if s.is_degenerate() {
            return false;
        }
        self.shapes.push(s);
        self.redo.clear();
        true
    }
    pub fn undo(&mut self) -> bool {
        self.shapes.pop().map(|s| self.redo.push(s)).is_some()
    }
    pub fn redo(&mut self) -> bool {
        self.redo.pop().map(|s| self.shapes.push(s)).is_some()
    }
    pub fn next_number(&self) -> u32 {
        self.shapes.iter().filter(|s| matches!(s, Shape::Number { .. })).count() as u32 + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point { Point { x, y } }

    #[test]
    fn degenerate_shapes_are_rejected() {
        let mut d = Doc::default();
        let q = p(10.0, 10.0);
        assert!(!d.push(Shape::Rect { a: q, b: p(11.0, 50.0), color: PALETTE[0] }));
        assert!(!d.push(Shape::Arrow { from: q, to: p(11.0, 11.0), color: PALETTE[0] }));
        assert!(!d.push(Shape::Text { at: q, text: "  ".into(), color: PALETTE[0] }));
        assert!(!d.push(Shape::Pen { points: vec![q], color: PALETTE[0] }));
        assert!(d.shapes.is_empty());
        assert!(d.push(Shape::Number { at: q, n: 1, color: PALETTE[0] }));
    }

    #[test]
    fn non_finite_shapes_are_rejected() {
        let mut d = Doc::default();
        let q = p(10.0, 10.0);
        assert!(!d.push(Shape::Redact { a: q, b: p(f64::NAN, 50.0) }));
        assert!(!d.push(Shape::Rect { a: p(f64::INFINITY, 0.0), b: p(50.0, 50.0), color: PALETTE[0] }));
        assert!(!d.push(Shape::Pen { points: vec![q, p(20.0, f64::NAN)], color: PALETTE[0] }));
        assert!(!d.push(Shape::Number { at: p(f64::NAN, f64::NAN), n: 1, color: PALETTE[0] }));
        assert!(d.shapes.is_empty());
    }

    #[test]
    fn undo_redo_and_push_clears_redo() {
        let mut d = Doc::default();
        let num = |n| Shape::Number { at: p(0.0, 0.0), n, color: PALETTE[0] };
        let (a, b, c) = (num(1), num(2), num(3));
        d.push(a.clone());
        d.push(b.clone());
        assert!(d.undo());
        assert_eq!(d.shapes, vec![a.clone()]);
        assert!(d.redo());
        assert_eq!(d.shapes, vec![a.clone(), b]);
        assert!(d.undo());
        d.push(c.clone());
        assert_eq!(d.shapes, vec![a, c]);
        assert!(!d.redo());
    }

    #[test]
    fn next_number_follows_undo() {
        let mut d = Doc::default();
        assert_eq!(d.next_number(), 1);
        d.push(Shape::Number { at: p(0.0, 0.0), n: 1, color: PALETTE[0] });
        d.push(Shape::Number { at: p(0.0, 0.0), n: 2, color: PALETTE[0] });
        assert_eq!(d.next_number(), 3);
        d.undo();
        assert_eq!(d.next_number(), 2);
    }

    #[test]
    fn tool_keys_and_names_round_trip() {
        for t in ALL_TOOLS {
            assert_eq!(Tool::from_key(t.key()), Some(t));
            assert_eq!(Tool::from_name(t.name()), Some(t));
        }
        assert_eq!(Tool::from_key('z'), None);
    }
}
