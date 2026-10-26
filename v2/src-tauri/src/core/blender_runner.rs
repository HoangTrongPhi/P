//! Blender 5.0+ discovery and headless pack / consolidate runner (port of `src/core/blender_packer.py`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::utils::paths::{path_key, unique_token};

pub const MIN_VERSION: (u32, u32) = (5, 0);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(1800);

static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Blender\s+(\d+)\.(\d+)(?:\.(\d+))?").unwrap());
static PROGRESS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^PP_PROGRESS (\d+)/(\d+) (.*)$").unwrap());

/// No console window flashes up for child processes on Windows.
fn command(exe: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderInstall {
    pub executable: PathBuf,
    pub version: (u32, u32, u32),
    pub version_string: String,
    pub supported: bool,
}

impl BlenderInstall {
    fn new(executable: PathBuf, version: (u32, u32, u32)) -> Self {
        Self {
            executable,
            version,
            version_string: format!("{}.{}.{}", version.0, version.1, version.2),
            supported: (version.0, version.1) >= MIN_VERSION,
        }
    }
}

pub fn parse_version(output: &str) -> Option<(u32, u32, u32)> {
    let c = VERSION_RE.captures(output)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?, c.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0)))
}

/// Run `blender --version` (cached per executable). `None` if it is not a working Blender.
pub fn probe_version(exe: &Path) -> Option<(u32, u32, u32)> {
    type Cache = HashMap<PathBuf, Option<(u32, u32, u32)>>;
    static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);
    if let Some(v) = CACHE.lock().ok()?.get(exe) {
        return *v;
    }
    let version = run_with_timeout(command(exe).arg("--version"), Duration::from_secs(60)).and_then(|out| parse_version(&out));
    CACHE.lock().ok()?.insert(exe.to_path_buf(), version);
    version
}

/// Capture stdout of a short command, killing it after `timeout`.
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
    reader.join().ok()
}

#[cfg(windows)]
fn registry_candidates() -> Vec<PathBuf> {
    // `reg.exe` keeps us free of a registry crate; output lines look like
    // "    Install_Dir    REG_SZ    C:\Program Files\Blender Foundation\Blender 5.2\".
    let queries: [&[&str]; 2] = [
        &["query", r"HKLM\SOFTWARE\BlenderFoundation", "/v", "Install_Dir"],
        &["query", r"HKCR\blendfile\shell\open\command", "/ve"],
    ];
    let mut found = Vec::new();
    for args in queries {
        let Some(out) = run_with_timeout(command("reg").args(args), Duration::from_secs(10)) else { continue };
        for line in out.lines() {
            let Some(idx) = line.find("REG_") else { continue };
            let rest = line[idx..].split_once(char::is_whitespace).map(|(_, r)| r.trim()).unwrap_or("");
            let raw = match rest.strip_prefix('"') {
                Some(r) => r.split('"').next().unwrap_or(""),
                None => rest.split(" \"").next().unwrap_or(rest), // drop trailing "%1" arguments
            };
            if raw.is_empty() {
                continue;
            }
            let p = PathBuf::from(raw);
            found.push(if p.is_dir() { p.join("blender.exe") } else { p });
        }
    }
    found
}

#[cfg(not(windows))]
fn registry_candidates() -> Vec<PathBuf> {
    Vec::new()
}

fn candidate_paths() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "blender.exe" } else { "blender" };
    let mut cands = Vec::new();
    if let Some(env) = std::env::var_os("BLENDER_PATH") {
        cands.push(PathBuf::from(env));
    }
    if let Some(path) = std::env::var_os("PATH") {
        cands.extend(std::env::split_paths(&path).map(|d| d.join(exe)));
    }
    cands.extend(registry_candidates());
    if cfg!(windows) {
        let mut bases: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
        bases.push(PathBuf::from(r"C:\Program Files"));
        for base in bases {
            let foundation = base.join("Blender Foundation");
            let Ok(entries) = fs::read_dir(&foundation) else { continue };
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("Blender"))).collect();
            dirs.sort();
            cands.extend(dirs.into_iter().map(|d| d.join(exe)));
        }
        let x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
        cands.push(x86.join(r"Steam\steamapps\common\Blender").join(exe));
    } else if cfg!(target_os = "macos") {
        cands.push(PathBuf::from("/Applications/Blender.app/Contents/MacOS/Blender"));
    } else {
        cands.extend([PathBuf::from("/usr/bin/blender"), PathBuf::from("/snap/bin/blender")]);
    }
    cands
}

/// Every working Blender install on this machine, newest first.
pub fn discover_blenders() -> Vec<BlenderInstall> {
    let mut seen = HashSet::new();
    let mut installs = Vec::new();
    for c in candidate_paths() {
        if !c.is_file() || !seen.insert(path_key(&c)) {
            continue;
        }
        if let Some(v) = probe_version(&c) {
            installs.push(BlenderInstall::new(c, v));
        }
    }
    installs.sort_by_key(|b| std::cmp::Reverse(b.version));
    installs
}

pub fn best_blender() -> Option<BlenderInstall> {
    discover_blenders().into_iter().find(|b| b.supported)
}

// --------------------------------------------------------------------------- packing

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOptions {
    /// Copy external files into `//textures` and remap.
    #[serde(default = "yes")]
    pub consolidate: bool,
    /// Unpack embedded files into `//textures`.
    #[serde(default)]
    pub unpack: bool,
    #[serde(default = "yes")]
    pub make_relative: bool,
    #[serde(default)]
    pub pack_all: bool,
    /// Save as a new .blend (otherwise overwrite; Blender keeps a `.blend1`).
    #[serde(default)]
    pub output: Option<PathBuf>,
    #[serde(default)]
    pub analyse_only: bool,
    /// Bundle the result (+ textures / assets folders) into a zip.
    #[serde(default)]
    pub zip_archive: Option<PathBuf>,
}

impl Default for PackOptions {
    fn default() -> Self {
        PackOptions { consolidate: true, unpack: false, make_relative: true, pack_all: false, output: None, analyse_only: false, zip_archive: None }
    }
}

impl PackOptions {
    pub fn to_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        for (on, flag) in [
            (self.consolidate, "--consolidate"),
            (self.unpack, "--unpack"),
            (self.make_relative, "--relative"),
            (self.pack_all, "--pack"),
            (self.analyse_only, "--no-save"),
        ] {
            if on {
                args.push(flag.to_string());
            }
        }
        if let Some(out) = &self.output {
            args.push("--output".into());
            args.push(out.to_string_lossy().into_owned());
        }
        args
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackResult {
    pub ok: bool,
    /// JSON report written by `headless_pack.py` (`before`, `after`, `missing`, `steps`, …).
    pub report: serde_json::Value,
    pub returncode: Option<i32>,
    pub output_lines: Vec<String>,
    pub archive: Option<PathBuf>,
    pub cancelled: bool,
    pub error: Option<String>,
}

impl PackResult {
    pub fn missing(&self) -> &[serde_json::Value] {
        self.report.get("missing").and_then(|m| m.as_array()).map(Vec::as_slice).unwrap_or(&[])
    }
}

pub struct RunHooks<'a> {
    pub on_line: &'a mut dyn FnMut(&str),
    pub on_progress: &'a mut dyn FnMut(u32, u32, &str),
    pub cancel: Option<Arc<AtomicBool>>,
    pub timeout: Duration,
}

/// `(done, total, message)` from a `PP_PROGRESS done/total message` line.
pub fn parse_progress(line: &str) -> Option<(u32, u32, String)> {
    let c = PROGRESS_RE.captures(line)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?, c[3].to_string()))
}

fn pump_lines(stream: impl Read + Send + 'static, tx: mpsc::Sender<String>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
            buf.clear();
            if tx.send(line).is_err() {
                break;
            }
        }
    })
}

/// Run `headless_pack.py` in Blender's background mode. Blocking: call from a worker thread.
pub fn run_pack(blender: &Path, script: &Path, blend_file: &Path, options: &PackOptions, hooks: RunHooks) -> Result<PackResult, String> {
    if !blend_file.is_file() {
        return Err(format!("Blend file not found: {}", blend_file.display()));
    }
    if !script.is_file() {
        return Err(format!("Pack script not found: {}", script.display()));
    }
    let tmp = std::env::temp_dir().join(format!("pp_blender_{}", unique_token()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let report_path = tmp.join("report.json");

    let mut cmd = command(blender);
    cmd.arg("-b").arg("--factory-startup").arg(blend_file).arg("-P").arg(script).arg("--").arg("--report").arg(&report_path);
    cmd.args(options.to_args());
    (hooks.on_line)(&format!("Running: {cmd:?}"));

    let result = (|| -> Result<PackResult, String> {
        let mut child: Child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Cannot start Blender: {e}"))?;
        let (tx, rx) = mpsc::channel();
        let pumps = [pump_lines(child.stdout.take().unwrap(), tx.clone()), pump_lines(child.stderr.take().unwrap(), tx)];

        let started = Instant::now();
        let mut lines = Vec::new();
        let mut cancelled = false;
        let status = loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(line) => {
                    if let Some((d, t, m)) = parse_progress(&line) {
                        (hooks.on_progress)(d, t, &m);
                    }
                    (hooks.on_line)(&line);
                    lines.push(line);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
            }
            let stop = hooks.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
            if !cancelled && (stop || started.elapsed() > hooks.timeout) {
                cancelled = true;
                let _ = child.kill();
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
        };
        for p in pumps {
            let _ = p.join();
        }
        for line in rx.try_iter() {
            (hooks.on_line)(&line);
            lines.push(line);
        }

        let report: serde_json::Value = fs::read_to_string(&report_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::Value::Null);
        let ok = report.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) && !cancelled;
        let error = if cancelled {
            Some(if started.elapsed() > hooks.timeout { "Timed out".to_string() } else { "Cancelled".to_string() })
        } else if let Some(e) = report.get("error").and_then(|e| e.as_str()) {
            Some(e.to_string())
        } else if !ok {
            Some(format!("Blender exited with code {:?}", status.code()))
        } else {
            None
        };
        Ok(PackResult { ok, report, returncode: status.code(), output_lines: lines, archive: None, cancelled, error })
    })();
    let _ = fs::remove_dir_all(&tmp);
    let mut result = result?;

    if let (true, Some(archive), false) = (result.ok, &options.zip_archive, options.analyse_only) {
        let blend = result.report.get("blend").and_then(|b| b.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| blend_file.to_path_buf());
        match bundle_archive(&blend, archive) {
            Ok(p) => result.archive = Some(p),
            Err(e) => {
                result.ok = false;
                result.error = Some(format!("Archive failed: {e}"));
            }
        }
    }
    Ok(result)
}

/// Zip the .blend plus its sibling `textures/`, `assets/`, `sounds/` and `fonts/` folders.
pub fn bundle_archive(blend_file: &Path, archive: &Path) -> std::io::Result<PathBuf> {
    use zip::write::SimpleFileOptions;
    if let Some(parent) = archive.parent() {
        fs::create_dir_all(parent)?;
    }
    let root = blend_file.parent().unwrap_or(Path::new("."));
    let mut zw = zip::ZipWriter::new(fs::File::create(archive)?);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut add = |path: &Path, name: String| -> std::io::Result<()> {
        zw.start_file(name, opts).map_err(std::io::Error::other)?;
        std::io::copy(&mut fs::File::open(path)?, &mut zw)?;
        Ok(())
    };
    add(blend_file, blend_file.file_name().unwrap_or_default().to_string_lossy().into_owned())?;
    for sub in ["textures", "assets", "sounds", "fonts"] {
        let folder = root.join(sub);
        if !folder.is_dir() {
            continue;
        }
        let mut files: Vec<PathBuf> = walkdir::WalkDir::new(&folder).into_iter().flatten().filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect();
        files.sort();
        for f in files {
            let rel = f.strip_prefix(root).unwrap_or(&f).to_string_lossy().replace('\\', "/");
            add(&f, rel)?;
        }
    }
    zw.finish().map_err(std::io::Error::other)?;
    Ok(archive.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_and_progress_parsing() {
        assert_eq!(parse_version("Blender 5.2.2\n\tbuild date: ..."), Some((5, 2, 2)));
        assert_eq!(parse_version("Blender 5.0"), Some((5, 0, 0)));
        assert_eq!(parse_version("nope"), None);
        assert_eq!(parse_progress("PP_PROGRESS 3/7 Packing images"), Some((3, 7, "Packing images".into())));
        assert_eq!(parse_progress("Read blend: x"), None);
    }

    #[test]
    fn options_to_args() {
        let o = PackOptions { pack_all: true, output: Some(PathBuf::from("o.blend")), ..Default::default() };
        let args = o.to_args();
        assert_eq!(&args[..3], ["--consolidate", "--relative", "--pack"]);
        assert_eq!(args[args.len() - 2], "--output");
    }

    /// Integration checks against a real Blender 5.x; skipped when none is installed.
    mod with_blender {
        use super::super::*;
        use crate::core::fbx::{fix_fbx, FixMode, FixOptions};

        fn script() -> PathBuf {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../dcc_scripts/blender/headless_pack.py")
        }

        /// Builds the prototype's real-world fixtures (FBX + .blend with an absolute texture).
        fn fixtures(blender: &Path, base: &Path) -> PathBuf {
            let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/blender_make_fixtures.py");
            let out = base.join("out");
            let res = command(blender).arg("-b").arg("--factory-startup").arg("-P").arg(&script).arg("--").arg(&out).arg(base.join("ext_tex")).output().unwrap();
            assert!(String::from_utf8_lossy(&res.stdout).contains("FIXTURES_OK"), "{}", String::from_utf8_lossy(&res.stderr));
            out
        }

        fn run(blender: &Path, blend: &Path, opts: &PackOptions, progress: &mut Vec<(u32, u32)>) -> PackResult {
            run_pack(blender, &script(), blend, opts, RunHooks {
                on_line: &mut |_| {},
                on_progress: &mut |d, t, _| progress.push((d, t)),
                cancel: None,
                timeout: Duration::from_secs(300),
            })
            .unwrap()
        }

        #[test]
        fn discovery_pack_and_fbx_import() {
            let Some(b) = best_blender() else {
                eprintln!("Blender 5.0+ not installed; skipping");
                return;
            };
            assert!(b.supported && b.executable.is_file());
            let dir = tempfile::tempdir().unwrap();
            let out = fixtures(&b.executable, dir.path());

            // Analyse only: one absolute dependency, file untouched.
            let blend = dir.path().join("crate.blend");
            fs::copy(out.join("scene").join("crate.blend"), &blend).unwrap();
            let before = fs::read(&blend).unwrap();
            let res = run(&b.executable, &blend, &PackOptions { consolidate: false, make_relative: false, analyse_only: true, ..Default::default() }, &mut vec![]);
            assert!(res.ok, "{:?}", res.error);
            let deps = res.report["after"].as_array().unwrap();
            assert_eq!(deps.len(), 1);
            assert!(deps[0]["exists"].as_bool().unwrap() && !deps[0]["relative"].as_bool().unwrap());
            assert_eq!(fs::read(&blend).unwrap(), before);

            // Consolidate to a new location with a zip bundle and live progress.
            let packed = dir.path().join("packed").join("crate.blend");
            let mut progress = vec![];
            let res = run(&b.executable, &out.join("scene").join("crate.blend"), &PackOptions { output: Some(packed.clone()), zip_archive: Some(dir.path().join("c.zip")), ..Default::default() }, &mut progress);
            assert!(res.ok, "{:?}", res.error);
            let last = progress.last().unwrap();
            assert_eq!(last.0, last.1);
            let dep = &res.report["after"][0];
            assert_eq!(dep["filepath"].as_str().unwrap().replace('\\', "/"), "//textures/crate_diffuse.png");
            assert!(packed.parent().unwrap().join("textures").join("crate_diffuse.png").exists());
            let zip = zip::ZipArchive::new(fs::File::open(res.archive.unwrap()).unwrap()).unwrap();
            let mut names: Vec<_> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
            names.sort();
            assert_eq!(names, ["crate.blend", "textures/crate_diffuse.png"]);

            // A Rust-rewritten FBX must import cleanly in Blender with its texture found.
            let work = dir.path().join("portable");
            fs::create_dir(&work).unwrap();
            let fbx = work.join("crate.fbx");
            fs::copy(out.join("crate_abs.fbx"), &fbx).unwrap();
            let rep = fix_fbx(&fbx, &FixOptions { mode: FixMode::Collect, ..Default::default() }).unwrap();
            assert!(rep.written && work.join("textures").join("crate_diffuse.png").exists());
            let expr = format!(
                "import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.import_scene.fbx(filepath={:?})\n\
                 imgs=[i for i in bpy.data.images if i.source=='FILE']\n\
                 print('IMPORT_RESULT', len(bpy.data.meshes), [bpy.path.abspath(i.filepath) for i in imgs], [i.has_data or i.size[0]>0 for i in imgs])\n",
                fbx.to_string_lossy()
            );
            let res = command(&b.executable).arg("-b").arg("--factory-startup").arg("--python-expr").arg(expr).output().unwrap();
            let stdout = String::from_utf8_lossy(&res.stdout);
            let line = stdout.lines().find(|l| l.starts_with("IMPORT_RESULT")).unwrap_or_else(|| panic!("{stdout}"));
            assert!(line.contains("IMPORT_RESULT 1") && line.contains("portable") && line.contains("crate_diffuse.png") && line.contains("True"), "{line}");
        }
    }
}
