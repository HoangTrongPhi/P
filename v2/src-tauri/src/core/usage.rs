//! Unused texture detection: textures on disk that no FBX / OBJ-MTL / glTF / GLB references.
//!
//! `.blend` files need Blender: the caller passes a reader (see `blender_runner::blend_dependencies`).
//! Without one, textures only used by Blender scenes are listed as unused — the UI says so.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;

use super::fbx::doctor::{referenced_basenames, referenced_paths};
use super::scanner::{normalize_exts, scan, AssetFile};
use crate::utils::paths::{ext_lower, TEXTURE_EXTS};

static MTL_MAP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(?:map_\w+|bump|disp|decal|refl|norm)\s+(.+)$").unwrap());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedReport {
    pub textures: Vec<AssetFile>,
    pub reclaimable_bytes: u64,
    pub total_textures: usize,
    /// FBX / MTL / glTF / GLB files that were read.
    pub reference_files: usize,
    /// `.blend` files found under the folder.
    pub blend_files: usize,
    /// `.blend` files whose dependencies were read through Blender.
    pub blend_inspected: usize,
    pub warnings: Vec<String>,
}

/// Lower-case texture file names a `.blend` file references.
pub type BlendReader<'a> = dyn Fn(&Path) -> Result<Vec<String>, String> + Sync + 'a;

pub(crate) fn base_lower(s: &str) -> String {
    s.trim().rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
}

/// `%20`-style escapes in glTF URIs.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Texture paths as written in an MTL file.
fn mtl_paths(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| MTL_MAP_RE.captures(l))
        // Options like "-bm 1.0" precede the file; the file is the last token.
        .filter_map(|c| c[1].split_whitespace().last().map(str::to_string))
        .collect()
}

/// Decoded image URIs of a glTF (embedded `data:` images skipped).
fn gltf_json_paths(json: &serde_json::Value) -> Vec<String> {
    json.get("images")
        .and_then(|i| i.as_array())
        .map(|imgs| {
            imgs.iter()
                .filter_map(|img| img.get("uri")?.as_str())
                .filter(|u| !u.starts_with("data:"))
                .map(percent_decode)
                .collect()
        })
        .unwrap_or_default()
}

fn mtl_refs(text: &str) -> Vec<String> {
    mtl_paths(text).iter().map(|p| base_lower(p)).collect()
}

fn gltf_json_refs(json: &serde_json::Value) -> Vec<String> {
    gltf_json_paths(json).iter().map(|p| base_lower(p)).collect()
}

/// JSON chunk of a binary glTF.
pub(crate) fn glb_json(data: &[u8]) -> Option<serde_json::Value> {
    if data.len() < 20 || &data[..4] != b"glTF" || &data[16..20] != b"JSON" {
        return None;
    }
    let len = u32::from_le_bytes(data[12..16].try_into().ok()?) as usize;
    serde_json::from_slice(data.get(20..20 + len)?).ok()
}

fn file_refs(path: &Path) -> Result<Vec<String>, String> {
    let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    match ext_lower(path).as_str() {
        "fbx" => referenced_basenames(path).map_err(|e| err(&e)),
        "mtl" => fs::read(path).map(|b| mtl_refs(&String::from_utf8_lossy(&b))).map_err(|e| err(&e)),
        "gltf" => {
            let text = fs::read_to_string(path).map_err(|e| err(&e))?;
            serde_json::from_str(&text).map(|j| gltf_json_refs(&j)).map_err(|e| err(&e))
        }
        "glb" => fs::read(path).map(|b| glb_json(&b).map(|j| gltf_json_refs(&j)).unwrap_or_default()).map_err(|e| err(&e)),
        _ => Ok(Vec::new()),
    }
}

static MTLLIB_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?im)^\s*mtllib\s+(.+?)\s*$").unwrap());

/// Texture paths exactly as a mesh file stores them: FBX / glTF / GLB directly, OBJ through its `mtllib` files.
pub(crate) fn mesh_texture_paths(path: &Path) -> Result<Vec<String>, String> {
    let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    match ext_lower(path).as_str() {
        "fbx" => referenced_paths(path).map_err(|e| err(&e)),
        "gltf" => {
            let text = fs::read_to_string(path).map_err(|e| err(&e))?;
            serde_json::from_str(&text).map(|j| gltf_json_paths(&j)).map_err(|e| err(&e))
        }
        "glb" => fs::read(path).map(|b| glb_json(&b).map(|j| gltf_json_paths(&j)).unwrap_or_default()).map_err(|e| err(&e)),
        "obj" => {
            let text = String::from_utf8_lossy(&fs::read(path).map_err(|e| err(&e))?).into_owned();
            let dir = path.parent().unwrap_or(Path::new("."));
            let mut out = Vec::new();
            for c in MTLLIB_RE.captures_iter(&text) {
                // A missing MTL just means no references. MTL paths are relative to the MTL, which sits next to the OBJ.
                if let Ok(b) = fs::read(dir.join(c[1].trim())) {
                    out.extend(mtl_paths(&String::from_utf8_lossy(&b)));
                }
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

pub fn find_unused_textures(root: &Path) -> UnusedReport {
    find_unused_textures_with(root, None)
}

/// Like `find_unused_textures`, also reading `.blend` files through `blend` when given.
/// Blender runs one file at a time: each instance is heavy.
pub fn find_unused_textures_with(root: &Path, blend: Option<&BlendReader>) -> UnusedReport {
    let ref_files = scan(root, &normalize_exts(&["fbx", "mtl", "gltf", "glb"]), true, None).files;
    let mut results: Vec<Result<Vec<String>, String>> = ref_files.par_iter().map(|f| file_refs(&f.path)).collect();
    let blend_files = scan(root, &normalize_exts(&["blend"]), true, None).files;
    let mut blend_inspected = 0;
    if let Some(read) = blend {
        for f in &blend_files {
            let r = read(&f.path).map_err(|e| format!("{}: {e}", f.path.display()));
            blend_inspected += usize::from(r.is_ok());
            results.push(r);
        }
    }
    let mut referenced = HashSet::new();
    // A single broken file must not abort the whole report.
    let mut warnings = Vec::new();
    for r in results {
        match r {
            Ok(names) => referenced.extend(names),
            Err(e) => warnings.push(e),
        }
    }
    let textures = scan(root, &normalize_exts(TEXTURE_EXTS), true, None).files;
    let total_textures = textures.len();
    let unused: Vec<AssetFile> = textures.into_iter().filter(|t| !referenced.contains(&t.name.to_lowercase())).collect();
    UnusedReport {
        reclaimable_bytes: unused.iter().map(|t| t.size).sum(),
        textures: unused,
        total_textures,
        reference_files: ref_files.len(),
        blend_files: blend_files.len(),
        blend_inspected,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fbx::test_support::build_binary_fbx;

    #[test]
    fn reports_textures_nobody_references() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        let w = |n: &str, d: &[u8]| {
            let p = r.join(n);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, d).unwrap();
        };
        for t in ["tex/wood.png", "tex/Brick_N.png", "tex/sky.hdr", "tex/my%20decal.png", "tex/orphan.tga", "tex/old/orphan2.png"] {
            w(t, b"pixels");
        }
        build_binary_fbx(&r.join("crate.fbx"), r"C:\far\away\WOOD.png", 7400, b"");
        w("m.mtl", b"newmtl a\nmap_Kd -bm 1.0 tex\\Brick_N.png\nbump sky.hdr\n");
        w("s.gltf", br#"{"images":[{"uri":"tex/my%2520decal.png"},{"uri":"data:image/png;base64,AAAA"}]}"#);
        w("broken.gltf", b"{ not json");

        let rep = find_unused_textures(r);
        let mut names: Vec<&str> = rep.textures.iter().map(|t| t.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["orphan.tga", "orphan2.png"]);
        assert_eq!(rep.total_textures, 6);
        assert_eq!(rep.reclaimable_bytes, 12);
        assert_eq!(rep.reference_files, 4);
        assert_eq!(rep.warnings.len(), 1, "broken glTF reported, not fatal");
    }

    #[test]
    fn blend_reader_adds_references() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        for n in ["a.png", "b.png", "c.png"] {
            fs::write(r.join(n), b"x").unwrap();
        }
        fs::write(r.join("scene.blend"), b"BLENDER").unwrap();
        fs::write(r.join("broken.blend"), b"BLENDER").unwrap();
        let reader = |p: &Path| -> Result<Vec<String>, String> {
            if p.ends_with("broken.blend") { Err("cannot open".into()) } else { Ok(vec!["a.png".into(), "B.PNG".to_lowercase()]) }
        };
        let rep = find_unused_textures_with(r, Some(&reader));
        assert_eq!(rep.textures.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["c.png"]);
        assert_eq!((rep.blend_files, rep.blend_inspected, rep.warnings.len()), (2, 1, 1));

        let without = find_unused_textures(r);
        assert_eq!((without.textures.len(), without.blend_inspected), (3, 0));
    }

    #[test]
    fn glb_json_chunk() {
        let json = br#"{"images":[{"uri":"albedo.png"}]}"#;
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend(((20 + json.len()) as u32).to_le_bytes());
        glb.extend((json.len() as u32).to_le_bytes());
        glb.extend(b"JSON");
        glb.extend(json);
        assert_eq!(gltf_json_refs(&glb_json(&glb).unwrap()), ["albedo.png"]);
    }
}
