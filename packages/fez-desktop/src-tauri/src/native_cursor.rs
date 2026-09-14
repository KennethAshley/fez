//! A host-drawn pointer: absent from page screenshots and transparent to human input.
use std::{cell::RefCell, collections::HashMap, time::Instant};
use objc2::{define_class, msg_send, rc::Retained, runtime::AnyObject, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSBezierPath, NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSStringDrawing, NSView, NSWorkspace};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};
use serde_json::{json, Value};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Palette { background: [u8; 3], foreground: [u8; 3] }
impl Default for Palette {
    fn default() -> Self { Self { background: [29,32,33], foreground: [235,219,178] } }
}

#[derive(Default)]
struct Paint {
    point: Option<(f64, f64)>, viewport: (f64, f64), label: String,
    moving: bool, pressed: Option<Instant>, reduced_motion: bool,
    palette: Palette,
}

define_class!(
    #[unsafe(super(NSView))]
    #[name = "FezAgentCursor"]
    #[thread_kind = MainThreadOnly]
    #[ivars = RefCell<Paint>]
    struct CursorView;

    impl CursorView {
        #[unsafe(method(isFlipped))]
        fn flipped(&self) -> bool { true }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView { std::ptr::null_mut() }

        #[unsafe(method(drawRect:))]
        fn draw(&self, _dirty: NSRect) {
            let paint = self.ivars().borrow();
            let Some((x, y)) = paint.point else { return };
            let bounds = self.bounds();
            let x = (x * bounds.size.width / paint.viewport.0).round();
            let y = (y * bounds.size.height / paint.viewport.1).round();
            let ink = NSColor::colorWithSRGBRed_green_blue_alpha(29./255.,32./255.,33./255.,1.);
            let parchment = NSColor::colorWithSRGBRed_green_blue_alpha(235./255.,219./255.,178./255.,1.);
            let orange = NSColor::colorWithSRGBRed_green_blue_alpha(1.,106./255.,0.,1.);
            let rect = |x, y, w, h| NSBezierPath::bezierPathWithRect(NSRect::new(NSPoint::new(x,y),NSSize::new(w,h))).fill();
            if let Some(pressed) = paint.pressed {
                let t = pressed.elapsed().as_secs_f64() / 0.45;
                if t < 1. {
                    let radius = if paint.reduced_motion { 12. } else { 8. + (t * 6.).floor() * 2. };
                    // Four tile corners flash outward on the actual mouse-down.
                    NSColor::colorWithSRGBRed_green_blue_alpha(1.,106./255.,0.,0.9*(1.-t)).set();
                    for dx in [-1.,1.] { for dy in [-1.,1.] {
                        let left = x + dx * radius; let top = y + dy * radius;
                        rect(left - if dx > 0. { 4. } else { 0. },top,6.,2.);
                        rect(left,top - if dy > 0. { 4. } else { 0. },2.,6.);
                    } }
                }
            }
            // Two-point tiles keep the arrow crisp on both Retina and 1× displays.
            for (row, pixels) in [
                "#", "##", "#.#", "#.*#", "#.**#", "#.***#", "#.****#",
                "#.*****#", "#.**#####", "#.*#*#", "#.# #*#", "##  #*#", "     #",
            ].iter().enumerate() {
                for (column, pixel) in pixels.bytes().enumerate() {
                    match pixel { b'#' => ink.set(), b'.' => parchment.set(), b'*' => orange.set(), _ => continue }
                    rect(x+column as f64*2.,y+row as f64*2.,2.,2.);
                }
            }

            let text = NSString::from_str(&paint.label);
            let font = NSFont::monospacedSystemFontOfSize_weight(11.,0.5);
            let color = |rgb: [u8;3]| NSColor::colorWithSRGBRed_green_blue_alpha(f64::from(rgb[0])/255.,f64::from(rgb[1])/255.,f64::from(rgb[2])/255.,1.);
            let background = color(paint.palette.background);
            let foreground = color(paint.palette.foreground);
            // The dictionary keys specify the corresponding AppKit value types.
            let attrs = unsafe { NSDictionary::from_slices(
                &[NSFontAttributeName, NSForegroundColorAttributeName],
                &[font.as_ref() as &AnyObject, foreground.as_ref() as &AnyObject]) };
            let size = unsafe { text.sizeWithAttributes(Some(&attrs)) };
            let width = (size.width.ceil() + 16.).min(bounds.size.width);
            let left = (x + 16.).min(bounds.size.width - width - 2.).max(0.).floor();
            let top = (y + 24.).min(bounds.size.height - 24.).max(0.).floor();
            ink.set(); rect(left+2.,top+2.,width,22.);
            foreground.set(); rect(left,top,width,22.);
            background.set(); rect(left+1.,top+1.,width-2.,20.);
            orange.set(); rect(left,top,3.,22.);
            unsafe { text.drawAtPoint_withAttributes(NSPoint::new(left+9.,top+4.),Some(&attrs)); }
        }
    }
);

thread_local! { static CURSOR: RefCell<HashMap<String, Retained<CursorView>>> = RefCell::new(HashMap::new()); }

pub(super) fn install(id: &str, browser: &NSView, palette: Palette) {
    remove(id);
    let mtm = MainThreadMarker::new().expect("native cursor runs on the main thread");
    let this = CursorView::alloc(mtm).set_ivars(RefCell::new(Paint { palette, ..Paint::default() }));
    let view: Retained<CursorView> = unsafe { msg_send![super(this), initWithFrame: browser.bounds()] };
    view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
    view.setWantsLayer(true);
    view.setHidden(true);
    browser.addSubview(&view);
    CURSOR.with(|slot| slot.borrow_mut().insert(id.into(), view));
}

pub(super) fn remove(id: &str) {
    CURSOR.with(|slot| { if let Some(view) = slot.borrow_mut().remove(id) { view.removeFromSuperview(); } });
}
pub(super) fn hide(id: &str) {
    CURSOR.with(|slot| { if let Some(view) = slot.borrow().get(id) {
        view.setHidden(true); let mut paint = view.ivars().borrow_mut();
        *paint = Paint { palette: paint.palette, ..Paint::default() };
    } });
}
pub(super) fn set_palette(id: &str, palette: Palette) {
    CURSOR.with(|slot| { if let Some(view) = slot.borrow().get(id) {
        view.ivars().borrow_mut().palette = palette; view.setNeedsDisplay(true);
    } });
}
pub(super) fn begin(id: &str, viewport: (f64,f64), label: String) -> Result<((f64,f64),bool), String> {
    CURSOR.with(|slot| {
        let slot = slot.borrow(); let view = slot.get(id).ok_or("agent cursor is unavailable")?;
        let mut paint = view.ivars().borrow_mut();
        let start = paint.point.unwrap_or((24_f64.min(viewport.0-1.),24_f64.min(viewport.1-1.)));
        let reduced_motion = NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion();
        *paint = Paint { point: Some(start), viewport, label, moving: true, pressed: None, reduced_motion, palette: paint.palette };
        drop(paint); view.setHidden(false); view.setNeedsDisplay(true);
        Ok((start,reduced_motion))
    })
}
pub(super) fn move_to(id: &str, x: f64, y: f64) {
    CURSOR.with(|slot| { if let Some(view) = slot.borrow().get(id) { view.ivars().borrow_mut().point = Some((x,y)); view.setNeedsDisplay(true); } });
}
pub(super) fn press(id: &str) {
    CURSOR.with(|slot| { if let Some(view) = slot.borrow().get(id) {
        let mut paint = view.ivars().borrow_mut(); paint.moving = false; paint.pressed = Some(Instant::now());
        drop(paint); view.setNeedsDisplay(true);
    } });
}
pub(super) fn redraw(id: &str) {
    CURSOR.with(|slot| { if let Some(view) = slot.borrow().get(id) { view.setNeedsDisplay(true); } });
}
pub(super) fn snapshot(id: &str) -> Value {
    CURSOR.with(|slot| {
        let slot = slot.borrow(); let Some(view) = slot.get(id).filter(|v| !v.isHidden()) else { return Value::Null };
        let paint = view.ivars().borrow(); let Some((x,y)) = paint.point else { return Value::Null };
        json!({"x":x,"y":y,"label":paint.label,"palette":paint.palette,"phase":if paint.moving {"moving"} else if paint.pressed.is_some_and(|t| t.elapsed().as_millis()<450) {"pressed"} else {"idle"}})
    })
}
