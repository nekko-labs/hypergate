//! The tray icon, drawn in code rather than shipped as an asset.
//!
//! It reproduces the Hypergate warp-gate mark (a hollow, banded violet→cyan
//! ring) as raw RGBA. Generating it means no `.ico`/`.png` to embed, decode, or
//! keep in sync across three platforms, and the brand colours live in one place
//! next to the CSS tokens they mirror.

use tray_icon::Icon;

const SIZE: u32 = 32;
/// 3×3 supersampling per pixel. Cheap at this size and the difference between a
/// crisp mark and a jagged one in a 16px tray slot.
const SAMPLES: u32 = 3;

/// `#6d5efc` — the violet end of the brand gradient.
const VIOLET: [f32; 3] = [109.0, 94.0, 252.0];
/// `#22d3ee` — the cyan end.
const CYAN: [f32; 3] = [34.0, 211.0, 238.0];
/// `#a5f3fc` — the bright ice crest from the hero shader.
const ICE: [f32; 3] = [165.0, 243.0, 252.0];
/// `#7c6bff` — the halo tint used by the site.
const HALO: [f32; 3] = [124.0, 107.0, 255.0];

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
///
/// All radii are expressed in the original 32px design grid and scaled to
/// `size`, so one geometry definition serves a 16px tray slot and a 256px
/// Explorer thumbnail alike.
fn sample(x: f32, y: f32, size: u32, coloured: bool) -> ([f32; 3], f32) {
    let k = size as f32 / 32.0;
    let c = size as f32 / 2.0;
    let (dx, dy) = (x - c, y - c);
    let r = (dx * dx + dy * dy).sqrt() / k;

    // The ring: an annulus with both edges feathered. Feather widths shrink with
    // scale so a large icon gets a crisp edge instead of a blurry one.
    let feather = 1.2 / k.max(1.0);
    let ring = smoothstep(8.8, 8.8 + feather, r) * (1.0 - smoothstep(14.2 - feather, 14.2, r));

    // Several violet-dominant bands sweep around the ring, echoing the site's
    // animated shader without making the static mark look noisy.
    let angle = dy.atan2(dx); // -PI..PI
    let phase = 0.5 + 0.5 * (angle * 3.0 + 0.28 * (angle * 5.0).sin()).sin();
    let crest = phase.powf(3.2);
    let mut ring_rgb = if crest < 0.68 {
        let mix = crest / 0.68;
        [
            VIOLET[0] + (CYAN[0] - VIOLET[0]) * mix,
            VIOLET[1] + (CYAN[1] - VIOLET[1]) * mix,
            VIOLET[2] + (CYAN[2] - VIOLET[2]) * mix,
        ]
    } else {
        let mix = ((crest - 0.68) / 0.32) * 0.67;
        [
            CYAN[0] + (ICE[0] - CYAN[0]) * mix,
            CYAN[1] + (ICE[1] - CYAN[1]) * mix,
            CYAN[2] + (ICE[2] - CYAN[2]) * mix,
        ]
    };
    // A short ice-white hot arc adds the premium highlight without painting
    // anything into the portal opening.
    let hot_arc = ((angle + 0.55).cos().max(0.0)).powf(18.0) * ring;
    ring_rgb[0] += (255.0 - ring_rgb[0]) * hot_arc * 0.32;
    ring_rgb[1] += (255.0 - ring_rgb[1]) * hot_arc * 0.32;
    ring_rgb[2] += (255.0 - ring_rgb[2]) * hot_arc * 0.32;
    if ring <= 0.0 {
        if coloured && r > 14.2 {
            let halo = (1.0 - smoothstep(14.2, 15.0, r)) * 0.40;
            if halo > 0.0 {
                return ([HALO[0] * halo, HALO[1] * halo, HALO[2] * halo], halo);
            }
        }
        return ([0.0; 3], 0.0);
    }
    let halo = if coloured && r > 14.2 {
        (1.0 - smoothstep(14.2, 15.0, r)) * 0.40
    } else {
        0.0
    };
    let coverage = (ring + halo).min(1.0);
    (
        [
            ring_rgb[0] * ring + HALO[0] * halo,
            ring_rgb[1] * ring + HALO[1] * halo,
            ring_rgb[2] * ring + HALO[2] * halo,
        ],
        coverage,
    )
}

/// Render the mark to RGBA8.
///
/// `template` produces a macOS template image: shape in the alpha channel with
/// black RGB, which AppKit then tints for the current menu bar appearance. A
/// coloured menu bar icon is the classic macOS mistake — it looks wrong in dark
/// mode and worse on a tinted wallpaper.
fn rgba_at(size: u32, template: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    let step = 1.0 / SAMPLES as f32;
    for py in 0..size {
        for px in 0..size {
            let mut acc = [0.0f32; 3];
            let mut alpha = 0.0f32;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = px as f32 + (sx as f32 + 0.5) * step;
                    let y = py as f32 + (sy as f32 + 0.5) * step;
                    let (rgb, a) = sample(x, y, size, !template);
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

/// The mark at the tray's own size.
fn rgba(template: bool) -> Vec<u8> {
    rgba_at(SIZE, template)
}

/// The tray icon for the current platform.
pub fn tray_icon() -> Result<Icon, String> {
    // macOS menu bar icons must be template images; Windows and Linux want the
    // real brand colours.
    let template = cfg!(target_os = "macos");
    Icon::from_rgba(rgba(template), SIZE, SIZE).map_err(|e| format!("could not build the tray icon: {e}"))
}

/// The manager window's titlebar/taskbar icon. Bigger than the tray's 32px:
/// Alt-Tab and the taskbar render at 48–64px, and scaling up a 32px mark
/// looks soft where rendering at 64px stays crisp.
pub fn window_icon() -> Result<tao::window::Icon, String> {
    const WINDOW_SIZE: u32 = 64;
    tao::window::Icon::from_rgba(rgba_at(WINDOW_SIZE, false), WINDOW_SIZE, WINDOW_SIZE)
        .map_err(|e| format!("could not build the window icon: {e}"))
}

/// Sizes a Windows `.ico` should carry: 16 for the Start Menu list, 32 for the
/// desktop, 48 for large icons, 256 for Explorer's extra-large view.
const ICO_SIZES: [u32; 4] = [16, 32, 48, 256];

/// The mark as a Windows `.ico`, for shortcut and window icons.
///
/// Uncompressed 32-bit BMP payloads rather than PNG ones: BMP needs no deflate
/// (so no dependency and nothing to get wrong), every Windows version reads it,
/// and a few hundred KB on disk is irrelevant for a file written once.
pub fn ico_bytes() -> Vec<u8> {
    const HEADER: usize = 6;
    const ENTRY: usize = 16;
    const DIB_HEADER: usize = 40;

    let images: Vec<(u32, Vec<u8>)> = ICO_SIZES.iter().map(|&s| (s, rgba_at(s, false))).collect();

    let mut dir = Vec::with_capacity(HEADER + ENTRY * images.len());
    dir.extend_from_slice(&0u16.to_le_bytes()); // reserved
    dir.extend_from_slice(&1u16.to_le_bytes()); // 1 = icon
    dir.extend_from_slice(&(images.len() as u16).to_le_bytes());

    let mut bodies: Vec<Vec<u8>> = Vec::with_capacity(images.len());
    for (size, rgba) in &images {
        // 1-bit AND mask: unused for 32-bit icons (alpha wins) but required by
        // the format. Rows are padded to a 4-byte boundary.
        let mask_row = ((*size).div_ceil(32) * 4) as usize;
        let mut body = Vec::with_capacity(DIB_HEADER + rgba.len() + mask_row * *size as usize);

        body.extend_from_slice(&(DIB_HEADER as u32).to_le_bytes()); // biSize
        body.extend_from_slice(&(*size as i32).to_le_bytes()); // biWidth
        // Doubled height: the format expects colour rows plus mask rows.
        body.extend_from_slice(&(*size as i32 * 2).to_le_bytes()); // biHeight
        body.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
        body.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
        body.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
        body.extend_from_slice(&0u32.to_le_bytes()); // biSizeImage (0 is fine for BI_RGB)
        body.extend_from_slice(&[0u8; 16]); // resolution + palette counts

        // BGRA, bottom-up.
        for y in (0..*size).rev() {
            for x in 0..*size {
                let i = ((y * size + x) * 4) as usize;
                body.extend_from_slice(&[rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]]);
            }
        }
        body.extend(std::iter::repeat_n(0u8, mask_row * *size as usize));
        bodies.push(body);
    }

    let mut offset = HEADER + ENTRY * images.len();
    for ((size, _), body) in images.iter().zip(&bodies) {
        // 256 is encoded as 0: the field is one byte.
        let dim = if *size >= 256 { 0u8 } else { *size as u8 };
        dir.push(dim); // width
        dir.push(dim); // height
        dir.push(0); // palette size (0 = no palette)
        dir.push(0); // reserved
        dir.extend_from_slice(&1u16.to_le_bytes()); // planes
        dir.extend_from_slice(&32u16.to_le_bytes()); // bit count
        dir.extend_from_slice(&(body.len() as u32).to_le_bytes());
        dir.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += body.len();
    }

    for body in bodies {
        dir.extend_from_slice(&body);
    }
    dir
}

/// The mark as an SVG, for the XDG icon theme on Linux.
///
/// Scalable beats a raster pyramid here: freedesktop themes look in
/// `scalable/apps` first, and one vector file covers every panel size a desktop
/// environment might ask for. Kept in code so the geometry and the brand colours
/// stay beside the raster renderer above rather than drifting from it.
pub fn svg() -> String {
    let hex = |c: [f32; 3]| format!("#{:02x}{:02x}{:02x}", c[0] as u8, c[1] as u8, c[2] as u8);
    // Ring radius and stroke width restated from `sample`'s 32px design grid:
    // centreline at (8.8 + 14.2) / 2, stroke spanning the annulus.
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="gate" gradientUnits="userSpaceOnUse" x1="2" y1="16" x2="30" y2="16">
      <stop offset="0" stop-color="{violet}"/>
      <stop offset=".18" stop-color="{violet}"/>
      <stop offset=".32" stop-color="{cyan}" stop-opacity=".78"/>
      <stop offset=".46" stop-color="{violet}"/>
      <stop offset=".62" stop-color="{violet}"/>
      <stop offset=".76" stop-color="{ice}" stop-opacity=".6"/>
      <stop offset=".9" stop-color="{violet}"/>
      <stop offset="1" stop-color="{violet}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation=".7"/>
    </filter>
  </defs>
  <circle cx="16" cy="16" r="11.5" fill="none" stroke="{halo}" stroke-width="2.2" opacity=".4" filter="url(#glow)"/>
  <circle cx="16" cy="16" r="11.5" fill="none" stroke="url(#gate)" stroke-width="5.4"/>
  <path d="M 8.1 9.3 A 11.5 11.5 0 0 1 22.2 7.8" fill="none" stroke="#d8fbff" stroke-width="1.9" stroke-linecap="round" opacity=".7"/>
</svg>
"##,
        violet = hex(VIOLET),
        cyan = hex(CYAN),
        ice = hex(ICE),
        halo = hex(HALO),
    )
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
    fn corners_and_centre_are_transparent() {
        let buf = rgba(false);
        let at = |x: u32, y: u32| {
            let i = ((y * SIZE + x) * 4) as usize;
            (buf[i], buf[i + 1], buf[i + 2], buf[i + 3])
        };
        assert_eq!(at(0, 0).3, 0, "top-left corner should be transparent");
        assert_eq!(at(SIZE - 1, SIZE - 1).3, 0, "bottom-right corner should be transparent");
        assert_eq!(at(SIZE / 2, SIZE / 2).3, 0, "the gate opening should be transparent");
    }

    #[test]
    fn the_hollow_ring_is_drawn() {
        let buf = rgba(false);
        let alpha_at = |x: u32, y: u32| buf[(((y * SIZE + x) * 4) + 3) as usize];
        // y = centre, x sweeping right: opening (16), inner gap (~23), ring (~27), outside (31).
        assert_eq!(alpha_at(16, 16), 0, "gate opening");
        assert!(alpha_at(23, 16) < 60, "space inside the ring");
        assert!(alpha_at(27, 16) > 200, "ring");
        assert!(alpha_at(30, 16) > 0, "subtle outer halo");
        assert!(alpha_at(30, 16) < 140, "halo must remain weaker than the ring");
        assert_eq!(alpha_at(31, 16), 0, "outside the ring");
    }

    #[test]
    fn a_violet_trough_stays_brand_saturated() {
        let (rgb, alpha) = sample(6.05, 10.25, SIZE, true);
        assert!(alpha > 0.9, "trough sample should be inside the ring");
        for (actual, expected) in rgb.into_iter().zip(VIOLET) {
            assert!(
                (actual - expected).abs() < 4.0,
                "violet trough was diluted: {actual} vs {expected}"
            );
        }
    }

    #[test]
    fn template_variant_is_black_with_shape_in_alpha() {
        let buf = rgba(true);
        let i = (((16 * SIZE) + 16) * 4) as usize;
        assert_eq!(
            (buf[i], buf[i + 1], buf[i + 2]),
            (0, 0, 0),
            "template RGB must be black"
        );
        assert_eq!(buf[i + 3], 0, "template center must preserve the gate opening");
    }

    #[test]
    fn the_mark_scales_to_other_sizes() {
        for size in [16u32, 48, 256] {
            let buf = rgba_at(size, false);
            assert_eq!(buf.len(), (size * size * 4) as usize, "{size}px buffer");
            let alpha = |x: u32, y: u32| buf[(((y * size + x) * 4) + 3) as usize];
            assert_eq!(alpha(0, 0), 0, "{size}px: corner should be transparent");
            assert_eq!(
                alpha(size / 2, size / 2),
                0,
                "{size}px: gate opening should be transparent"
            );
        }
    }

    #[test]
    fn writes_a_well_formed_ico() {
        let ico = ico_bytes();
        let u16at = |i: usize| u16::from_le_bytes([ico[i], ico[i + 1]]);
        let u32at = |i: usize| u32::from_le_bytes([ico[i], ico[i + 1], ico[i + 2], ico[i + 3]]);
        let i32at = |i: usize| i32::from_le_bytes([ico[i], ico[i + 1], ico[i + 2], ico[i + 3]]);

        assert_eq!(u16at(0), 0, "reserved");
        assert_eq!(u16at(2), 1, "type 1 = icon");
        let count = u16at(4) as usize;
        assert_eq!(count, ICO_SIZES.len());

        for (i, &size) in ICO_SIZES.iter().enumerate() {
            let e = 6 + i * 16;
            // 256 does not fit in the one-byte dimension field and is encoded as 0.
            let expected_dim = if size >= 256 { 0 } else { size as u8 };
            assert_eq!(ico[e], expected_dim, "{size}px width field");
            assert_eq!(ico[e + 1], expected_dim, "{size}px height field");
            assert_eq!(u16at(e + 6), 32, "{size}px bit depth");

            let len = u32at(e + 8) as usize;
            let off = u32at(e + 12) as usize;
            assert!(off + len <= ico.len(), "{size}px payload runs past the end");

            // The DIB header: width as-is, height doubled for the AND mask.
            assert_eq!(u32at(off), 40, "{size}px BITMAPINFOHEADER size");
            assert_eq!(i32at(off + 4), size as i32, "{size}px biWidth");
            assert_eq!(i32at(off + 8), size as i32 * 2, "{size}px biHeight");

            let mask_row = size.div_ceil(32) * 4;
            assert_eq!(
                len,
                40 + (size * size * 4 + mask_row * size) as usize,
                "{size}px payload length"
            );
        }
    }

    #[test]
    fn ico_pixels_are_bgra_bottom_up() {
        let ico = ico_bytes();
        // First entry is 16px; its pixel data starts after the 40-byte DIB header.
        let off = u32::from_le_bytes([ico[18], ico[19], ico[20], ico[21]]) as usize + 40;
        // Bottom-up means row 0 of the payload is the image's last row, which is
        // outside the mark and therefore fully transparent.
        assert_eq!(ico[off + 3], 0, "bottom row should be transparent");

        // The centre pixel of a 16px image, counting rows from the bottom.
        let centre = off + ((16 - 1 - 8) * 16 + 8) * 4;
        assert_eq!(ico[centre + 3], 0, "gate opening should be transparent");
    }

    #[test]
    fn writes_an_svg_carrying_the_brand_colours() {
        let svg = svg();
        assert!(svg.starts_with("<svg"), "must be a bare SVG document");
        assert!(svg.contains("viewBox=\"0 0 32 32\""));
        assert!(svg.contains("#6d5efc"), "violet stop missing");
        assert!(svg.contains("#22d3ee"), "cyan stop missing");
        assert!(svg.contains("r=\"11.5\""), "SVG must use the design-grid ring radius");
        assert!(
            svg.contains("stroke=\"url(#gate)\""),
            "SVG must use the banded stroke gradient"
        );
        assert!(!svg.contains("#baf6ff"), "the hollow gate must not render a core");
        assert!(svg.contains("</svg>"));
    }

    #[test]
    fn the_gradient_actually_varies_around_the_ring() {
        let buf = rgba(false);
        let px = |x: u32, y: u32| {
            let i = ((y * SIZE + x) * 4) as usize;
            (buf[i], buf[i + 1], buf[i + 2])
        };
        // The static mark has multiple band transitions, not one folded sweep.
        let points = [(16, 4), (27, 16), (16, 27), (5, 16), (16, 4)];
        let changes = points
            .windows(2)
            .filter(|pair| px(pair[0].0, pair[0].1) != px(pair[1].0, pair[1].1))
            .count();
        assert!(changes >= 3, "ring colour should band more than once around the ring");
    }
}
