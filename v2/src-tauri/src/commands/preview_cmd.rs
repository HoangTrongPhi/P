use std::path::PathBuf;

use tauri::ipc::Response;

use crate::core::image_ops::decode_rgba;

/// Decode a texture the webview cannot read itself (PSD, TIFF, …).
/// Returns raw bytes: `width u32 LE | height u32 LE | RGBA8 pixels` (an ArrayBuffer in JS).
#[tauri::command]
pub async fn decode_image(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    let img = tauri::async_runtime::spawn_blocking(move || decode_rgba(&path)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(img.into_bytes()))
}

/// Show a file selected in Explorer / Finder / the file manager.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Not found: {path}"));
    }
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}
