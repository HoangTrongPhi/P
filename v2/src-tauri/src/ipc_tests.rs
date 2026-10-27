//! End-to-end IPC tests: the real command set (`configure`) on Tauri's mock runtime, invoked
//! with the same JSON the frontend stores send (`src/stores/*Store.ts` via `src/lib/ipc.ts`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
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
        self.invoke_body(cmd, args).map(|body| body.deserialize::<Value>().expect("JSON response"))
    }

    /// For commands that answer with an ArrayBuffer (`tauri::ipc::Response`).
    fn invoke_raw(&self, cmd: &str, args: Value) -> Result<Vec<u8>, Value> {
        match self.invoke_body(cmd, args)? {
            InvokeResponseBody::Raw(bytes) => Ok(bytes),
            InvokeResponseBody::Json(j) => panic!("{cmd}: expected raw bytes, got JSON {j}"),
        }
    }

    fn invoke_body(&self, cmd: &str, args: Value) -> Result<InvokeResponseBody, Value> {
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
    assert_eq!(h.ok("ui_log", json!({ "level": "warn", "message": "from the UI" })), Value::Null);
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

#[test]
fn previewer_decode_image() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let tif = dir.path().join("height.tif");
    image::RgbaImage::from_fn(3, 2, |x, y| image::Rgba([x as u8 * 10, y as u8 * 10, 7, 255])).save(&tif).unwrap();

    // TextureViewer reads `width u32 LE | height u32 LE | RGBA8`.
    let bytes = h.invoke_raw("decode_image", json!({ "path": s(&tif) })).unwrap();
    assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 3);
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
    assert_eq!(bytes.len(), 8 + 3 * 2 * 4);
    assert_eq!(&bytes[8 + 4 * 4..8 + 4 * 4 + 4], &[10, 10, 7, 255], "pixel (1,1)");

    let err = h.invoke_body("decode_image", json!({ "path": s(&dir.path().join("missing.psd")) })).unwrap_err();
    assert!(err.is_string());
    assert!(h.invoke("reveal_in_explorer", json!({ "path": s(&dir.path().join("missing.png")) })).is_err());
}

#[test]
fn pipeline_tools_flow() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let gray = |name: &str, v: u8, size: u32| {
        let p = root.join("tex").join(name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        image::GrayImage::from_pixel(size, size, image::Luma([v])).save(&p).unwrap();
        p
    };
    let rough = gray("crate_roughness.png", 180, 8);
    let metal = gray("crate_metallic.png", 255, 8);
    let ao = gray("crate_ao.png", 90, 4);

    // ORM packer (ToolsTab): all three inputs, PNG out.
    let out = root.join("tex").join("T_Crate_ORM.png");
    let written = h.ok(
        "pack_orm_texture",
        json!({ "config": { "roughnessPath": s(&rough), "metallicPath": s(&metal), "aoPath": s(&ao), "outputPath": s(&out), "format": "png", "roughnessFromGloss": false } }),
    );
    assert_eq!(written.as_str().map(PathBuf::from), Some(out.clone()));
    let orm = image::open(&out).unwrap().to_rgb8();
    assert_eq!(orm.dimensions(), (8, 8));
    assert_eq!(orm.get_pixel(5, 5).0, [90, 180, 255], "R=AO G=Roughness B=Metallic");
    let err = h.invoke("pack_orm_texture", json!({ "config": { "outputPath": s(&out), "format": "png" } })).unwrap_err();
    assert!(err.as_str().unwrap().contains("at least one"));

    // Duplicates: the ORM inputs are distinct, two copies of the metallic map are not.
    fs::copy(&metal, root.join("copy_of_metal.png")).unwrap();
    let dup = h.ok("find_duplicate_assets", json!({ "folder": s(root) }));
    assert_eq!(dup["groups"].as_array().unwrap().len(), 1);
    assert_eq!(dup["groups"][0]["files"].as_array().unwrap().len(), 2);
    assert_eq!(dup["wastedBytes"], dup["groups"][0]["size"]);
    assert!(h.invoke("find_duplicate_assets", json!({ "folder": s(&root.join("nope")) })).is_err());

    // Unused textures: an FBX references only the roughness map.
    build_binary_fbx(&root.join("crate.fbx"), r"C:\elsewhere\crate_roughness.png", 7400, b"");
    let unused = h.ok("find_unused_textures", json!({ "folder": s(root) }));
    let mut names: Vec<&str> = unused["textures"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["T_Crate_ORM.png", "copy_of_metal.png", "crate_ao.png", "crate_metallic.png"]);
    assert_eq!(unused["referenceFiles"], 1);
    assert_eq!(unused["totalTextures"], 5);
    assert!(unused["reclaimableBytes"].as_u64().unwrap() > 0);
    assert_eq!((unused["blendFiles"].as_u64(), unused["blendInspected"].as_u64()), (Some(0), Some(0)));
}

#[test]
fn texture_sets_convert_meshes_and_recipes() {
    let h = Harness::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for (name, v) in [("wood_roughness.png", 100u8), ("wood_metallic.png", 0), ("wood_basecolor.png", 50), ("rock_N.png", 128)] {
        image::GrayImage::from_pixel(8, 8, image::Luma([v])).save(root.join(name)).unwrap();
    }

    // Texture sets (ToolsTab): wood can be packed, rock lacks base color and roughness.
    let rep = h.ok("find_texture_sets", json!({ "folder": s(root) }));
    let sets = rep["sets"].as_array().unwrap();
    assert_eq!(sets.len(), 2);
    let wood = sets.iter().find(|x| x["name"] == "wood").unwrap();
    assert_eq!(wood["canPackOrm"], true);
    assert!(wood["maps"]["roughness"].is_string() && wood["maps"]["baseColor"].is_string());
    let rock = sets.iter().find(|x| x["name"] == "rock").unwrap();
    assert_eq!(rock["missing"], json!(["baseColor", "roughness"]));

    let out = root.join("T_Wood_ORM.png");
    let packed = h.ok("pack_orm_batch", json!({ "configs": [
        { "roughnessPath": wood["maps"]["roughness"], "metallicPath": wood["maps"]["metallic"], "outputPath": s(&out), "format": "png" },
        { "outputPath": s(&root.join("bad.png")), "format": "png" }
    ] }));
    assert_eq!((packed[0]["ok"].as_bool(), packed[1]["ok"].as_bool()), (Some(true), Some(false)));
    assert!(out.exists());

    // Converter: folder input, dry run first, then a TGA with the green channel flipped.
    let opts = json!({ "maxSize": 4, "format": "tga", "flipGreen": true, "suffix": "_GL", "dryRun": true });
    let dry = h.ok("convert_textures", json!({ "paths": [s(&root.join("rock_N.png"))], "options": opts }));
    assert_eq!(dry[0]["toSize"], json!([4, 4]));
    assert!(!root.join("converted").exists());
    let mut live = opts.clone();
    live["dryRun"] = json!(false);
    let done = h.ok("convert_textures", json!({ "paths": [s(&root.join("rock_N.png"))], "options": live }));
    assert_eq!(done[0]["written"], true);
    let tga = image::open(root.join("converted").join("rock_N_GL.tga")).unwrap().to_rgba8();
    assert_eq!(tga.get_pixel(0, 0).0, [128, 127, 128, 255]);

    // Mesh inspector: folders expand to mesh files.
    fs::write(root.join("tri.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").unwrap();
    let stats = h.ok("inspect_meshes", json!({ "paths": [s(root)], "triBudget": 0 }));
    assert_eq!(stats.as_array().unwrap().len(), 1);
    assert_eq!((stats[0]["triangles"].as_u64(), stats[0]["uvSets"].as_u64()), (Some(1), Some(0)));
    assert!(stats[0]["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("UV")));

    // Recipes: saved as JSON, loaded back, run as a dry run.
    let recipe = json!({ "name": "audit", "steps": [{ "kind": "inspectMeshes" }, { "kind": "packOrm", "overwrite": true }] });
    let file = root.join("audit.json");
    h.ok("save_text_file", json!({ "path": s(&file), "contents": recipe.to_string() }));
    assert!(h.invoke("save_text_file", json!({ "path": s(&root.join("x.exe")), "contents": "" })).is_err(), "only report / recipe types");
    let loaded = h.ok("load_recipe", json!({ "path": s(&file) }));
    assert_eq!(loaded["steps"][1]["kind"], "packOrm");
    let before = fs::read(&out).unwrap();
    let run = h.ok("run_recipe", json!({ "recipe": loaded, "folder": s(root), "dryRun": true }));
    assert_eq!(run["ok"], true);
    assert!(run["steps"][1]["summary"].as_str().unwrap().starts_with("Would pack"), "{}", run["steps"][1]["summary"]);
    assert_eq!(fs::read(&out).unwrap(), before, "dry run leaves files alone");
    let bad = json!({ "steps": [] });
    assert!(h.invoke("run_recipe", json!({ "recipe": bad, "folder": s(root), "dryRun": true })).is_err());
}
