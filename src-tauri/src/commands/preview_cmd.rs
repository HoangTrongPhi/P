use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

use crate::core::image_ops::decode_rgba;

/// Decode a texture the webview cannot read itself (PSD, TIFF, …).
/// Returns raw bytes: `width u32 LE | height u32 LE | RGBA8 pixels` (an ArrayBuffer in JS).
#[tauri::command]
pub async fn decode_image(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    let img = tauri::async_runtime::spawn_blocking(move || decode_rgba(&path)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(img.into_bytes()))
}

/// Open a web or mail link from the About dialog in the default browser / mail app.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let allowed = (url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"');
    if !allowed {
        return Err(format!("Not an http(s) or mailto link: {url}"));
    }
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
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

/// The user guide PDF bundled as a resource (`docs/user-guide/Poseidon_User_Guide_<lang>.pdf`, built
/// from the Help content by `npm run guide`); Vietnamese unless `lang` is `en`.
pub fn user_guide_path<R: Runtime>(app: &AppHandle<R>, lang: &str) -> Result<PathBuf, String> {
    let lang = if lang == "en" { "en" } else { "vi" };
    let path = app.path().resolve(format!("user-guide/Poseidon_User_Guide_{lang}.pdf"), BaseDirectory::Resource).map_err(|e| e.to_string())?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("User guide not found: {}", path.display()))
    }
}

/// Open the user guide PDF in the default PDF viewer.
#[tauri::command]
pub fn open_user_guide<R: Runtime>(app: AppHandle<R>, lang: String) -> Result<(), String> {
    let path = user_guide_path(&app, &lang)?;
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&path).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    /// `open_user_guide` resolves `user-guide/Poseidon_User_Guide_<lang>.pdf`: both PDFs exist and are bundled there.
    #[test]
    fn user_guide_pdfs_are_bundled() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        for lang in ["vi", "en"] {
            let file = format!("Poseidon_User_Guide_{lang}.pdf");
            let source = format!("../docs/user-guide/{file}");
            assert_eq!(conf["bundle"]["resources"][&source], format!("user-guide/{file}"), "tauri.conf.json bundle.resources");
            assert!(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&source).is_file(), "{source} missing: run npm run guide");
        }
    }
}
