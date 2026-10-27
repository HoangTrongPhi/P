//! Project P — Tauri 2 backend: IPC command registration and app bootstrap.

pub mod cli;
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
        .manage(commands::matcher_cmd::MatcherState::default())
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
            commands::app_cmd::ui_log,
            commands::app_cmd::save_text_file,
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
            commands::preview_cmd::decode_image,
            commands::preview_cmd::reveal_in_explorer,
            commands::preview_cmd::open_url,
            commands::tools_cmd::pack_orm_texture,
            commands::tools_cmd::find_duplicate_assets,
            commands::tools_cmd::find_unused_textures,
            commands::tools_cmd::find_texture_sets,
            commands::matcher_cmd::match_assets,
            commands::matcher_cmd::matcher_estimate,
            commands::matcher_cmd::cancel_matching,
            commands::matcher_cmd::clear_mesh_cache,
            commands::matcher_cmd::drive_mounts,
            commands::tools_cmd::pack_orm_batch,
            commands::tools_cmd::convert_textures,
            commands::tools_cmd::inspect_meshes,
            commands::recipe_cmd::load_recipe,
            commands::recipe_cmd::run_recipe,
            commands::kit_cmd::load_asset_manifest,
            commands::kit_cmd::assemble_kit,
        ])
}

pub fn run() {
    configure(Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_fs::init()))
        .run(tauri::generate_context!())
        .expect("error while running Project P");
}
