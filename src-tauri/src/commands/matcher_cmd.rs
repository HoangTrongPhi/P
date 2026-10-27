use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::core::asset_matcher::{estimate_read, match_assets_with, MatchEnv, MatchReport, MatchStatus, ReadEstimate};
use crate::core::drive::{drive_mounts as mounts, is_cloud_path, DriveMount};
use crate::core::mesh_cache::MeshCache;
use crate::utils::logbus::{self, Level};

/// Event name; keep in sync with `EVENTS.matcherProgress` in `src/lib/ipc.ts`.
pub const PROGRESS_EVENT: &str = "matcher://progress";
/// Parallel mesh reads on a streamed drive: each read is a download.
const DRIVE_THREADS: usize = 4;

/// The mesh-facts cache (opened on first use) and the running match's cancel flag.
#[derive(Default)]
pub struct MatcherState {
    cache: Arc<OnceLock<Mutex<MeshCache>>>,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    done: u32,
    total: u32,
    message: String,
}

fn cache_file<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("poseidon")).join("mesh_cache.json")
}

fn cache<R: Runtime>(app: &AppHandle<R>, state: &MatcherState) -> Arc<OnceLock<Mutex<MeshCache>>> {
    let file = cache_file(app);
    state.cache.get_or_init(|| Mutex::new(MeshCache::open(file)));
    state.cache.clone()
}

fn require_dir(folder: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(folder);
    if p.is_dir() {
        Ok(p)
    } else {
        Err(format!("Folder not found: {folder}"))
    }
}

/// Google Drive for desktop mounts with their shared drives.
#[tauri::command]
pub async fn drive_mounts() -> Result<Vec<DriveMount>, String> {
    tauri::async_runtime::spawn_blocking(mounts).await.map_err(|e| e.to_string())
}

/// How many mesh bytes a match would read (download, on Drive) and how many are cached. Reads names and sizes only.
#[tauri::command]
pub async fn matcher_estimate<R: Runtime>(app: AppHandle<R>, state: State<'_, MatcherState>, folder: String) -> Result<ReadEstimate, String> {
    let root = require_dir(&folder)?;
    let cache = cache(&app, &state);
    tauri::async_runtime::spawn_blocking(move || {
        let on_drive = is_cloud_path(&root, &mounts());
        let c = cache.get().expect("initialised").lock().map_err(|e| e.to_string())?;
        Ok(estimate_read(&root, &c, on_drive))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which texture set goes with which mesh / material slot, with a confidence score per match.
/// Mesh facts come from the cache when the file is unchanged; on Drive fewer files are read at once.
#[tauri::command]
pub async fn match_assets<R: Runtime>(app: AppHandle<R>, state: State<'_, MatcherState>, folder: String) -> Result<MatchReport, String> {
    let root = require_dir(&folder)?;
    let cache = cache(&app, &state);
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let on_drive = is_cloud_path(&root, &mounts());
        let last = Mutex::new(Instant::now() - Duration::from_secs(1));
        let progress = |done: usize, total: usize, file: &Path| {
            let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
            if done == total || last.elapsed() >= Duration::from_millis(100) {
                *last = Instant::now();
                let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = handle.emit(PROGRESS_EVENT, ProgressPayload { done: done as u32, total: total as u32, message: name });
            }
        };
        let mesh_cache = cache.get().expect("initialised");
        let env = MatchEnv { cache: Some(mesh_cache), progress: Some(&progress), cancel: Some(&cancel), threads: on_drive.then_some(DRIVE_THREADS) };
        let result = match_assets_with(&root, &env);
        // Save even after a cancel: what was read stays read.
        if let Err(e) = mesh_cache.lock().map_err(|e| e.to_string()).and_then(|mut c| c.save()) {
            logbus::emit(&handle, Level::Warn, "matcher", format!("Mesh cache not saved: {e}"));
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?;

    let rep = match result {
        Ok(r) => r,
        Err(e) => {
            logbus::emit(&app, Level::Warn, "matcher", "Matching cancelled; meshes read so far are cached");
            return Err(e);
        }
    };
    let slots: Vec<MatchStatus> = rep.meshes.iter().flat_map(|m| m.slots.iter().map(|s| s.status)).collect();
    let n = |st: MatchStatus| slots.iter().filter(|&&s| s == st).count();
    logbus::emit(
        &app,
        Level::Info,
        "matcher",
        format!(
            "{} mesh(es) ({} read, {} from cache), {} slot(s): {} exact, {} likely, {} to review, {} unmatched; {} texture set(s) unused ({} ms)",
            rep.meshes.len(),
            rep.read_files,
            rep.cached_files,
            slots.len(),
            n(MatchStatus::Exact),
            n(MatchStatus::Likely),
            n(MatchStatus::Review),
            n(MatchStatus::None),
            rep.orphan_sets.len(),
            rep.elapsed_ms
        ),
    );
    for m in rep.meshes.iter().filter(|m| m.error.is_some()) {
        logbus::emit(&app, Level::Warn, "matcher", format!("{}: {}", m.path.display(), m.error.as_deref().unwrap_or_default()));
    }
    Ok(rep)
}

#[tauri::command]
pub fn cancel_matching(state: State<'_, MatcherState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

/// Forget every cached mesh; the next match reads (downloads) them again. Returns how many were dropped.
#[tauri::command]
pub async fn clear_mesh_cache<R: Runtime>(app: AppHandle<R>, state: State<'_, MatcherState>) -> Result<usize, String> {
    let cache = cache(&app, &state);
    let n = tauri::async_runtime::spawn_blocking(move || {
        let mut c = cache.get().expect("initialised").lock().map_err(|e| e.to_string())?;
        let n = c.clear();
        c.save().map(|_| n)
    })
    .await
    .map_err(|e| e.to_string())??;
    logbus::emit(&app, Level::Info, "matcher", format!("Mesh cache cleared ({n} file(s))"));
    Ok(n)
}
