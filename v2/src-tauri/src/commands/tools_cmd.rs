use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};

use crate::core::duplicate_finder::{find_duplicates, DuplicateReport};
use crate::core::image_ops::{pack_orm, OrmPackConfig};
use crate::core::scanner::{normalize_exts, scan};
use crate::core::usage::{find_unused_textures as unused_textures, UnusedReport};
use crate::utils::logbus::{self, Level};

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

fn require_dir(folder: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(folder);
    if p.is_dir() {
        Ok(p)
    } else {
        Err(format!("Folder not found: {folder}"))
    }
}

/// Merge roughness / metallic / AO maps into one ORM texture. Returns the written path.
#[tauri::command]
pub async fn pack_orm_texture<R: Runtime>(app: AppHandle<R>, config: OrmPackConfig) -> Result<String, String> {
    let res = tauri::async_runtime::spawn_blocking(move || pack_orm(&config)).await.map_err(|e| e.to_string())??;
    let out = res.output_path.to_string_lossy().into_owned();
    logbus::emit(&app, Level::Info, "tools", format!("ORM texture written: {out} ({}x{})", res.width, res.height));
    Ok(out)
}

#[tauri::command]
pub async fn find_duplicate_assets<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<DuplicateReport, String> {
    let root = require_dir(&folder)?;
    let rep = tauri::async_runtime::spawn_blocking(move || {
        let files = scan(&root, &normalize_exts::<&str>(&[]), true, None).files;
        find_duplicates(&files, None)
    })
    .await
    .map_err(|e| e.to_string())?;
    logbus::emit(
        &app,
        Level::Info,
        "tools",
        format!("{} duplicate group(s) among {} asset(s), {} reclaimable ({} ms)", rep.groups.len(), rep.scanned_files, mb(rep.wasted_bytes), rep.elapsed_ms),
    );
    Ok(rep)
}

#[tauri::command]
pub async fn find_unused_textures<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<UnusedReport, String> {
    let root = require_dir(&folder)?;
    let rep = tauri::async_runtime::spawn_blocking(move || unused_textures(Path::new(&root))).await.map_err(|e| e.to_string())?;
    logbus::emit(
        &app,
        Level::Info,
        "tools",
        format!("{} of {} texture(s) unreferenced, {} reclaimable", rep.textures.len(), rep.total_textures, mb(rep.reclaimable_bytes)),
    );
    for w in rep.warnings.iter().take(20) {
        logbus::emit(&app, Level::Warn, "tools", w.clone());
    }
    Ok(rep)
}
