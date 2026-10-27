//! Texture decoding for the previewer (incl. a PSD composite reader) and ORM channel packing.

use std::fs;
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{GrayImage, ImageFormat, RgbImage};
use serde::{Deserialize, Serialize};

use crate::utils::paths::ext_lower;

/// Decoded 8-bit RGBA pixels.
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    /// `width u32 LE | height u32 LE | RGBA8 pixels`, the layout `decode_image` sends to the UI.
    pub fn into_bytes(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.pixels.len());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend(self.pixels);
        out
    }
}

/// Decode formats the webview cannot (PSD, TIFF) or any other `image`-supported file to RGBA8.
pub fn decode_rgba(path: &Path) -> Result<RgbaImage, String> {
    if ext_lower(path) == "psd" {
        let data = fs::read(path).map_err(|e| e.to_string())?;
        return decode_psd(&data);
    }
    let img = open_image(path)?.to_rgba8();
    Ok(RgbaImage { width: img.width(), height: img.height(), pixels: img.into_raw() })
}

/// Open by content first, so assets with the wrong extension (a PNG saved as .tga) still decode.
pub fn open_image(path: &Path) -> Result<image::DynamicImage, String> {
    let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    let reader = image::ImageReader::open(path).and_then(|r| r.with_guessed_format()).map_err(|e| err(&e))?;
    reader.decode().map_err(|e| err(&e))
}

// --------------------------------------------------------------------------- PSD

struct Reader<'a> {
    buf: &'a [u8],
    off: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.off.checked_add(n).filter(|&e| e <= self.buf.len()).ok_or("Truncated PSD file")?;
        let s = &self.buf[self.off..end];
        self.off = end;
        Ok(s)
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn skip_section(&mut self, wide: bool) -> Result<(), String> {
        let len = if wide { self.u64()? as usize } else { self.u32()? as usize };
        self.take(len).map(|_| ())
    }
}

/// PackBits (PSD RLE) row decoder.
fn unpack_bits(src: &[u8], expected: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let start = out.len();
    let mut i = 0;
    while i < src.len() && out.len() - start < expected {
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let len = n as usize + 1;
            out.extend_from_slice(src.get(i..i + len).ok_or("Corrupt RLE data")?);
            i += len;
        } else if n != -128 {
            let b = *src.get(i).ok_or("Corrupt RLE data")?;
            out.extend(std::iter::repeat_n(b, (1 - n as isize) as usize));
            i += 1;
        }
    }
    out.resize(start + expected, 0);
    Ok(())
}

/// Composite ("merged") image of a PSD / PSB: RGB, grayscale, indexed and CMYK at 8, 16 or 32 bits.
pub fn decode_psd(data: &[u8]) -> Result<RgbaImage, String> {
    let mut r = Reader { buf: data, off: 0 };
    if r.take(4)? != b"8BPS" {
        return Err("Not a PSD file".into());
    }
    let version = r.u16()?;
    let wide = version == 2;
    r.take(6)?;
    let channels = r.u16()? as usize;
    let height = r.u32()? as usize;
    let width = r.u32()? as usize;
    let depth = r.u16()?;
    let mode = r.u16()?;
    if !matches!(depth, 8 | 16 | 32) {
        return Err(format!("Unsupported PSD bit depth {depth}"));
    }
    let color_data_len = r.u32()? as usize;
    let palette = r.take(color_data_len)?.to_vec();
    r.skip_section(false)?; // image resources
    r.skip_section(wide)?; // layer and mask info

    let bps = depth as usize / 8;
    let row_bytes = width * bps;
    let plane_bytes = row_bytes * height;
    let compression = r.u16()?;
    let mut planes: Vec<u8> = Vec::with_capacity(plane_bytes * channels);
    match compression {
        0 => planes.extend_from_slice(r.take(plane_bytes * channels)?),
        1 => {
            let rows = channels * height;
            let counts: Vec<usize> = (0..rows).map(|_| if wide { r.u32().map(|v| v as usize) } else { r.u16().map(|v| v as usize) }).collect::<Result<_, _>>()?;
            for c in counts {
                unpack_bits(r.take(c)?, row_bytes, &mut planes)?;
            }
        }
        other => return Err(format!("Unsupported PSD compression {other} (ZIP)")),
    }

    let sample = |ch: usize, i: usize| -> u8 {
        let p = ch * plane_bytes + i * bps;
        match bps {
            1 => planes[p],
            2 => planes[p], // big-endian: high byte first
            _ => (f32::from_be_bytes(planes[p..p + 4].try_into().unwrap()).clamp(0.0, 1.0) * 255.0).round() as u8,
        }
    };
    let n = width * height;
    let mut px = vec![0u8; n * 4];
    for i in 0..n {
        let (rgb, alpha_ch) = match mode {
            3 if channels >= 3 => ([sample(0, i), sample(1, i), sample(2, i)], 3),
            1 => {
                let g = sample(0, i);
                ([g, g, g], 1)
            }
            2 => {
                let idx = sample(0, i) as usize;
                let at = |k: usize| palette.get(k * 256 + idx).copied().unwrap_or(0);
                ([at(0), at(1), at(2)], 1)
            }
            4 if channels >= 4 => {
                // Stored inverted: 255 means no ink.
                let k = sample(3, i) as u32;
                let f = |c: u8| ((c as u32 * k) / 255) as u8;
                ([f(sample(0, i)), f(sample(1, i)), f(sample(2, i))], 4)
            }
            m => return Err(format!("Unsupported PSD color mode {m}")),
        };
        let a = if channels > alpha_ch { sample(alpha_ch, i) } else { 255 };
        px[i * 4..i * 4 + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], a]);
    }
    Ok(RgbaImage { width: width as u32, height: height as u32, pixels: px })
}

// --------------------------------------------------------------------------- ORM packing

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OrmFormat {
    #[default]
    Png,
    Tga,
}

/// Channel layout follows the ORM name (Unreal convention): R = AO, G = Roughness, B = Metallic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrmPackConfig {
    #[serde(default)]
    pub roughness_path: Option<PathBuf>,
    #[serde(default)]
    pub metallic_path: Option<PathBuf>,
    #[serde(default)]
    pub ao_path: Option<PathBuf>,
    pub output_path: PathBuf,
    #[serde(default)]
    pub format: OrmFormat,
    /// Input is a gloss / smoothness map: invert it into roughness.
    #[serde(default)]
    pub roughness_from_gloss: bool,
}

/// Values used for a channel whose input is missing.
pub const DEFAULT_AO: u8 = 255;
pub const DEFAULT_ROUGHNESS: u8 = 128;
pub const DEFAULT_METALLIC: u8 = 0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrmPackResult {
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
}

fn load_gray(path: &Option<PathBuf>) -> Result<Option<GrayImage>, String> {
    match path {
        None => Ok(None),
        Some(p) => open_image(p).map(|i| Some(i.to_luma8())),
    }
}

pub fn pack_orm(cfg: &OrmPackConfig) -> Result<OrmPackResult, String> {
    let ao = load_gray(&cfg.ao_path)?;
    let mut rough = load_gray(&cfg.roughness_path)?;
    let metal = load_gray(&cfg.metallic_path)?;
    if cfg.roughness_from_gloss {
        if let Some(r) = rough.as_mut() {
            image::imageops::invert(r);
        }
    }
    let inputs = [&ao, &rough, &metal];
    let (width, height) = inputs
        .iter()
        .filter_map(|i| i.as_ref().map(|g| g.dimensions()))
        .max_by_key(|(w, h)| (*w as u64) * (*h as u64))
        .ok_or("Pick at least one input texture")?;
    // Smaller inputs are resampled to the largest one.
    let fit = |img: &Option<GrayImage>| {
        img.as_ref().map(|g| if g.dimensions() == (width, height) { g.clone() } else { image::imageops::resize(g, width, height, FilterType::Triangle) })
    };
    let (ao, rough, metal) = (fit(&ao), fit(&rough), fit(&metal));
    let at = |img: &Option<GrayImage>, x: u32, y: u32, default: u8| img.as_ref().map_or(default, |g| g.get_pixel(x, y)[0]);
    let out = RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([at(&ao, x, y, DEFAULT_AO), at(&rough, x, y, DEFAULT_ROUGHNESS), at(&metal, x, y, DEFAULT_METALLIC)])
    });

    let format = match cfg.format {
        OrmFormat::Png => ImageFormat::Png,
        OrmFormat::Tga => ImageFormat::Tga,
    };
    let ext = if cfg.format == OrmFormat::Png { "png" } else { "tga" };
    let output_path = if ext_lower(&cfg.output_path) == ext { cfg.output_path.clone() } else { cfg.output_path.with_extension(ext) };
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    out.save_with_format(&output_path, format).map_err(|e| format!("Cannot write {}: {e}", output_path.display()))?;
    Ok(OrmPackResult { output_path, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal PSD writer for tests: planar channels, raw or PackBits (literal runs only).
    fn psd(width: u32, height: u32, mode: u16, planes: &[Vec<u8>], rle: bool) -> Vec<u8> {
        let mut v = b"8BPS".to_vec();
        v.extend(1u16.to_be_bytes());
        v.extend([0u8; 6]);
        v.extend((planes.len() as u16).to_be_bytes());
        v.extend(height.to_be_bytes());
        v.extend(width.to_be_bytes());
        v.extend(8u16.to_be_bytes());
        v.extend(mode.to_be_bytes());
        v.extend(0u32.to_be_bytes()); // color mode data
        v.extend(0u32.to_be_bytes()); // resources
        v.extend(0u32.to_be_bytes()); // layers
        v.extend((rle as u16).to_be_bytes());
        if rle {
            let rows: Vec<Vec<u8>> = planes.iter().flat_map(|p| p.chunks(width as usize).map(|row| {
                // one literal run per row (rows here are <= 128 bytes) except a repeat run for uniform rows
                if row.iter().all(|&b| b == row[0]) && row.len() > 1 { vec![(1i8 - row.len() as i8) as u8, row[0]] } else { [vec![(row.len() - 1) as u8], row.to_vec()].concat() }
            })).collect();
            for r in &rows {
                v.extend((r.len() as u16).to_be_bytes());
            }
            for r in rows {
                v.extend(r);
            }
        } else {
            for p in planes {
                v.extend(p);
            }
        }
        v
    }

    #[test]
    fn psd_rgba_raw_and_rle() {
        let (w, h) = (3u32, 2u32);
        let planes = vec![vec![10, 20, 30, 40, 50, 60], vec![1, 2, 3, 4, 5, 6], vec![200; 6], vec![255, 255, 255, 0, 0, 0]];
        for rle in [false, true] {
            let img = decode_psd(&psd(w, h, 3, &planes, rle)).unwrap();
            assert_eq!((img.width, img.height), (3, 2));
            assert_eq!(&img.pixels[..4], &[10, 1, 200, 255], "rle={rle}");
            assert_eq!(&img.pixels[20..24], &[60, 6, 200, 0], "rle={rle}");
        }
    }

    #[test]
    fn psd_grayscale_and_errors() {
        let img = decode_psd(&psd(2, 1, 1, &[vec![7, 9]], false)).unwrap();
        assert_eq!(img.pixels, [7, 7, 7, 255, 9, 9, 9, 255]);
        assert!(decode_psd(b"nope").is_err());
        let mut truncated = psd(2, 2, 3, &[vec![1; 4], vec![1; 4], vec![1; 4]], false);
        truncated.truncate(truncated.len() - 3);
        assert!(decode_psd(&truncated).is_err());
    }

    #[test]
    fn rgba_bytes_layout() {
        let b = RgbaImage { width: 2, height: 1, pixels: vec![1, 2, 3, 4, 5, 6, 7, 8] }.into_bytes();
        assert_eq!(&b[..8], &[2, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(b.len(), 16);
    }

    #[test]
    fn orm_pack_channels_resize_and_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let rough = dir.path().join("rough.png");
        let ao = dir.path().join("ao.png");
        GrayImage::from_pixel(4, 4, image::Luma([200])).save(&rough).unwrap();
        GrayImage::from_pixel(2, 2, image::Luma([50])).save(&ao).unwrap(); // smaller: resampled

        let cfg = OrmPackConfig {
            roughness_path: Some(rough.clone()),
            metallic_path: None,
            ao_path: Some(ao),
            output_path: dir.path().join("out").join("T_Crate_ORM.png"),
            format: OrmFormat::Png,
            roughness_from_gloss: false,
        };
        let res = pack_orm(&cfg).unwrap();
        assert_eq!((res.width, res.height), (4, 4));
        let out = image::open(&res.output_path).unwrap().to_rgb8();
        assert_eq!(out.get_pixel(3, 3).0, [50, 200, DEFAULT_METALLIC]);

        let gloss = pack_orm(&OrmPackConfig { roughness_from_gloss: true, format: OrmFormat::Tga, ao_path: None, ..cfg.clone() }).unwrap();
        assert_eq!(ext_lower(&gloss.output_path), "tga");
        let out = image::open(&gloss.output_path).unwrap().to_rgb8();
        assert_eq!(out.get_pixel(0, 0).0, [DEFAULT_AO, 55, DEFAULT_METALLIC]);

        let none = OrmPackConfig { roughness_path: None, metallic_path: None, ao_path: None, ..cfg };
        assert!(pack_orm(&none).is_err());
    }

    /// Compare against a reference composite (e.g. from psd-tools) when `PP_PSD_FIXTURE` /
    /// `PP_PSD_REF` point at a .psd and its expected PNG.
    #[test]
    fn external_psd_matches_reference() {
        let (Ok(psd), Ok(reference)) = (std::env::var("PP_PSD_FIXTURE"), std::env::var("PP_PSD_REF")) else { return };
        let img = decode_rgba(Path::new(&psd)).unwrap();
        let expected = image::open(reference).unwrap().to_rgba8();
        assert_eq!((img.width, img.height), expected.dimensions());
        let max_diff = img.pixels.iter().zip(expected.as_raw()).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
        assert!(max_diff <= 2, "max channel difference {max_diff}");
        eprintln!("external_psd_matches_reference: {}x{}, max diff {max_diff}", img.width, img.height);
    }

    #[test]
    fn decode_regular_image() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.tif");
        image::RgbaImage::from_pixel(3, 2, image::Rgba([1, 2, 3, 4])).save(&p).unwrap();
        let img = decode_rgba(&p).unwrap();
        assert_eq!((img.width, img.height), (3, 2));
        assert_eq!(&img.pixels[..4], &[1, 2, 3, 4]);
        let mislabeled = dir.path().join("png_data.tga");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([9, 8, 7, 6])).save_with_format(&mislabeled, ImageFormat::Png).unwrap();
        assert_eq!(&decode_rgba(&mislabeled).unwrap().pixels[..4], &[9, 8, 7, 6], "decoded by content, not extension");
    }
}
