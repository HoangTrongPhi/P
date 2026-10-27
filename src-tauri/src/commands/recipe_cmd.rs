use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use super::blender_cmd::script_path;
use crate::core::blender_runner::{best_blender, blend_dependencies};
use crate::core::recipe::{run_recipe as run, Recipe, RecipeEnv, RecipeRun};
use crate::utils::logbus::{self, Level};

/// Event name; keep in sync with `EVENTS.recipeProgress` in `src/lib/ipc.ts`.
pub const PROGRESS_EVENT: &str = "recipe://progress";
const BLEND_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    done: u32,
    total: u32,
    message: String,
}

/// Parse and validate a recipe file saved from the UI (or written by hand).
#[tauri::command]
pub async fn load_recipe(path: String) -> Result<Recipe, String> {
    tauri::async_runtime::spawn_blocking(move || Recipe::load(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn run_recipe<R: Runtime>(app: AppHandle<R>, recipe: Recipe, folder: String, dry_run: bool, blender_path: Option<String>) -> Result<RecipeRun, String> {
    recipe.validate()?;
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err(format!("Folder not found: {folder}"));
    }
    // Blender is looked up only when a step needs it; a missing install fails that step.
    let needs_blend = recipe.steps.iter().any(|s| matches!(s, crate::core::recipe::RecipeStep::FindUnused { include_blend: true }));
    let blender = if needs_blend { blender_path.map(PathBuf::from).or_else(|| best_blender().map(|b| b.executable)) } else { None };
    let script = if needs_blend { script_path(&app).ok() } else { None };

    let mode = if dry_run { "dry run" } else { "live" };
    logbus::emit(&app, Level::Info, "recipe", format!("Running \"{}\" on {folder} ({mode})", recipe.name));
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let reader = blender.zip(script).map(|(blender, script)| move |p: &Path| blend_dependencies(&blender, &script, p, BLEND_TIMEOUT));
        let mut on_step = |i: usize, n: usize, title: &str| {
            logbus::emit(&handle, Level::Info, "recipe", format!("Step {}/{n}: {title}", i + 1));
            let _ = handle.emit(PROGRESS_EVENT, ProgressPayload { done: i as u32, total: n as u32, message: title.to_string() });
        };
        let mut env = RecipeEnv { blend_reader: None, on_step: &mut on_step };
        if let Some(r) = &reader {
            env.blend_reader = Some(r);
        }
        run(&recipe, &root, dry_run, &mut env)
    })
    .await
    .map_err(|e| e.to_string())?;

    let _ = app.emit(PROGRESS_EVENT, ProgressPayload { done: result.steps.len() as u32, total: result.steps.len() as u32, message: "Done".into() });
    for s in &result.steps {
        let level = if s.ok { Level::Info } else if s.skipped { Level::Warn } else { Level::Error };
        logbus::emit(&app, level, "recipe", format!("{}: {}", s.title, s.summary));
    }
    Ok(result)
}
