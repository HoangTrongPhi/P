use serde::Serialize;
use tauri::State;

use crate::utils::logbus::{LogBus, LogEntry};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
    pub debug: bool,
}

#[tauri::command]
pub fn app_info<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        debug: cfg!(debug_assertions),
    }
}

/// Mirror a UI-side log line to stderr so `tauri dev` output shows frontend errors too.
/// (Not re-emitted: the UI already shows its own lines in the drawer.)
#[tauri::command]
pub fn ui_log(level: String, message: String) {
    eprintln!("[UI {level}] {message}");
}

/// Entries logged before the frontend subscribed to `log://entry`.
#[tauri::command]
pub fn log_history(bus: State<'_, LogBus>) -> Vec<LogEntry> {
    bus.history()
}
