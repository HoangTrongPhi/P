use std::path::{Path, PathBuf};
use std::time::Duration;

use rayon::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::blender_cmd::script_path;
use crate::core::asset_matcher::{match_assets as matcher, MatchReport, MatchStatus};
use crate::core::blender_runner::{best_blender, blend_dependencies};
use crate::core::duplicate_finder::{find_duplicates, DuplicateReport};
use crate::core::image_ops::{pack_orm, OrmPackConfig};
use crate::core::mesh_stats::{inspect_meshes as mesh_stats, MeshStats};
use crate::core::scanner::{normalize_exts, scan};
use crate::core::texture_convert::{convert_textures as convert, ConvertItem, ConvertOptions};
use crate::core::texture_sets::{find_texture_sets as texture_sets, TextureSetReport};
use crate::core::usage::{find_unused_textures_with, UnusedReport};
use crate::utils::logbus::{self, Level};
use crate::utils::paths::{MESH_EXTS, TEXTURE_EXTS};

/// Per-file limit for reading a `.blend` through Blender.
const BLEND_TIMEOUT: Duration = Duration::from_secs(300);

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

/// Files and folders (searched recursively) -> sorted, de-duplicated files with one of `exts`.
pub(crate) fn expand(paths: &[String], exts: &[&str]) -> Vec<PathBuf> {
    let exts = normalize_exts(exts);
    let mut out: Vec<PathBuf> = paths.iter().flat_map(|p| scan(Path::new(p), &exts, true, None).files).map(|f| f.path).collect();
    out.sort();
    out.dedup();
    out
}

/// `includeBlend` also reads every `.blend` through headless Blender (slow: one instance per file).
#[tauri::command]
pub async fn find_unused_textures<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    include_blend: Option<bool>,
    blender_path: Option<String>,
) -> Result<UnusedReport, String> {
    let root = require_dir(&folder)?;
    let blend = if include_blend.unwrap_or(false) {
        let blender = match blender_path {
            Some(p) => PathBuf::from(p),
            None => best_blender().ok_or("Blender 5.0+ not found: needed to read .blend files")?.executable,
        };
        Some((blender, script_path(&app)?))
    } else {
        None
    };
    let handle = app.clone();
    let rep = tauri::async_runtime::spawn_blocking(move || {
        let reader = blend.map(|(blender, script)| {
            move |p: &Path| {
                logbus::emit(&handle, Level::Info, "tools", format!("Reading {} with Blender", p.display()));
                blend_dependencies(&blender, &script, p, BLEND_TIMEOUT)
            }
        });
        match &reader {
            Some(r) => find_unused_textures_with(Path::new(&root), Some(r)),
            None => find_unused_textures_with(Path::new(&root), None),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let blend_note = if rep.blend_inspected > 0 { format!(", {} .blend file(s) read", rep.blend_inspected) } else { String::new() };
    logbus::emit(
        &app,
        Level::Info,
        "tools",
        format!("{} of {} texture(s) unreferenced, {} reclaimable{blend_note}", rep.textures.len(), rep.total_textures, mb(rep.reclaimable_bytes)),
    );
    for w in rep.warnings.iter().take(20) {
        logbus::emit(&app, Level::Warn, "tools", w.clone());
    }
    Ok(rep)
}

#[tauri::command]
pub async fn find_texture_sets<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<TextureSetReport, String> {
    let root = require_dir(&folder)?;
    let rep = tauri::async_runtime::spawn_blocking(move || texture_sets(&root)).await.map_err(|e| e.to_string())?;
    let incomplete = rep.sets.iter().filter(|s| !s.missing.is_empty()).count();
    let packable = rep.sets.iter().filter(|s| s.can_pack_orm).count();
    logbus::emit(&app, Level::Info, "tools", format!("{} texture set(s), {incomplete} incomplete, {packable} ready for ORM packing", rep.sets.len()));
    Ok(rep)
}

/// Which texture set goes with which mesh / material slot, with a confidence score per match.
#[tauri::command]
pub async fn match_assets<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<MatchReport, String> {
    let root = require_dir(&folder)?;
    let rep = tauri::async_runtime::spawn_blocking(move || matcher(&root)).await.map_err(|e| e.to_string())?;
    let slots: Vec<MatchStatus> = rep.meshes.iter().flat_map(|m| m.slots.iter().map(|s| s.status)).collect();
    let n = |st: MatchStatus| slots.iter().filter(|&&s| s == st).count();
    logbus::emit(
        &app,
        Level::Info,
        "matcher",
        format!(
            "{} mesh(es), {} slot(s): {} exact, {} likely, {} to review, {} unmatched; {} texture set(s) unused ({} ms)",
            rep.meshes.len(),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrmBatchItem {
    pub output_path: PathBuf,
    pub ok: bool,
    pub error: Option<String>,
}

/// Pack several ORM textures in parallel; one failure does not stop the others.
#[tauri::command]
pub async fn pack_orm_batch<R: Runtime>(app: AppHandle<R>, configs: Vec<OrmPackConfig>) -> Result<Vec<OrmBatchItem>, String> {
    let items = tauri::async_runtime::spawn_blocking(move || {
        configs
            .par_iter()
            .map(|c| match pack_orm(c) {
                Ok(r) => OrmBatchItem { output_path: r.output_path, ok: true, error: None },
                Err(e) => OrmBatchItem { output_path: c.output_path.clone(), ok: false, error: Some(e) },
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let ok = items.iter().filter(|i| i.ok).count();
    logbus::emit(&app, Level::Info, "tools", format!("Packed {ok} of {} ORM texture(s)", items.len()));
    for i in items.iter().filter(|i| !i.ok) {
        logbus::emit(&app, Level::Error, "tools", format!("{}: {}", i.output_path.display(), i.error.as_deref().unwrap_or_default()));
    }
    Ok(items)
}

/// Resize / flip / convert textures; `paths` may contain folders (searched recursively).
#[tauri::command]
pub async fn convert_textures<R: Runtime>(app: AppHandle<R>, paths: Vec<String>, options: ConvertOptions) -> Result<Vec<ConvertItem>, String> {
    let dry = options.dry_run;
    let items = tauri::async_runtime::spawn_blocking(move || convert(&expand(&paths, TEXTURE_EXTS), &options)).await.map_err(|e| e.to_string())?;
    let done = items.iter().filter(|i| i.written || (dry && i.to_size.is_some())).count();
    let skipped = items.iter().filter(|i| i.skipped.is_some()).count();
    let failed = items.iter().filter(|i| i.error.is_some()).count();
    let verb = if dry { "would convert" } else { "converted" };
    logbus::emit(&app, Level::Info, "tools", format!("Textures: {verb} {done}, skipped {skipped}, failed {failed}"));
    for i in items.iter().filter(|i| i.error.is_some()).take(20) {
        logbus::emit(&app, Level::Error, "tools", format!("{}: {}", i.source.display(), i.error.as_deref().unwrap_or_default()));
    }
    Ok(items)
}

#[tauri::command]
pub async fn inspect_meshes<R: Runtime>(app: AppHandle<R>, paths: Vec<String>, tri_budget: Option<u64>) -> Result<Vec<MeshStats>, String> {
    let stats = tauri::async_runtime::spawn_blocking(move || mesh_stats(&expand(&paths, MESH_EXTS), tri_budget)).await.map_err(|e| e.to_string())?;
    let tris: u64 = stats.iter().map(|s| s.triangles).sum();
    let flagged = stats.iter().filter(|s| !s.warnings.is_empty() || s.error.is_some()).count();
    logbus::emit(&app, Level::Info, "tools", format!("Inspected {} mesh file(s), {tris} triangles, {flagged} with warnings", stats.len()));
    Ok(stats)
}
