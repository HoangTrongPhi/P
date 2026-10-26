use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::core::fbx::{fix_fbx, restore_backup, scan_fbx, FbxFileInfo, FixOptions, FixReport};
use crate::core::scanner::{normalize_exts, scan};
use crate::utils::logbus::{self, Level};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FbxFixPlan {
    pub paths: Vec<String>,
    #[serde(flatten)]
    pub options: FixOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbxFileError {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbxFixResult {
    pub reports: Vec<FixReport>,
    pub errors: Vec<FbxFileError>,
}

/// Files and folders (searched recursively) -> sorted, de-duplicated `.fbx` list.
fn expand_fbx(paths: &[String]) -> Vec<PathBuf> {
    let exts = normalize_exts(&["fbx"]);
    let mut out: Vec<PathBuf> = paths.iter().flat_map(|p| scan(Path::new(p), &exts, true, None).files).map(|f| f.path).collect();
    out.sort();
    out.dedup();
    out
}

#[tauri::command]
pub async fn scan_fbx_files<R: Runtime>(app: AppHandle<R>, paths: Vec<String>, search_dirs: Option<Vec<String>>) -> Result<Vec<FbxFileInfo>, String> {
    let infos = tauri::async_runtime::spawn_blocking(move || {
        let search: Vec<PathBuf> = search_dirs.unwrap_or_default().into_iter().map(PathBuf::from).collect();
        expand_fbx(&paths).par_iter().map(|p| scan_fbx(p, &search).unwrap_or_else(|e| FbxFileInfo::failed(p, e))).collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let issues = infos.iter().filter(|i| i.has_issues).count();
    logbus::emit(&app, Level::Info, "fbx", format!("Scanned {} FBX file(s), {issues} with path issues", infos.len()));
    for i in infos.iter().filter(|i| i.error.is_some()) {
        logbus::emit(&app, Level::Error, "fbx", format!("{}: {}", i.path, i.error.as_deref().unwrap_or_default()));
    }
    Ok(infos)
}

#[tauri::command]
pub async fn fix_fbx_paths<R: Runtime>(app: AppHandle<R>, plan: FbxFixPlan) -> Result<FbxFixResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let outcomes: Vec<_> = expand_fbx(&plan.paths).into_par_iter().map(|p| (fix_fbx(&p, &plan.options), p)).collect();
        let mut result = FbxFixResult { reports: vec![], errors: vec![] };
        for (outcome, path) in outcomes {
            match outcome {
                Ok(r) => result.reports.push(r),
                Err(e) => result.errors.push(FbxFileError { path: path.to_string_lossy().into_owned(), error: e.to_string() }),
            }
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?;

    for r in &result.reports {
        let verb = if r.dry_run { "would rewrite" } else { "rewrote" };
        logbus::emit(&app, Level::Info, "fbx", format!("{}: {verb} {} path(s), copied {} texture(s)", r.path.display(), r.changes.len(), r.copied.len()));
        for w in &r.warnings {
            logbus::emit(&app, Level::Warn, "fbx", format!("{}: {w}", r.path.display()));
        }
    }
    for e in &result.errors {
        logbus::emit(&app, Level::Error, "fbx", format!("{}: {}", e.path, e.error));
    }
    Ok(result)
}

#[tauri::command]
pub async fn restore_fbx_backup<R: Runtime>(app: AppHandle<R>, path: String) -> Result<bool, String> {
    let restored = restore_backup(Path::new(&path)).map_err(|e| e.to_string())?;
    let msg = if restored { format!("Restored {path} from backup") } else { format!("No backup found for {path}") };
    logbus::emit(&app, if restored { Level::Info } else { Level::Warn }, "fbx", msg);
    Ok(restored)
}
