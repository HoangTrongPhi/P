//! Google Drive for desktop awareness: find its virtual drives, tell whether a path is streamed
//! from the cloud (reading a file's content downloads it), and pull the id out of a Drive link.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MY_DRIVE: &str = "My Drive";
const SHARED_DRIVES: &str = "Shared drives";
/// Volume label Drive for desktop gives its virtual drive.
const VOLUME_LABEL: &str = "Google Drive";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveMount {
    /// `G:\` on Windows, `~/Library/CloudStorage/GoogleDrive-…` on macOS.
    pub root: PathBuf,
    pub my_drive: Option<PathBuf>,
    /// Each shared drive's folder (listing names downloads nothing).
    pub shared_drives: Vec<PathBuf>,
}

fn mount_at(root: PathBuf) -> DriveMount {
    let my = root.join(MY_DRIVE);
    let mut shared: Vec<PathBuf> = fs::read_dir(root.join(SHARED_DRIVES))
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    shared.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    DriveMount { my_drive: my.is_dir().then_some(my), shared_drives: shared, root }
}

/// A folder laid out like a Drive for desktop root.
fn looks_like_drive_root(root: &Path) -> bool {
    root.join(MY_DRIVE).is_dir() || root.join(SHARED_DRIVES).is_dir()
}

#[cfg(windows)]
fn candidate_roots() -> Vec<PathBuf> {
    extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn GetVolumeInformationW(root: *const u16, name: *mut u16, name_len: u32, serial: *mut u32, max_component: *mut u32, flags: *mut u32, fs_name: *mut u16, fs_name_len: u32) -> i32;
    }
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| {
            let root = format!("{}:\\", (b'A' + i) as char);
            let wide: Vec<u16> = root.encode_utf16().chain([0]).collect();
            // Skip floppies, CD drives and the like: probing them can stall.
            let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
            if kind != DRIVE_FIXED && kind != DRIVE_REMOTE {
                return None;
            }
            let mut label = [0u16; 64];
            let ok = unsafe { GetVolumeInformationW(wide.as_ptr(), label.as_mut_ptr(), label.len() as u32, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0) };
            let label = String::from_utf16_lossy(&label[..label.iter().position(|&c| c == 0).unwrap_or(0)]);
            let root = PathBuf::from(root);
            (ok != 0 && label.contains(VOLUME_LABEL) || looks_like_drive_root(&root)).then_some(root)
        })
        .collect()
}

#[cfg(not(windows))]
fn candidate_roots() -> Vec<PathBuf> {
    // macOS: ~/Library/CloudStorage/GoogleDrive-<account>; older installs mount /Volumes/GoogleDrive.
    let mut out: Vec<PathBuf> = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/CloudStorage"))
        .and_then(|d| fs::read_dir(d).ok())
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("GoogleDrive"))).collect())
        .unwrap_or_default();
    let volume = PathBuf::from("/Volumes/GoogleDrive");
    if volume.is_dir() {
        out.push(volume);
    }
    out
}

/// Drive for desktop mounts on this machine.
pub fn drive_mounts() -> Vec<DriveMount> {
    candidate_roots().into_iter().map(mount_at).collect()
}

/// Whether `path` is (probably) streamed by Drive for desktop: under one of its mounts, or under
/// a `My Drive` / `Shared drives` folder the way Drive lays them out.
pub fn is_cloud_path(path: &Path, mounts: &[DriveMount]) -> bool {
    if mounts.iter().any(|m| path.starts_with(&m.root)) {
        return true;
    }
    path.components().any(|c| {
        let c = c.as_os_str().to_string_lossy();
        c == MY_DRIVE || c == SHARED_DRIVES || c.starts_with("GoogleDrive-")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_paths() {
        let mount = DriveMount { root: PathBuf::from("/drive_g"), my_drive: None, shared_drives: vec![] };
        assert!(is_cloud_path(Path::new("/drive_g/anything"), &[mount]));
        assert!(is_cloud_path(Path::new("/x/Shared drives/Artist Repo/Wall"), &[]));
        assert!(is_cloud_path(Path::new("/Users/a/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/x"), &[]));
        assert!(!is_cloud_path(Path::new("/projects/assets"), &[]));
    }

    #[test]
    fn mount_lists_shared_drives() {
        let dir = tempfile::tempdir().unwrap();
        for d in ["My Drive", "Shared drives/Artist Repo", "Shared drives/Audio"] {
            fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        assert!(looks_like_drive_root(dir.path()));
        let m = mount_at(dir.path().to_path_buf());
        assert!(m.my_drive.is_some());
        let names: Vec<String> = m.shared_drives.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["Artist Repo", "Audio"]);
    }
}
