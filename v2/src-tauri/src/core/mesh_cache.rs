//! What the Asset Matcher needs from a mesh file (material names, stored texture paths),
//! remembered by path + size + modification time. On a streamed Google Drive, reading a mesh
//! downloads it; with the cache a rescan only reads files that are new or changed.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::mesh_stats::inspect_mesh;
use super::usage::mesh_texture_paths;

/// Bump when `MeshFacts` or the way it is read changes: older caches are then discarded.
const VERSION: u32 = 1;
/// Least recently used entries beyond this are dropped on save.
const MAX_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshFacts {
    pub material_names: Vec<String>,
    /// Texture paths as stored in the file.
    pub references: Vec<String>,
    pub error: Option<String>,
}

/// Read a mesh file (the whole file: on Drive this downloads it).
pub fn read_facts(path: &Path) -> MeshFacts {
    let stats = inspect_mesh(path, None);
    match mesh_texture_paths(path) {
        Ok(references) => MeshFacts { material_names: stats.material_names, references, error: stats.error },
        Err(e) => MeshFacts { material_names: stats.material_names, references: Vec::new(), error: Some(e) },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    size: u64,
    modified_ms: u64,
    /// Seconds since the epoch of the last lookup or store.
    used: u64,
    facts: MeshFacts,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, Entry>,
}

#[derive(Default)]
pub struct MeshCache {
    file: Option<PathBuf>,
    entries: HashMap<String, Entry>,
    dirty: bool,
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl MeshCache {
    /// A cache backed by `file`; a missing, unreadable or outdated file starts empty.
    pub fn open(file: PathBuf) -> MeshCache {
        let entries = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
            .filter(|c| c.version == VERSION)
            .map(|c| c.entries)
            .unwrap_or_default();
        MeshCache { file: Some(file), entries, dirty: false }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Cached facts when the file still has the size and time they were read at.
    pub fn get(&mut self, path: &Path, size: u64, modified_ms: u64) -> Option<MeshFacts> {
        let e = self.entries.get_mut(&key(path)).filter(|e| e.size == size && e.modified_ms == modified_ms)?;
        e.used = now();
        self.dirty = true;
        Some(e.facts.clone())
    }

    pub fn contains(&self, path: &Path, size: u64, modified_ms: u64) -> bool {
        self.entries.get(&key(path)).is_some_and(|e| e.size == size && e.modified_ms == modified_ms)
    }

    pub fn put(&mut self, path: &Path, size: u64, modified_ms: u64, facts: MeshFacts) {
        self.entries.insert(key(path), Entry { size, modified_ms, used: now(), facts });
        self.dirty = true;
    }

    pub fn clear(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        self.dirty = true;
        n
    }

    /// Write to disk if anything changed (atomic rename).
    pub fn save(&mut self) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        if !self.dirty {
            return Ok(());
        }
        if self.entries.len() > MAX_ENTRIES {
            let mut by_use: Vec<(String, u64)> = self.entries.iter().map(|(k, e)| (k.clone(), e.used)).collect();
            by_use.sort_by_key(|(_, used)| *used);
            for (k, _) in by_use.into_iter().take(self.entries.len() - MAX_ENTRIES) {
                self.entries.remove(&k);
            }
        }
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let data = serde_json::to_vec(&CacheFile { version: VERSION, entries: self.entries.clone() }).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("tmp");
        fs::write(&tmp, data).and_then(|_| fs::rename(&tmp, file)).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hits_only_unchanged_files_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("cache/mesh_cache.json");
        let facts = MeshFacts { material_names: vec!["M_A".into()], references: vec!["a.png".into()], error: None };
        let p = Path::new(r"G:\Shared drives\Repo\SM_A.fbx");

        let mut c = MeshCache::open(file.clone());
        assert!(c.is_empty());
        c.put(p, 10, 1000, facts.clone());
        assert_eq!(c.get(Path::new("g:/shared drives/repo/sm_a.fbx"), 10, 1000), Some(facts.clone()), "case and separators do not matter");
        assert_eq!(c.get(p, 11, 1000), None, "size changed");
        assert_eq!(c.get(p, 10, 2000), None, "re-saved");
        c.save().unwrap();

        let mut again = MeshCache::open(file.clone());
        assert_eq!(again.get(p, 10, 1000), Some(facts));
        assert_eq!(again.clear(), 1);

        fs::write(&file, br#"{"version":0,"entries":{}}"#).unwrap();
        assert!(MeshCache::open(file).is_empty(), "old format discarded");
    }
}
