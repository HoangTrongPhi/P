//! Asset classification, file-name validation and cross-platform path helpers.

use std::path::{Component, Path, PathBuf};

pub const MESH_EXTS: &[&str] = &["fbx", "obj", "glb", "gltf"];
pub const SCENE_EXTS: &[&str] = &["blend"];
pub const TEXTURE_EXTS: &[&str] = &["png", "jpg", "jpeg", "tga", "dds", "exr", "hdr", "tif", "tiff", "bmp", "webp"];
pub const SOURCE_EXTS: &[&str] = &["psd"];

const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Lower-cased extension without the dot (`""` when there is none).
pub fn ext_lower(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// `mesh`, `scene`, `texture`, `source` or `other`.
pub fn category_for(path: &Path) -> &'static str {
    let ext = ext_lower(path);
    let ext = ext.as_str();
    if MESH_EXTS.contains(&ext) {
        "mesh"
    } else if SCENE_EXTS.contains(&ext) {
        "scene"
    } else if TEXTURE_EXTS.contains(&ext) {
        "texture"
    } else if SOURCE_EXTS.contains(&ext) {
        "source"
    } else {
        "other"
    }
}

pub fn all_asset_exts() -> Vec<&'static str> {
    [MESH_EXTS, SCENE_EXTS, TEXTURE_EXTS, SOURCE_EXTS].concat()
}

/// Error message if `name` is not a valid Windows file name, else `None`.
pub fn validate_filename(name: &str) -> Option<&'static str> {
    if name.is_empty() || name == "." || name == ".." {
        return Some("Empty name");
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20) {
        return Some("Contains invalid characters");
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Some("Ends with space or dot");
    }
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_uppercase()).unwrap_or_default();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Some("Reserved Windows name");
    }
    if name.chars().count() > 255 {
        return Some("Name too long");
    }
    None
}

/// Absolute, lexically normalized path (no `.` / `..`), without touching the disk.
pub fn absolute(path: &Path) -> PathBuf {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Comparison key that matches how the OS treats paths (case-insensitive on Windows).
pub fn path_key(path: &Path) -> String {
    let s = absolute(path).to_string_lossy().into_owned();
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s
    }
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}

fn component_eq(a: &Component, b: &Component) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// `os.path.relpath` with `/` separators. `None` when the paths are on different drives.
pub fn relpath_portable(target: &Path, start: &Path) -> Option<String> {
    let t = absolute(target);
    let s = absolute(start);
    let tc: Vec<Component> = t.components().collect();
    let sc: Vec<Component> = s.components().collect();
    let (tp, sp) = (tc.first(), sc.first());
    if let (Some(a @ Component::Prefix(_)), Some(b @ Component::Prefix(_))) = (tp, sp) {
        if !component_eq(a, b) {
            return None;
        }
    }
    let common = tc.iter().zip(&sc).take_while(|(a, b)| component_eq(a, b)).count();
    let mut parts: Vec<String> = vec!["..".into(); sc.len() - common];
    parts.extend(tc[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(if parts.is_empty() { ".".into() } else { parts.join("/") })
}

/// Canonicalize, dropping the Windows `\\?\` verbatim prefix for local drives.
pub fn canonical(path: &Path) -> PathBuf {
    match path.canonicalize() {
        Ok(p) => {
            let s = p.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
                _ => p,
            }
        }
        Err(_) => absolute(path),
    }
}

/// Short unique token for temp names and transaction ids.
pub fn unique_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}{:04x}{:04x}", nanos, std::process::id() & 0xffff, n & 0xffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories() {
        assert_eq!(category_for(Path::new("a/B.FBX")), "mesh");
        assert_eq!(category_for(Path::new("x.webp")), "texture");
        assert_eq!(category_for(Path::new("x.blend")), "scene");
        assert_eq!(category_for(Path::new("x.psd")), "source");
        assert_eq!(category_for(Path::new("x.txt")), "other");
    }

    #[test]
    fn filename_validation() {
        assert_eq!(validate_filename("ok.png"), None);
        assert!(validate_filename("a/b.png").is_some());
        assert!(validate_filename("con.png").is_some());
        assert!(validate_filename("trail. ").is_some());
        assert!(validate_filename("").is_some());
    }

    #[test]
    fn relpath() {
        let base = std::env::temp_dir();
        let model = base.join("model");
        let tex = base.join("elsewhere").join("wood.png");
        assert_eq!(relpath_portable(&tex, &model).unwrap(), "../elsewhere/wood.png");
        assert_eq!(relpath_portable(&model.join("t").join("a.png"), &model).unwrap(), "t/a.png");
        #[cfg(windows)]
        assert_eq!(relpath_portable(Path::new(r"Q:\x\a.png"), Path::new(r"C:\y")), None);
    }
}
