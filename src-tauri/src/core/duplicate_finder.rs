//! Byte-identical asset detection: group by size, then hash only the candidates with XXH3-128.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;
use xxhash_rust::xxh3::Xxh3;

use super::scanner::AssetFile;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub files: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateReport {
    /// Largest waste first.
    pub groups: Vec<DuplicateGroup>,
    /// Bytes freed by keeping one file per group.
    pub wasted_bytes: u64,
    pub scanned_files: usize,
    pub hashed_files: usize,
    pub elapsed_ms: u64,
    pub errors: Vec<String>,
}

pub fn hash_file(path: &Path) -> io::Result<u128> {
    let mut f = File::open(path)?;
    let mut hasher = Xxh3::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.digest128())
}

pub fn find_duplicates(files: &[AssetFile], cancel: Option<&AtomicBool>) -> DuplicateReport {
    let started = Instant::now();
    let mut by_size: HashMap<u64, Vec<&AssetFile>> = HashMap::new();
    for f in files.iter().filter(|f| f.size > 0) {
        by_size.entry(f.size).or_default().push(f);
    }
    let candidates: Vec<&AssetFile> = by_size.into_values().filter(|g| g.len() > 1).flatten().collect();

    let hashed: Vec<(Result<u128, String>, &AssetFile)> = candidates
        .par_iter()
        .map(|f| {
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                return (Err("cancelled".into()), *f);
            }
            (hash_file(&f.path).map_err(|e| format!("{}: {e}", f.path.display())), *f)
        })
        .collect();

    let mut errors = Vec::new();
    let mut by_hash: HashMap<(u128, u64), Vec<PathBuf>> = HashMap::new();
    for (h, f) in &hashed {
        match h {
            Ok(h) => by_hash.entry((*h, f.size)).or_default().push(f.path.clone()),
            Err(e) => errors.push(e.clone()),
        }
    }
    let mut groups: Vec<DuplicateGroup> = by_hash
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|((h, size), mut files)| {
            files.sort();
            DuplicateGroup { hash: format!("{h:032x}"), size, files }
        })
        .collect();
    groups.sort_by(|a, b| (b.size * (b.files.len() as u64 - 1)).cmp(&(a.size * (a.files.len() as u64 - 1))).then_with(|| a.files[0].cmp(&b.files[0])));
    DuplicateReport {
        wasted_bytes: groups.iter().map(|g| g.size * (g.files.len() as u64 - 1)).sum(),
        groups,
        scanned_files: files.len(),
        hashed_files: hashed.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::scanner::{normalize_exts, scan};
    use std::fs;

    #[test]
    fn groups_identical_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let w = |n: &str, d: &[u8]| {
            let p = dir.path().join(n);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, d).unwrap();
        };
        w("a.png", b"same-bytes");
        w("sub/b.png", b"same-bytes");
        w("c.png", b"diff-bytes"); // same size, different content
        w("big1.fbx", &[7u8; 4096]);
        w("big2.fbx", &[7u8; 4096]);
        w("big3.fbx", &[7u8; 4096]);
        w("empty1.png", b"");
        w("empty2.png", b"");

        let files = scan(dir.path(), &normalize_exts::<&str>(&[]), true, None).files;
        let rep = find_duplicates(&files, None);
        assert_eq!(rep.groups.len(), 2);
        assert_eq!(rep.groups[0].files.len(), 3, "largest waste first");
        assert_eq!(rep.groups[0].size, 4096);
        assert_eq!(rep.groups[1].files.len(), 2);
        assert_eq!(rep.wasted_bytes, 4096 * 2 + 10);
        assert_eq!(rep.hashed_files, 6, "empty files are never hashed");
        assert_eq!(rep.groups[0].hash.len(), 32);
    }
}
