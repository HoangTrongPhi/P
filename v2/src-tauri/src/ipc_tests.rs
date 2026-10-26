//! End-to-end IPC tests: the real command set (`configure`) on Tauri's mock runtime, invoked
//! with the same JSON the frontend stores send (`src/stores/*Store.ts` via `src/lib/ipc.ts`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

use crate::commands::blender_cmd::PROGRESS_EVENT;
use crate::core::blender_runner::best_blender;
use crate::core::fbx::test_support::build_binary_fbx;
use crate::utils::logbus::LOG_EVENT;

struct Harness {
    app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
}

impl Harness {
    fn new() -> Self {
        let app = super::configure(mock_builder()).build(mock_context(noop_assets())).expect("build mock app");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("main window");
        Harness { app, webview }
    }

    /// `invoke(cmd, args)` exactly as `@tauri-apps/api/core` would send it.
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let url = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
        get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("JSON response"))
    }

    fn ok(&self, cmd: &str, args: Value) -> Value {
        self.invoke(cmd, args).unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

    /// Collect payloads of a backend event.
    fn listen(&self, event: &str) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        self.app.listen_any(event, move |e| {
            let _ = tx.send(serde_json::from_str(e.payload()).unwrap_or(Value::Null));
        });
        rx
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn app_info_and_log_history() {
    let h = Harness::new();
    let info = h.ok("app_info", json!({}));
    // The mock context carries its own package info; the real app reads tauri.conf.json.
    assert!(info["version"].as_str().is_some_and(|v| !v.is_empty()));
    assert_eq!(info["debug"], cfg!(debug_assertions));
    assert!(info["tauriVersion"].is_string());
    // Entries logged before the UI subscribed are backfilled. (The setup hook's "started" line only
    // runs with the real event loop, so log something through a command first.)
    let dir = tempfile::tempdir().unwrap();
    h.ok("scan_directory", json!({ "path": s(dir.path()), "recursive": true, "filters": [] }));
    let logs = h.ok("log_history", json!({}));
    let entry = logs.as_array().unwrap().iter().find(|l| l["source"] == "scanner").expect("scanner entry backfilled").clone();
    assert_eq!(entry["level"], "info");
    assert!(entry["tsMs"].as_u64().unwrap() > 0 && entry["message"].as_str().unwrap().starts_with("Scanned"));
}

#[test]
fn renamer_flow() {
    let h = Harness::new();
    let logs = h.listen(LOG_EVENT);
    let dir = tempfile::tempdir().unwrap();
    let folder = s(dir.path());
    let originals = ["chair.fbx", "hero_skel.fbx", "wood_planks_basecolor.png", "rock01_Roughness.tga", "T_Crate_D.png", "notes.txt"];
    for n in originals {
        fs::write(dir.path().join(n), n).unwrap();
    }

    // Drop -> header counter (lib/assets.ts).
    let summary = h.ok("scan_directory", json!({ "path": folder, "recursive": true, "filters": [] }));
    assert_eq!(summary["files"].as_array().unwrap().len(), 5, "txt is not an asset");

    // Live dry run (renamerStore.refresh): `paths` is omitted when a folder was dropped.
    let rules = json!({ "rules": [{ "kind": "preset", "preset": "ue5" }], "recursive": false, "extensions": [] });
    let rows = h.ok("dry_run_rename", json!({ "folder": folder, "rules": rules }));
    let rows = rows.as_array().unwrap();
    let by_name = |n: &str| rows.iter().find(|r| r["originalName"] == n).unwrap().clone();
    assert_eq!(by_name("chair.fbx")["newName"], "SM_Chair.fbx");
    assert_eq!(by_name("hero_skel.fbx")["newName"], "SK_Hero.fbx");
    assert_eq!(by_name("wood_planks_basecolor.png")["newName"], "T_WoodPlanks_D.png");
    assert_eq!(by_name("T_Crate_D.png")["status"], "Skipped");
    assert_eq!(rows.iter().filter(|r| r["status"] == "OK").count(), 4);

    // Apply (renamerStore.apply) sends only the OK rows.
    let items: Vec<Value> = rows
        .iter()
        .filter(|r| r["status"] == "OK")
        .map(|r| json!({ "originalPath": r["originalPath"], "targetPath": r["targetPath"] }))
        .collect();
    let res = h.ok("apply_rename", json!({ "folder": folder, "items": items }));
    assert_eq!(res["renamed"], 4);
    assert!(res["rejected"].as_array().unwrap().is_empty());
    assert!(names(dir.path()).contains(&"SM_Chair.fbx".to_string()));
    assert!(dir.path().join(".rename_history.json").exists());

    let history = h.ok("rename_history", json!({ "folder": folder }));
    assert_eq!(history[0]["count"], 4);

    // Undo restores every original name and empties the stack.
    let undo = h.ok("undo_last_rename", json!({ "folder": folder }));
    assert_eq!(undo["restored"], 4);
    let mut expected: Vec<String> = originals.iter().map(|s| s.to_string()).collect();
    expected.push(".rename_history.json".into());
    expected.sort();
    assert_eq!(names(dir.path()), expected);
    assert!(h.ok("rename_history", json!({ "folder": folder })).as_array().unwrap().is_empty());

    // Errors come back as rejected promises with a message.
    let bad = json!({ "rules": [{ "kind": "searchReplace", "find": "(", "regex": true }] });
    let err = h.invoke("dry_run_rename", json!({ "folder": folder, "rules": bad })).unwrap_err();
    assert!(err.as_str().unwrap().contains("Invalid regex"));
    assert!(h.invoke("scan_directory", json!({ "path": s(&dir.path().join("nope")), "recursive": true, "filters": [] })).is_err());

    let sources: Vec<String> = logs.try_iter().filter_map(|l| l["source"].as_str().map(String::from)).collect();
    assert!(sources.contains(&"scanner".into()) && sources.contains(&"renamer".into()), "{sources:?}");
}

#[test]
fn renamer_explicit_files_and_safety_recheck() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let folder = s(dir.path());
    for n in ["a.png", "b.png", "c.png"] {
        fs::write(dir.path().join(n), n).unwrap();
    }
    // Individual files dropped: `paths` set, folder = their parent.
    let rules = json!({ "rules": [{ "kind": "prefix", "prefix": "T_", "skipIfPresent": true }], "recursive": false, "extensions": [], "paths": [s(&dir.path().join("a.png"))] });
    let rows = h.ok("dry_run_rename", json!({ "folder": folder, "rules": rules }));
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["newName"], "T_a.png");

    // The disk changed after the dry run: the target now exists, so apply must refuse it.
    fs::write(dir.path().join("T_a.png"), "new").unwrap();
    let res = h.ok("apply_rename", json!({ "folder": folder, "items": [{ "originalPath": rows[0]["originalPath"], "targetPath": rows[0]["targetPath"] }] }));
    assert_eq!(res["renamed"], 0);
    assert_eq!(res["rejected"][0]["status"], "Collision");
    assert_eq!(fs::read_to_string(dir.path().join("T_a.png")).unwrap(), "new", "existing file untouched");
}

#[test]
fn fbx_doctor_flow() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let tex = dir.path().join("elsewhere").join("wood.png");
    fs::create_dir_all(tex.parent().unwrap()).unwrap();
    fs::write(&tex, b"png-data").unwrap();
    let model_dir = dir.path().join("model");
    fs::create_dir(&model_dir).unwrap();
    let fbx = build_binary_fbx(&model_dir.join("crate.fbx"), &s(&tex), 7500, b"");
    fs::write(model_dir.join("broken.fbx"), "not an fbx").unwrap();
    let original = fs::read(&fbx).unwrap();

    // Folder dropped (fbxStore.rescan); `searchDirs` is omitted by the frontend.
    let files = h.ok("scan_fbx_files", json!({ "paths": [s(&model_dir)] }));
    let files = files.as_array().unwrap();
    assert_eq!(files.len(), 2);
    let crate_info = files.iter().find(|f| f["path"].as_str().unwrap().ends_with("crate.fbx")).unwrap();
    assert_eq!(crate_info["isBinary"], true);
    assert_eq!(crate_info["version"], 7500);
    // Video: P:Path, Filename, RelativeFilename; Texture: FileName, RelativeFilename.
    assert_eq!(crate_info["problemCount"], 5);
    assert!(crate_info["entries"].as_array().unwrap().iter().all(|e| e["kind"] == "ABSOLUTE_LOCAL" && e["resolution"] == "found"));
    let broken = files.iter().find(|f| f["path"].as_str().unwrap().ends_with("broken.fbx")).unwrap();
    assert!(broken["error"].is_string());

    // Preview (dry run) writes nothing.
    let plan = |dry: bool| json!({ "plan": { "paths": [s(&fbx)], "mode": "collect", "subfolder": "textures", "rebaseDir": null, "fixAll": false, "backup": true, "dryRun": dry } });
    let preview = h.ok("fix_fbx_paths", plan(true));
    assert_eq!(preview["reports"][0]["dryRun"], true);
    assert_eq!(preview["reports"][0]["changes"].as_array().unwrap().len(), 5);
    assert_eq!(fs::read(&fbx).unwrap(), original);
    assert!(!model_dir.join("textures").exists());

    // Fix: rewrite, backup, copy texture; a rescan is clean.
    let fixed = h.ok("fix_fbx_paths", plan(false));
    let report = &fixed["reports"][0];
    assert_eq!(report["written"], true);
    assert!(report["changes"].as_array().unwrap().iter().all(|c| c["new"] == "textures/wood.png"));
    assert_eq!(fs::read(model_dir.join("crate.fbx.bak")).unwrap(), original);
    assert_eq!(fs::read(model_dir.join("textures").join("wood.png")).unwrap(), b"png-data");
    let rescan = h.ok("scan_fbx_files", json!({ "paths": [s(&fbx)], "searchDirs": null }));
    assert_eq!(rescan[0]["hasIssues"], false);

    // Restore from backup brings the absolute paths back.
    assert_eq!(h.ok("restore_fbx_backup", json!({ "path": s(&fbx) })), true);
    assert_eq!(fs::read(&fbx).unwrap(), original);
    assert_eq!(h.ok("restore_fbx_backup", json!({ "path": s(&model_dir.join("broken.fbx")) })), false);
}

fn blender_fixture(blender: &Path, base: &Path) -> PathBuf {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/blender_make_fixtures.py");
    let out = base.join("out");
    let res = std::process::Command::new(blender)
        .args(["-b", "--factory-startup", "-P"])
        .arg(&script)
        .arg("--")
        .arg(&out)
        .arg(base.join("ext_tex"))
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&res.stdout).contains("FIXTURES_OK"));
    out.join("scene").join("crate.blend")
}

#[test]
fn blender_packer_flow() {
    let h = Harness::new();
    assert_eq!(h.ok("cancel_blender_pack", json!({})), false, "nothing running");
    let installs = h.ok("discover_blender", json!({}));
    if installs.as_array().unwrap().is_empty() || best_blender().is_none() {
        eprintln!("Blender 5.0+ not installed; skipping blender_packer_flow");
        return;
    }
    assert!(installs[0]["supported"].as_bool().unwrap());

    let dir = tempfile::tempdir().unwrap();
    let blend = blender_fixture(Path::new(installs[0]["executable"].as_str().unwrap()), dir.path());
    let out = dir.path().join("packed").join("crate.blend");
    let zip = dir.path().join("crate_bundle.zip");
    let progress = h.listen(PROGRESS_EVENT);

    // blenderStore.run: blenderPath null = newest supported install.
    let res = h.ok(
        "run_blender_pack",
        json!({ "config": {
            "blenderPath": null,
            "blendFile": s(&blend),
            "options": { "consolidate": true, "unpack": false, "makeRelative": true, "packAll": false, "analyseOnly": false, "output": s(&out), "zipArchive": s(&zip) }
        }}),
    );
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["error"], Value::Null);
    assert_eq!(res["report"]["after"][0]["filepath"].as_str().unwrap().replace('\\', "/"), "//textures/crate_diffuse.png");
    assert!(res["report"]["missing"].as_array().unwrap().is_empty());
    assert!(out.exists() && out.parent().unwrap().join("textures").join("crate_diffuse.png").exists());
    assert!(zip.exists());
    assert_eq!(res["archive"].as_str().map(PathBuf::from), Some(zip.clone()));

    let events: Vec<Value> = progress.try_iter().collect();
    assert!(!events.is_empty(), "no blender://progress events");
    let last = events.last().unwrap();
    assert_eq!(last["done"], last["total"]);
    assert!(last["message"].is_string());

    // Analyse-only leaves the file untouched.
    let before = fs::read(&blend).unwrap();
    let res = h.ok("run_blender_pack", json!({ "config": { "blenderPath": null, "blendFile": s(&blend), "options": { "analyseOnly": true, "output": null, "zipArchive": null } } }));
    assert_eq!(res["ok"], true);
    assert_eq!(fs::read(&blend).unwrap(), before);

    // A missing .blend is reported as an error, and the job slot is released afterwards.
    let err = h.invoke("run_blender_pack", json!({ "config": { "blendFile": s(&dir.path().join("nope.blend")) } })).unwrap_err();
    assert!(err.as_str().unwrap().contains("not found"));
    assert_eq!(h.ok("cancel_blender_pack", json!({})), false);
    std::thread::sleep(Duration::from_millis(10));
}
