use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::core::renamer::{build_plan, compile_rules, execute_plan, plan_from_pairs, undo_last, RenameRow, RuleSpec, Status};
use crate::core::scanner::{normalize_exts, scan};
use crate::utils::history::RenameHistory;
use crate::utils::logbus::{self, Level};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameConfig {
    pub rules: Vec<RuleSpec>,
    #[serde(default)]
    pub recursive: bool,
    /// Extension filter; empty means every asset type.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Explicit file list; when set, the folder is not scanned.
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameAction {
    pub original_path: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub transaction_id: Option<String>,
    pub renamed: usize,
    /// Actions refused by the final safety check, with the reason.
    pub rejected: Vec<RenameRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub transaction_id: Option<String>,
    pub restored: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSummary {
    pub id: String,
    pub timestamp: f64,
    pub count: usize,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn history_for(folder: &str) -> Result<RenameHistory, String> {
    let dir = Path::new(folder);
    if !dir.is_dir() {
        return Err(format!("Folder not found: {folder}"));
    }
    Ok(RenameHistory::new(dir))
}

#[tauri::command]
pub async fn dry_run_rename(folder: String, rules: RenameConfig) -> Result<Vec<RenameRow>, String> {
    blocking(move || {
        let compiled = compile_rules(&rules.rules)?;
        let paths: Vec<PathBuf> = match rules.paths {
            Some(list) => list.into_iter().map(PathBuf::from).collect(),
            None => scan(Path::new(&folder), &normalize_exts(&rules.extensions), rules.recursive, None).files.into_iter().map(|f| f.path).collect(),
        };
        Ok(build_plan(&paths, &compiled).iter().map(RenameRow::from).collect())
    })
    .await
}

#[tauri::command]
pub async fn apply_rename(app: AppHandle, folder: String, items: Vec<RenameAction>) -> Result<RenameResult, String> {
    let result = blocking(move || {
        let history = history_for(&folder)?;
        let pairs: Vec<(PathBuf, PathBuf)> = items.iter().map(|a| (PathBuf::from(&a.original_path), PathBuf::from(&a.target_path))).collect();
        // The plan is re-checked here: the disk may have changed since the dry run.
        let plan = plan_from_pairs(&pairs);
        let rejected = plan.iter().filter(|e| !matches!(e.status, Status::Ok | Status::Unchanged)).map(RenameRow::from).collect();
        let tx = execute_plan(&plan, Some(&history)).map_err(|e| format!("Rename failed and was rolled back: {e}"))?;
        Ok(RenameResult { renamed: tx.as_ref().map_or(0, |t| t.ops.len()), transaction_id: tx.map(|t| t.id), rejected })
    })
    .await?;
    logbus::emit(&app, Level::Info, "renamer", format!("Renamed {} file(s), {} rejected", result.renamed, result.rejected.len()));
    Ok(result)
}

#[tauri::command]
pub async fn undo_last_rename(app: AppHandle, folder: String) -> Result<UndoResult, String> {
    let result = blocking(move || {
        let history = history_for(&folder)?;
        let tx = undo_last(&history).map_err(|e| e.to_string())?;
        Ok(UndoResult { restored: tx.as_ref().map_or(0, |t| t.ops.len()), transaction_id: tx.map(|t| t.id) })
    })
    .await?;
    let msg = match result.restored {
        0 => "Nothing to undo".to_string(),
        n => format!("Undo restored {n} file name(s)"),
    };
    logbus::emit(&app, Level::Info, "renamer", msg);
    Ok(result)
}

#[tauri::command]
pub async fn rename_history(folder: String) -> Result<Vec<TransactionSummary>, String> {
    blocking(move || {
        let history = history_for(&folder)?;
        Ok(history.load().into_iter().rev().map(|t| TransactionSummary { count: t.ops.len(), id: t.id, timestamp: t.timestamp }).collect())
    })
    .await
}
