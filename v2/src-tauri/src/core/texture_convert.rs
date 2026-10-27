//! Batch texture conversion: downscale, power-of-two snapping, normal map green flip
//! (DirectX <-> OpenGL) and format conversion to PNG / TGA / JPG / uncompressed DDS with mipmaps.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::image_ops::decode_rgba;
use crate::utils::paths::ext_lower;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutFormat {
    /// Same format as the source when it can be written, PNG otherwise.
    #[default]
    Keep,
    Png,
    Tga,
    Jpg,
    /// Uncompressed BGRA8 DDS (engines compress on import).
    Dds,
}

fn default_quality() -> u8 {
    90
}
fn default_output_dir() -> PathBuf {
    PathBuf::from("converted")
}
const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOptions {
    /// Longest side limit; larger images are downscaled keeping the aspect ratio.
    #[serde(default)]
    pub max_size: Option<u32>,
    /// Round each side to the nearest power of two (never above `max_size`).
    #[serde(default)]
    pub power_of_two: bool,
    #[serde(default)]
    pub format: OutFormat,
    /// Invert the green channel: DirectX <-> OpenGL normal maps.
    #[serde(default)]
    pub flip_green: bool,
    #[serde(default = "default_quality")]
    pub jpeg_quality: u8,
    #[serde(default = "yes")]
    pub dds_mipmaps: bool,
    /// Absolute, or relative to each source file's folder.
    #[serde(default = "default_output_dir")]
    pub output_dir: PathBuf,
    /// Appended to the output file stem, e.g. `_GL`.
    #[serde(default)]
    pub suffix: String,
    /// Replace existing files (including the source when it would be the output).
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub dry_run: bool,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        ConvertOptions {
            max_size: None,
            power_of_two: false,
            format: OutFormat::Keep,
            flip_green: false,
            jpeg_quality: default_quality(),
            dds_mipmaps: true,
            output_dir: default_output_dir(),
            suffix: String::new(),
            overwrite: false,
            dry_run: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertItem {
    pub source: PathBuf,
    pub output: Option<PathBuf>,
    pub from_size: Option<(u32, u32)>,
    pub to_size: Option<(u32, u32)>,
    pub bytes_before: u64,
    pub bytes_after: Option<u64>,
    pub written: bool,
    /// Not converted on purpose (HDR input, output exists, …).
    pub skipped: Option<String>,
    pub error: Option<String>,
}

/// Writable extension for the requested format and source.
fn output_ext(format: OutFormat, source: &Path) -> &'static str {
    match format {
        OutFormat::Png => "png",
        OutFormat::Tga => "tga",
        OutFormat::Jpg => "jpg",
        OutFormat::Dds => "dds",
        OutFormat::Keep => match ext_lower(source).as_str() {
            "tga" => "tga",
            "jpg" | "jpeg" => "jpg",
            "bmp" => "bmp",
            "tif" | "tiff" => "tif",
            _ => "png",
        },
    }
}

pub fn output_path(source: &Path, opts: &ConvertOptions) -> PathBuf {
    let dir = if opts.output_dir.is_absolute() { opts.output_dir.clone() } else { source.parent().unwrap_or(Path::new("")).join(&opts.output_dir) };
    let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    dir.join(format!("{stem}{}.{}", opts.suffix, output_ext(opts.format, source)))
}

fn nearest_pow2(v: u32) -> u32 {
    if v <= 1 {
        return 1;
    }
    let up = v.next_power_of_two();
    let down = up / 2;
    if v - down < up - v { down } else { up }
}

fn floor_pow2(v: u32) -> u32 {
    if v == 0 { 1 } else { 1 << (31 - v.leading_zeros()) }
}

/// Target size for `(w, h)` under the size options.
pub fn target_size(w: u32, h: u32, opts: &ConvertOptions) -> (u32, u32) {
    let (mut tw, mut th) = (w, h);
    if let Some(max) = opts.max_size.filter(|&m| m > 0) {
        let longest = w.max(h);
        if longest > max {
            let k = max as f64 / longest as f64;
            tw = ((w as f64 * k).round() as u32).max(1);
            th = ((h as f64 * k).round() as u32).max(1);
        }
    }
    if opts.power_of_two {
        let cap = opts.max_size.filter(|&m| m > 0).map(floor_pow2).unwrap_or(u32::MAX);
        tw = nearest_pow2(tw).min(cap);
        th = nearest_pow2(th).min(cap);
    }
    (tw, th)
}

fn opaque(img: &RgbaImage) -> bool {
    img.pixels().all(|p| p[3] == 255)
}

/// Uncompressed DDS (A8R8G8B8, legacy header) with an optional full mip chain.
pub fn write_dds(img: &RgbaImage, path: &Path, mipmaps: bool) -> Result<(), String> {
    let (w, h) = img.dimensions();
    let mut levels = vec![img.clone()];
    if mipmaps {
        let (mut mw, mut mh) = (w, h);
        while mw > 1 || mh > 1 {
            mw = (mw / 2).max(1);
            mh = (mh / 2).max(1);
            levels.push(image::imageops::resize(img, mw, mh, FilterType::Triangle));
        }
    }
    const CAPS: u32 = 0x1;
    const HEIGHT: u32 = 0x2;
    const WIDTH: u32 = 0x4;
    const PITCH: u32 = 0x8;
    const PIXELFORMAT: u32 = 0x1000;
    const MIPMAPCOUNT: u32 = 0x20000;
    let mut header: Vec<u32> = Vec::with_capacity(31);
    header.push(124);
    header.push(CAPS | HEIGHT | WIDTH | PITCH | PIXELFORMAT | if mipmaps { MIPMAPCOUNT } else { 0 });
    header.extend([h, w, w * 4, 0, levels.len() as u32]);
    header.extend([0u32; 11]);
    // DDS_PIXELFORMAT: RGB | ALPHAPIXELS, 32 bpp, BGRA masks
    header.extend([32, 0x40 | 0x1, 0, 32, 0x00ff_0000, 0x0000_ff00, 0x0000_00ff, 0xff00_0000]);
    let caps = 0x1000 | if mipmaps { 0x8 | 0x40_0000 } else { 0 };
    header.extend([caps, 0, 0, 0, 0]);

    let file = fs::File::create(path).map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    let mut out = BufWriter::new(file);
    let io = |e: std::io::Error| e.to_string();
    out.write_all(b"DDS ").map_err(io)?;
    for v in header {
        out.write_all(&v.to_le_bytes()).map_err(io)?;
    }
    for level in &levels {
        let bgra: Vec<u8> = level.pixels().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
        out.write_all(&bgra).map_err(io)?;
    }
    out.flush().map_err(io)
}

fn save(img: RgbaImage, path: &Path, ext: &str, opts: &ConvertOptions) -> Result<(), String> {
    let err = |e: image::ImageError| format!("Cannot write {}: {e}", path.display());
    match ext {
        "dds" => write_dds(&img, path, opts.dds_mipmaps),
        "jpg" => {
            let file = fs::File::create(path).map_err(|e| e.to_string())?;
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(BufWriter::new(file), opts.jpeg_quality.clamp(1, 100));
            DynamicImage::ImageRgba8(img).to_rgb8().write_with_encoder(enc).map_err(err)
        }
        _ => {
            let format = ImageFormat::from_extension(ext).unwrap_or(ImageFormat::Png);
            // Opaque images are written without alpha: smaller files, no surprise alpha channel in engines.
            if opaque(&img) && format != ImageFormat::Tga {
                DynamicImage::ImageRgba8(img).to_rgb8().save_with_format(path, format).map_err(err)
            } else {
                img.save_with_format(path, format).map_err(err)
            }
        }
    }
}

pub fn convert_one(source: &Path, opts: &ConvertOptions) -> ConvertItem {
    let bytes_before = fs::metadata(source).map(|m| m.len()).unwrap_or(0);
    let mut item = ConvertItem { source: source.to_path_buf(), output: None, from_size: None, to_size: None, bytes_before, bytes_after: None, written: false, skipped: None, error: None };
    let src_ext = ext_lower(source);
    if matches!(src_ext.as_str(), "exr" | "hdr") {
        item.skipped = Some("HDR source: 8-bit output would clip it".into());
        return item;
    }
    if src_ext == "dds" {
        item.skipped = Some("DDS input is not supported".into());
        return item;
    }
    let out = output_path(source, opts);
    item.output = Some(out.clone());
    let same_file = out == source;
    if out.exists() && !opts.overwrite {
        item.skipped = Some(if same_file { "Output would replace the source (enable overwrite)".into() } else { "Output exists (enable overwrite)".into() });
        return item;
    }

    let decoded = match decode_rgba(source) {
        Ok(d) => d,
        Err(e) => {
            item.error = Some(e);
            return item;
        }
    };
    let (w, h) = (decoded.width, decoded.height);
    let (tw, th) = target_size(w, h, opts);
    item.from_size = Some((w, h));
    item.to_size = Some((tw, th));
    if opts.dry_run {
        return item;
    }

    let mut img = RgbaImage::from_raw(w, h, decoded.pixels).expect("decoder returns w*h*4 bytes");
    if (tw, th) != (w, h) {
        img = image::imageops::resize(&img, tw, th, FilterType::Lanczos3);
    }
    if opts.flip_green {
        for p in img.pixels_mut() {
            p[1] = 255 - p[1];
        }
    }
    let result = out.parent().map_or(Ok(()), |d| fs::create_dir_all(d).map_err(|e| e.to_string())).and_then(|_| save(img, &out, output_ext(opts.format, source), opts));
    match result {
        Ok(()) => {
            item.written = true;
            item.bytes_after = fs::metadata(&out).map(|m| m.len()).ok();
        }
        Err(e) => item.error = Some(e),
    }
    item
}

pub fn convert_textures(paths: &[PathBuf], opts: &ConvertOptions) -> Vec<ConvertItem> {
    paths.par_iter().map(|p| convert_one(p, opts)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        let o = |max: Option<u32>, pow2: bool| ConvertOptions { max_size: max, power_of_two: pow2, ..Default::default() };
        assert_eq!(target_size(4096, 2048, &o(Some(1024), false)), (1024, 512));
        assert_eq!(target_size(500, 300, &o(Some(1024), false)), (500, 300), "never upscaled");
        assert_eq!(target_size(1000, 300, &o(None, true)), (1024, 256));
        assert_eq!(target_size(3000, 3000, &o(Some(2000), true)), (1024, 1024), "pow2 stays under the limit");
        assert_eq!(nearest_pow2(1), 1);
        assert_eq!(nearest_pow2(700), 512);
        assert_eq!(nearest_pow2(800), 1024);
    }

    #[test]
    fn output_paths() {
        let src = Path::new("/tex/rock_N.png");
        let mut o = ConvertOptions { format: OutFormat::Tga, suffix: "_GL".into(), ..Default::default() };
        assert_eq!(output_path(src, &o), PathBuf::from("/tex/converted/rock_N_GL.tga"));
        o.output_dir = PathBuf::from(".");
        o.format = OutFormat::Keep;
        assert_eq!(output_path(Path::new("/tex/a.psd"), &o), PathBuf::from("/tex/./a_GL.png"), "PSD is written as PNG");
    }

    #[test]
    fn converts_flips_and_skips() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("brick_N.png");
        RgbaImage::from_pixel(64, 32, image::Rgba([128, 200, 255, 255])).save(&src).unwrap();
        let hdr = dir.path().join("sky.hdr");
        fs::write(&hdr, b"#?RADIANCE").unwrap();

        let opts = ConvertOptions { max_size: Some(16), flip_green: true, format: OutFormat::Tga, ..Default::default() };
        let items = convert_textures(&[src.clone(), hdr], &opts);
        let ok = &items[0];
        assert!(ok.written, "{ok:?}");
        assert_eq!((ok.from_size, ok.to_size), (Some((64, 32)), Some((16, 8))));
        let out = image::open(ok.output.as_ref().unwrap()).unwrap().to_rgba8();
        assert_eq!(out.dimensions(), (16, 8));
        assert_eq!(out.get_pixel(3, 3).0, [128, 55, 255, 255]);
        assert!(items[1].skipped.is_some());

        let again = convert_one(&src, &opts);
        assert!(again.skipped.is_some() && !again.written, "existing output is kept");
        let dry = convert_one(&src, &ConvertOptions { dry_run: true, overwrite: true, ..opts.clone() });
        assert!(!dry.written && dry.to_size == Some((16, 8)));

        let in_place = ConvertOptions { output_dir: PathBuf::from("."), format: OutFormat::Keep, ..Default::default() };
        assert!(convert_one(&src, &in_place).skipped.unwrap().contains("source"));
    }

    #[test]
    fn dds_layout_with_mips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.dds");
        write_dds(&RgbaImage::from_pixel(4, 2, image::Rgba([10, 20, 30, 40])), &p, true).unwrap();
        let b = fs::read(&p).unwrap();
        let u = |i: usize| u32::from_le_bytes(b[4 + i * 4..8 + i * 4].try_into().unwrap());
        assert_eq!(&b[..4], b"DDS ");
        assert_eq!((u(0), u(2), u(3), u(6)), (124, 2, 4, 3), "size, height, width, 3 mip levels");
        assert_eq!(b.len(), 128 + (8 + 2 + 1) * 4);
        assert_eq!(&b[128..132], &[30, 20, 10, 40], "BGRA order");
    }
}
