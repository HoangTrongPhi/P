use std::path::PathBuf;

use tauri::AppHandle;

use crate::core::scanner::{normalize_exts, scan, ScanSummary};
use crate::utils::logbus::{self, Level};

#[tauri::command]
pub async fn scan_directory(app: AppHandle, path: String, recursive: bool, filters: Vec<String>) -> Result<ScanSummary, String> {
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("Path not found: {path}"));
    }
    let summary = tauri::async_runtime::spawn_blocking(move || scan(&root, &normalize_exts(&filters), recursive, None))
        .await
        .map_err(|e| e.to_string())?;
    logbus::emit(
        &app,
        Level::Info,
        "scanner",
        format!("Scanned {}: {} asset(s) in {} ms", summary.root.display(), summary.files.len(), summary.elapsed_ms),
    );
    for err in summary.errors.iter().take(20) {
        logbus::emit(&app, Level::Warn, "scanner", err.clone());
    }
    Ok(summary)
}
