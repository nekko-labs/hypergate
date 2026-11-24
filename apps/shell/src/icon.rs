//! Colored desktop icons are generated from the same SVG as the web favicons.
//! The macOS status item keeps its own monochrome, system-tinted ring.

use tray_icon::Icon;

const ICO: &[u8] = include_bytes!("../assets/hypergate.ico");
const SIZE: u32 = 32;

/// Our generated ICO uses 32-bit uncompressed DIBs. Reuse those frames for
/// native UI icons instead of bundling separate rasters or drawing a second mark.
fn rgba_at(size: u32) -> Vec<u8> {
    let count = u16::from_le_bytes([ICO[4], ICO[5]]) as usize;
    let dimension = (size % 256) as u8;
    let entry = ICO[6..6 + count * 16]
        .chunks_exact(16)
        .find(|entry| entry[0] == dimension && entry[1] == dimension)
        .expect("the generated asset includes the requested icon size");
    let start = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize + 40;
    let stride = size as usize * 4;
    let pixels = &ICO[start..start + stride * size as usize];
    let mut rgba = Vec::with_capacity(pixels.len());
    for row in pixels.rchunks_exact(stride) {
        for bgra in row.chunks_exact(4) {
            rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], bgra[3]]);
        }
    }
    rgba
}

/// Preserve the unbacked ring that AppKit tints for the current menu bar.
#[cfg(any(target_os = "macos", test))]
fn template_rgba() -> Vec<u8> {
    fn smoothstep(start: f32, end: f32, x: f32) -> f32 {
        let t = ((x - start) / (end - start)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }
    let mut out = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut alpha = 0.0;
            for sy in 0..3 {
                for sx in 0..3 {
                    let dx = x as f32 + (sx as f32 + 0.5) / 3.0 - 16.0;
                    let dy = y as f32 + (sy as f32 + 0.5) / 3.0 - 16.0;
                    let r = (dx * dx + dy * dy).sqrt();
                    alpha += smoothstep(8.8, 9.8, r) * (1.0 - smoothstep(14.2 - 1.0, 14.2, r));
                }
            }
            out.extend_from_slice(&[0, 0, 0, (alpha / 9.0 * 255.0).round() as u8]);
        }
    }
    out
}

pub fn tray_icon() -> Result<Icon, String> {
    #[cfg(target_os = "macos")]
    let rgba = template_rgba();
    #[cfg(not(target_os = "macos"))]
    let rgba = rgba_at(SIZE);
    Icon::from_rgba(rgba, SIZE, SIZE).map_err(|e| format!("could not build the tray icon: {e}"))
}

pub fn window_icon() -> Result<tao::window::Icon, String> {
    const WINDOW_SIZE: u32 = 64;
    tao::window::Icon::from_rgba(rgba_at(WINDOW_SIZE), WINDOW_SIZE, WINDOW_SIZE)
        .map_err(|e| format!("could not build the window icon: {e}"))
}

#[cfg(target_os = "macos")]
pub fn menu_icon() -> Result<muda::Icon, String> {
    const MENU_SIZE: u32 = 128;
    muda::Icon::from_rgba(rgba_at(MENU_SIZE), MENU_SIZE, MENU_SIZE)
        .map_err(|e| format!("could not build the menu icon: {e}"))
}

pub fn ico_bytes() -> Vec<u8> {
    ICO.to_vec()
}

/// Used by the Linux shortcut and icon theme.
pub fn svg() -> String {
    include_str!("../../site/public/favicon.svg").to_owned()
}

pub fn is_template() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZES: [u32; 6] = [16, 32, 48, 64, 128, 256];

    #[test]
    fn the_colored_icon_has_clear_corners_and_a_dark_open_center() {
        for size in SIZES {
            let buf = rgba_at(size);
            assert_eq!(buf.len(), (size * size * 4) as usize);
            assert_eq!(&buf[..4], &[0; 4], "transparent corner at {size}px");
            let i = ((size / 2 * size + size / 2) * 4) as usize;
            assert_eq!(buf[i + 3], 255, "opaque tile at {size}px");
            assert!(
                buf[i] < 40 && buf[i + 1] < 40 && buf[i + 2] < 65,
                "dark center at {size}px"
            );
            let ring = ((size / 2 * size + size * 4 / 5) * 4) as usize;
            assert!(buf[ring + 1] > 100 && buf[ring + 2] > 125, "cyan ring at {size}px");
        }
    }

    #[test]
    fn the_template_remains_an_unbacked_monochrome_ring() {
        let rgba = template_rgba();
        let alpha = |x, y| rgba[((y * SIZE + x) * 4 + 3) as usize];
        assert!(rgba.chunks_exact(4).all(|rgba| rgba[..3] == [0; 3]));
        assert_eq!(alpha(0, 0), 0);
        assert_eq!(alpha(16, 16), 0);
        assert!(alpha(27, 16) > 200);
    }

    #[test]
    fn linux_uses_the_same_svg_as_the_browser() {
        assert_eq!(svg(), include_str!("../../web/public/favicon.svg"));
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
        assert_eq!(count, SIZES.len());

        for (i, &size) in SIZES.iter().enumerate() {
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
}
