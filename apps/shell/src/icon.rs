//! The tray icon, drawn in code rather than shipped as an asset.
//!
//! It reproduces the Hypergate warp-gate mark (a violet→cyan gradient ring with
//! a glowing core) as raw RGBA. Generating it means no `.ico`/`.png` to embed,
//! decode, or keep in sync across three platforms, and the brand colours live in
//! one place next to the CSS tokens they mirror.

use tray_icon::Icon;

const SIZE: u32 = 32;
/// 3×3 supersampling per pixel. Cheap at this size and the difference between a
/// crisp mark and a jagged one in a 16px tray slot.
const SAMPLES: u32 = 3;

/// `#8b5cf6` — the violet end of the brand gradient.
const VIOLET: [f32; 3] = [139.0, 92.0, 246.0];
/// `#22d3ee` — the cyan end.
const CYAN: [f32; 3] = [34.0, 211.0, 238.0];

/// Smooth 0→1 ramp across `[edge0, edge1]`, for antialiased edges.
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Coverage and colour of the mark at one sub-sample point.
///
/// Returns premultiplied-by-coverage colour plus the coverage itself, so the
/// caller can average sub-samples correctly (averaging straight RGB would let
/// transparent samples darken the edges).
fn sample(x: f32, y: f32) -> ([f32; 3], f32) {
    let c = SIZE as f32 / 2.0;
    let (dx, dy) = (x - c, y - c);
    let r = (dx * dx + dy * dy).sqrt();

    // The ring: an annulus with both edges feathered.
    let ring = smoothstep(8.6, 9.8, r) * (1.0 - smoothstep(13.4, 14.6, r));
    // The core: a soft glowing centre.
    let core = 1.0 - smoothstep(1.8, 5.2, r);

    // Hue sweeps violet→cyan around the ring, so the gradient reads as motion.
    let angle = dy.atan2(dx); // -PI..PI
    let t = (angle + std::f32::consts::PI) / (2.0 * std::f32::consts::PI);
    // Fold the sweep so both halves of the ring run through the full gradient
    // instead of showing a hard seam where the angle wraps.
    let t = 1.0 - (2.0 * t - 1.0).abs();
    let ring_rgb = [
        VIOLET[0] + (CYAN[0] - VIOLET[0]) * t,
        VIOLET[1] + (CYAN[1] - VIOLET[1]) * t,
        VIOLET[2] + (CYAN[2] - VIOLET[2]) * t,
    ];
    // The core is a brighter, whiter cyan so it reads as "lit" against the ring.
    let core_rgb = [186.0, 246.0, 255.0];

    let alpha = (ring + core).min(1.0);
    if alpha <= 0.0 {
        return ([0.0; 3], 0.0);
    }
    // Composite core over ring by their relative weights.
    let core_weight = (core / (ring + core).max(f32::EPSILON)).clamp(0.0, 1.0);
    let rgb = [
        ring_rgb[0] + (core_rgb[0] - ring_rgb[0]) * core_weight,
        ring_rgb[1] + (core_rgb[1] - ring_rgb[1]) * core_weight,
        ring_rgb[2] + (core_rgb[2] - ring_rgb[2]) * core_weight,
    ];
    ([rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha], alpha)
}

/// Render the mark to RGBA8.
///
/// `template` produces a macOS template image: shape in the alpha channel with
/// black RGB, which AppKit then tints for the current menu bar appearance. A
/// coloured menu bar icon is the classic macOS mistake — it looks wrong in dark
/// mode and worse on a tinted wallpaper.
fn rgba(template: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let step = 1.0 / SAMPLES as f32;
    for py in 0..SIZE {
        for px in 0..SIZE {
            let mut acc = [0.0f32; 3];
            let mut alpha = 0.0f32;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = px as f32 + (sx as f32 + 0.5) * step;
                    let y = py as f32 + (sy as f32 + 0.5) * step;
                    let (rgb, a) = sample(x, y);
                    acc[0] += rgb[0];
                    acc[1] += rgb[1];
                    acc[2] += rgb[2];
                    alpha += a;
                }
            }
            let n = (SAMPLES * SAMPLES) as f32;
            let a = alpha / n;
            if a <= 0.001 {
                out.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            if template {
                out.extend_from_slice(&[0, 0, 0, (a * 255.0).round() as u8]);
            } else {
                // Un-premultiply back to straight alpha, which is what RGBA8 wants.
                let unmul = |v: f32| ((v / n) / a).round().clamp(0.0, 255.0) as u8;
                out.extend_from_slice(&[unmul(acc[0]), unmul(acc[1]), unmul(acc[2]), (a * 255.0).round() as u8]);
            }
        }
    }
    out
}

/// The tray icon for the current platform.
pub fn tray_icon() -> Result<Icon, String> {
    // macOS menu bar icons must be template images; Windows and Linux want the
    // real brand colours.
    let template = cfg!(target_os = "macos");
    Icon::from_rgba(rgba(template), SIZE, SIZE).map_err(|e| format!("could not build the tray icon: {e}"))
}

/// True when the tray icon should be handed to the OS as a template image.
pub fn is_template() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_full_rgba_buffer() {
        let buf = rgba(false);
        assert_eq!(buf.len(), (SIZE * SIZE * 4) as usize);
    }

    #[test]
    fn corners_are_transparent_and_the_centre_is_lit() {
        let buf = rgba(false);
        let at = |x: u32, y: u32| {
            let i = ((y * SIZE + x) * 4) as usize;
            (buf[i], buf[i + 1], buf[i + 2], buf[i + 3])
        };
        assert_eq!(at(0, 0).3, 0, "top-left corner should be transparent");
        assert_eq!(at(SIZE - 1, SIZE - 1).3, 0, "bottom-right corner should be transparent");
        assert!(at(SIZE / 2, SIZE / 2).3 > 200, "the core should be opaque");
    }

    #[test]
    fn the_ring_is_drawn_and_the_gap_between_ring_and_core_is_clear() {
        let buf = rgba(false);
        let alpha_at = |x: u32, y: u32| buf[(((y * SIZE + x) * 4) + 3) as usize];
        // y = centre, x sweeping right: core (16), gap (~23), ring (~27), outside (31).
        assert!(alpha_at(16, 16) > 200, "core");
        assert!(alpha_at(23, 16) < 60, "gap between core and ring");
        assert!(alpha_at(27, 16) > 200, "ring");
        assert_eq!(alpha_at(31, 16), 0, "outside the ring");
    }

    #[test]
    fn template_variant_is_black_with_shape_in_alpha() {
        let buf = rgba(true);
        let i = (((16 * SIZE) + 16) * 4) as usize;
        assert_eq!((buf[i], buf[i + 1], buf[i + 2]), (0, 0, 0), "template RGB must be black");
        assert!(buf[i + 3] > 200, "template alpha must carry the shape");
    }

    #[test]
    fn the_gradient_actually_varies_around_the_ring() {
        let buf = rgba(false);
        let px = |x: u32, y: u32| {
            let i = ((y * SIZE + x) * 4) as usize;
            (buf[i], buf[i + 1], buf[i + 2])
        };
        // Top of the ring versus the right-hand side: different points on the sweep.
        assert_ne!(px(16, 4), px(27, 16), "ring colour should change with angle");
    }
}
