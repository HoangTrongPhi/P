use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::core::blender_runner::{best_blender, discover_blenders, run_pack, BlenderInstall, PackOptions, PackResult, RunHooks, DEFAULT_TIMEOUT};
use crate::utils::logbus::{self, Level};

/// Event name; keep in sync with `EVENTS.blenderProgress` in `src/lib/ipc.ts`.
pub const PROGRESS_EVENT: &str = "blender://progress";
const SCRIPT_RESOURCE: &str = "dcc_scripts/blender/headless_pack.py";

/// The running pack job's cancel flag (one job at a time).
#[derive(Default)]
pub struct BlenderJob(Mutex<Option<Arc<AtomicBool>>>);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderPackConfig {
    /// Blender executable; the newest supported install is used when omitted.
    pub blender_path: Option<String>,
    pub blend_file: String,
    #[serde(default)]
    pub options: PackOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    done: u32,
    total: u32,
    message: String,
}

pub(crate) fn script_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Ok(p) = app.path().resolve(SCRIPT_RESOURCE, BaseDirectory::Resource) {
        if p.is_file() {
            return Ok(p);
        }
    }
    // `tauri dev` without bundled resources: use the source tree.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(SCRIPT_RESOURCE);
    if cfg!(debug_assertions) && dev.is_file() {
        return Ok(dev);
    }
    Err(format!("Bundled script {SCRIPT_RESOURCE} is missing"))
}

#[tauri::command]
pub async fn discover_blender<R: Runtime>(app: AppHandle<R>) -> Result<Vec<BlenderInstall>, String> {
    let installs = tauri::async_runtime::spawn_blocking(discover_blenders).await.map_err(|e| e.to_string())?;
    let list = installs.iter().map(|b| b.version_string.as_str()).collect::<Vec<_>>().join(", ");
    logbus::emit(&app, Level::Info, "blender", format!("Found {} Blender install(s): {list}", installs.len()));
    Ok(installs)
}

#[tauri::command]
pub async fn run_blender_pack<R: Runtime>(app: AppHandle<R>, job: State<'_, BlenderJob>, config: BlenderPackConfig) -> Result<PackResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = job.0.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("A Blender job is already running".into());
        }
        *slot = Some(cancel.clone());
    }
    let script = script_path(&app);
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<PackResult, String> {
        let script = script?;
        let blender = match config.blender_path {
            Some(p) => PathBuf::from(p),
            None => best_blender().ok_or("Blender 5.0+ not found. Set BLENDER_PATH or pick the executable.")?.executable,
        };
        run_pack(&blender, &script, &PathBuf::from(&config.blend_file), &config.options, RunHooks {
            on_line: &mut |line| {
                let level = if line.contains("Error") || line.contains("Traceback") { Level::Warn } else { Level::Debug };
                logbus::emit(&handle, level, "blender", line);
            },
            on_progress: &mut |done, total, message| {
                let _ = handle.emit(PROGRESS_EVENT, ProgressPayload { done, total, message: message.to_string() });
            },
            cancel: Some(cancel),
            timeout: DEFAULT_TIMEOUT,
        })
    })
    .await
    .map_err(|e| e.to_string());
    *job.0.lock().map_err(|e| e.to_string())? = None;

    let result = outcome??;
    match &result.error {
        None => logbus::emit(&app, Level::Info, "blender", format!("Pack finished, {} missing file(s)", result.missing().len())),
        Some(e) => logbus::emit(&app, Level::Error, "blender", format!("Pack failed: {e}")),
    }
    Ok(result)
}

#[tauri::command]
pub fn cancel_blender_pack<R: Runtime>(app: AppHandle<R>, job: State<'_, BlenderJob>) -> bool {
    let running = job.0.lock().ok().and_then(|s| s.clone());
    match running {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            logbus::emit(&app, Level::Warn, "blender", "Cancellation requested");
            true
        }
        None => false,
    }
}
