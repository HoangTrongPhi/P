use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::core::kit_assembler::{assemble_kit as assemble, AssetManifest, KitOptions, KitReport, KitStatus};
use crate::utils::logbus::{self, Level};

/// Event name; keep in sync with `EVENTS.kitProgress` in `src/lib/ipc.ts`.
pub const PROGRESS_EVENT: &str = "kit://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    done: u32,
    total: u32,
    message: String,
}

/// Read an `asset_manifest.json` saved by the Asset Matcher.
#[tauri::command]
pub async fn load_asset_manifest(path: String) -> Result<AssetManifest, String> {
    tauri::async_runtime::spawn_blocking(move || AssetManifest::load(Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// Copy a manifest's meshes and texture sets into a clean project layout (see `core::kit_assembler`).
#[tauri::command]
pub async fn assemble_kit<R: Runtime>(app: AppHandle<R>, manifest: AssetManifest, options: KitOptions) -> Result<KitReport, String> {
    let mode = if options.dry_run { "dry run" } else { "live" };
    logbus::emit(&app, Level::Info, "kit", format!("Assembling {} asset(s) into {} ({mode})", manifest.assets.len(), options.dest.display()));
    let handle = app.clone();
    let rep = tauri::async_runtime::spawn_blocking(move || {
        // Copies from a streamed drive can be slow: report progress, at most every 100 ms.
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut progress = |done: usize, total: usize, target: &Path| {
            if done == total || last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = handle.emit(PROGRESS_EVENT, ProgressPayload { done: done as u32, total: total as u32, message: name });
            }
        };
        assemble(&manifest, &options, &mut progress)
    })
    .await
    .map_err(|e| e.to_string())??;

    let n = |s: KitStatus| rep.items.iter().filter(|i| i.status == s).count();
    let summary = if rep.dry_run {
        format!("Kit plan: {} file(s) to write, {} already there", n(KitStatus::Planned), n(KitStatus::Skipped))
    } else {
        format!(
            "Kit assembled: {} written ({:.1} MB), {} kept, {} failed, {} texture path(s) relinked ({} ms)",
            n(KitStatus::Written),
            rep.bytes_written as f64 / (1024.0 * 1024.0),
            n(KitStatus::Skipped),
            n(KitStatus::Failed),
            rep.relinked,
            rep.elapsed_ms
        )
    };
    logbus::emit(&app, if n(KitStatus::Failed) > 0 { Level::Warn } else { Level::Info }, "kit", summary);
    for w in &rep.warnings {
        logbus::emit(&app, Level::Warn, "kit", w.clone());
    }
    for i in rep.items.iter().filter(|i| i.status == KitStatus::Failed) {
        logbus::emit(&app, Level::Error, "kit", format!("{}: {}", i.target.display(), i.note.as_deref().unwrap_or_default()));
    }
    Ok(rep)
}
