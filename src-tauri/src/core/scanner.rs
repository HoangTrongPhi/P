//! Parallel, extension-filtered asset scanning (port of `src/core/scanner.py`).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use rayon::prelude::*;
use serde::Serialize;
use walkdir::WalkDir;

use crate::utils::paths::{all_asset_exts, category_for, ext_lower};

/// Folders that never contain user assets and are expensive to walk.
const SKIP_DIRS: &[&str] = &[".git", ".svn", "__pycache__", ".venv", "node_modules", "Intermediate", "DerivedDataCache"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    pub category: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub root: PathBuf,
    pub files: Vec<AssetFile>,
    pub counts: BTreeMap<&'static str, usize>,
    pub total_size: u64,
    pub elapsed_ms: u64,
    /// Entries that could not be read (permission denied, broken links, …).
    pub errors: Vec<String>,
}

/// Normalize user filters (`".PNG"`, `"png"`) to lower-case extensions without the dot.
/// An empty list means every asset type.
pub fn normalize_exts<S: AsRef<str>>(filters: &[S]) -> HashSet<String> {
    let set: HashSet<String> =
        filters.iter().map(|f| f.as_ref().trim().trim_start_matches('.').to_lowercase()).filter(|f| !f.is_empty()).collect();
    if set.is_empty() {
        all_asset_exts().into_iter().map(String::from).collect()
    } else {
        set
    }
}

fn asset_file(path: PathBuf) -> std::io::Result<AssetFile> {
    let meta = std::fs::metadata(&path)?;
    let modified_ms = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(AssetFile {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        category: category_for(&path),
        size: meta.len(),
        modified_ms,
        path,
    })
}

/// Collect asset files under `root` whose extension is in `exts`, sorted by path.
pub fn scan(root: &Path, exts: &HashSet<String>, recursive: bool, cancel: Option<&AtomicBool>) -> ScanSummary {
    let started = Instant::now();
    let mut errors = Vec::new();
    let mut candidates = Vec::new();

    if root.is_file() {
        if exts.contains(&ext_lower(root)) {
            candidates.push(root.to_path_buf());
        }
    } else {
        let walker = WalkDir::new(root)
            .max_depth(if recursive { usize::MAX } else { 1 })
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !(e.file_type().is_dir() && SKIP_DIRS.iter().any(|s| e.file_name() == *s)));
        for entry in walker {
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                break;
            }
            match entry {
                Ok(e) if e.file_type().is_file() && exts.contains(&ext_lower(e.path())) => candidates.push(e.into_path()),
                Ok(_) => {}
                Err(err) => errors.push(err.to_string()),
            }
        }
    }

    // Metadata reads dominate on large drives, so stat in parallel.
    let results: Vec<Result<AssetFile, String>> = candidates
        .into_par_iter()
        .map(|p| asset_file(p.clone()).map_err(|e| format!("{}: {e}", p.display())))
        .collect();
    let mut files = Vec::with_capacity(results.len());
    for r in results {
        match r {
            Ok(f) => files.push(f),
            Err(e) => errors.push(e),
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let mut counts = BTreeMap::new();
    for f in &files {
        *counts.entry(f.category).or_insert(0) += 1;
    }
    ScanSummary {
        root: root.to_path_buf(),
        total_size: files.iter().map(|f| f.size).sum(),
        counts,
        files,
        elapsed_ms: started.elapsed().as_millis() as u64,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scans_filters_and_skips() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        for p in ["a.fbx", "b.PNG", "notes.txt", "sub/c.tga", "sub/deep/d.blend", "node_modules/x.png"] {
            let path = r.join(p);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, p).unwrap();
        }
        let all = scan(r, &normalize_exts::<&str>(&[]), true, None);
        let names: Vec<_> = all.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names.len(), 4, "{names:?}");
        assert!(!names.contains(&"x.png") && !names.contains(&"notes.txt"));
        assert_eq!(all.counts["texture"], 2);

        let flat = scan(r, &normalize_exts(&[".png", "FBX"]), false, None);
        let names: Vec<_> = flat.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["a.fbx", "b.PNG"]);

        let single = scan(&r.join("a.fbx"), &normalize_exts(&["fbx"]), true, None);
        assert_eq!(single.files.len(), 1);
    }
}
