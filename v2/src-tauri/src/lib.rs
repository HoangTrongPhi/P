//! Project P — Tauri 2 backend: IPC command registration and app bootstrap.

mod commands;
pub mod core;
pub mod utils;

#[cfg(test)]
mod ipc_tests;

use tauri::{Builder, Runtime};
use utils::logbus::{self, Level, LogBus};

/// State, startup hook and IPC commands, shared by the real app and the IPC tests.
fn configure<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .manage(LogBus::default())
        .manage(commands::blender_cmd::BlenderJob::default())
        .setup(|app| {
            let handle = app.handle();
            logbus::emit(
                handle,
                Level::Info,
                "app",
                format!("Project P v{} started ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_cmd::app_info,
            commands::app_cmd::log_history,
            commands::scanner_cmd::scan_directory,
            commands::renamer_cmd::dry_run_rename,
            commands::renamer_cmd::apply_rename,
            commands::renamer_cmd::undo_last_rename,
            commands::renamer_cmd::rename_history,
            commands::fbx_cmd::scan_fbx_files,
            commands::fbx_cmd::fix_fbx_paths,
            commands::fbx_cmd::restore_fbx_backup,
            commands::blender_cmd::discover_blender,
            commands::blender_cmd::run_blender_pack,
            commands::blender_cmd::cancel_blender_pack,
        ])
}

pub fn run() {
    configure(Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_fs::init()))
        .run(tauri::generate_context!())
        .expect("error while running Project P");
}
