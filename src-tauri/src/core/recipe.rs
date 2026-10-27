//! Pipeline recipes: an ordered list of toolkit steps run on one folder, from the UI or the
//! command line (`poseidon --recipe <file.json> <folder>`). Every step re-scans the folder, so
//! a step sees what the previous one renamed or wrote. A failed step stops the run; single files
//! that fail inside a step (an unreadable texture, …) are counted as problems and the run goes on.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::duplicate_finder::find_duplicates;
use super::fbx::{fix_fbx, FixOptions};
use super::image_ops::{pack_orm, OrmFormat, OrmPackConfig};
use super::mesh_stats::inspect_meshes;
use super::renamer::{build_plan, compile_rules, execute_plan, RuleSpec, Status};
use super::scanner::{normalize_exts, scan};
use super::texture_convert::{convert_textures, ConvertOptions};
use super::texture_sets::{find_texture_sets, MapKind};
use super::usage::{find_unused_textures_with, BlendReader};
use crate::utils::history::RenameHistory;
use crate::utils::paths::{MESH_EXTS, TEXTURE_EXTS};

/// Detail lines kept per step; the summary always has the totals.
const MAX_DETAILS: usize = 300;

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecipeStep {
    /// Rename with the Renamer's rules; undoable from the Renamer tab (same history file).
    #[serde(rename_all = "camelCase")]
    Rename {
        rules: Vec<RuleSpec>,
        /// Empty means every asset type.
        #[serde(default)]
        extensions: Vec<String>,
        #[serde(default = "yes")]
        recursive: bool,
    },
    /// FBX Doctor on every `.fbx` under the folder.
    #[serde(rename_all = "camelCase")]
    FbxFix {
        #[serde(default)]
        options: FixOptions,
    },
    /// ORM texture for every texture set that has roughness / metallic / AO maps but no ORM.
    #[serde(rename_all = "camelCase")]
    PackOrm {
        #[serde(default)]
        format: OrmFormat,
        #[serde(default)]
        overwrite: bool,
    },
    #[serde(rename_all = "camelCase")]
    ConvertTextures {
        #[serde(default)]
        options: ConvertOptions,
        /// Only these source types; empty means every texture.
        #[serde(default)]
        extensions: Vec<String>,
        /// Only files whose name contains this text (e.g. `_N` for normal maps).
        #[serde(default)]
        name_contains: String,
    },
    #[serde(rename_all = "camelCase")]
    InspectMeshes {
        #[serde(default)]
        tri_budget: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    FindUnused {
        /// Read `.blend` files through Blender (needs Blender 5.0+).
        #[serde(default)]
        include_blend: bool,
    },
    FindDuplicates {},
}

impl RecipeStep {
    pub fn kind(&self) -> &'static str {
        match self {
            RecipeStep::Rename { .. } => "rename",
            RecipeStep::FbxFix { .. } => "fbxFix",
            RecipeStep::PackOrm { .. } => "packOrm",
            RecipeStep::ConvertTextures { .. } => "convertTextures",
            RecipeStep::InspectMeshes { .. } => "inspectMeshes",
            RecipeStep::FindUnused { .. } => "findUnused",
            RecipeStep::FindDuplicates {} => "findDuplicates",
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            RecipeStep::Rename { .. } => "Rename assets",
            RecipeStep::FbxFix { .. } => "Fix FBX texture paths",
            RecipeStep::PackOrm { .. } => "Pack ORM textures",
            RecipeStep::ConvertTextures { .. } => "Convert textures",
            RecipeStep::InspectMeshes { .. } => "Inspect meshes",
            RecipeStep::FindUnused { .. } => "Find unused textures",
            RecipeStep::FindDuplicates {} => "Find duplicates",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: Vec<RecipeStep>,
}

impl Recipe {
    /// Parse and check a recipe (rename rules compile, at least one step).
    pub fn from_json(text: &str) -> Result<Recipe, String> {
        let recipe: Recipe = serde_json::from_str(text).map_err(|e| format!("Invalid recipe: {e}"))?;
        recipe.validate()?;
        Ok(recipe)
    }

    pub fn load(path: &Path) -> Result<Recipe, String> {
        let text = fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        Recipe::from_json(&text)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.steps.is_empty() {
            return Err("The recipe has no steps".into());
        }
        for (i, step) in self.steps.iter().enumerate() {
            if let RecipeStep::Rename { rules, .. } = step {
                compile_rules(rules).map_err(|e| format!("Step {} ({}): {e}", i + 1, step.title()))?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    pub kind: &'static str,
    pub title: &'static str,
    pub ok: bool,
    /// Not run because an earlier step failed.
    pub skipped: bool,
    pub summary: String,
    pub details: Vec<String>,
    /// Items that failed or need attention; the step itself completed.
    pub problems: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRun {
    pub name: String,
    pub folder: PathBuf,
    pub dry_run: bool,
    pub ok: bool,
    pub steps: Vec<StepOutcome>,
    pub elapsed_ms: u64,
}

pub struct RecipeEnv<'a> {
    /// Reads `.blend` dependencies for `findUnused { includeBlend }`; `None` makes that an error.
    pub blend_reader: Option<&'a BlendReader<'a>>,
    /// `(step index, step count, title)` before each step.
    pub on_step: &'a mut dyn FnMut(usize, usize, &str),
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn files(root: &Path, exts: &[&str]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = scan(root, &normalize_exts(exts), true, None).files.into_iter().map(|f| f.path).collect();
    v.sort();
    v
}

/// `(summary, details, problems)` of a completed step. Detail lines starting with `!` are problems.
type StepResult = Result<(String, Vec<String>, usize), String>;

fn run_step(step: &RecipeStep, root: &Path, dry: bool, env: &RecipeEnv) -> StepResult {
    let verb = |live: &'static str, would: &'static str| if dry { would } else { live };
    match step {
        RecipeStep::Rename { rules, extensions, recursive } => {
            let compiled = compile_rules(rules)?;
            let paths: Vec<PathBuf> = scan(root, &normalize_exts(extensions), *recursive, None).files.into_iter().map(|f| f.path).collect();
            let plan = build_plan(&paths, &compiled);
            let mut details: Vec<String> = plan.iter().filter(|e| e.status == Status::Ok).map(|e| format!("{} -> {}", rel(root, &e.src), e.new_name)).collect();
            let problems: Vec<String> = plan
                .iter()
                .filter(|e| matches!(e.status, Status::Collision | Status::Invalid))
                .map(|e| format!("{}: {:?} {}", rel(root, &e.src), e.status, e.message))
                .collect();
            let ok_count = details.len();
            details.extend(problems.iter().map(|p| format!("! {p}")));
            if !dry && ok_count > 0 {
                let history = RenameHistory::new(root);
                execute_plan(&plan, Some(&history)).map_err(|e| format!("Rename failed and was rolled back: {e}"))?;
            }
            Ok((format!("{} {ok_count} of {} file(s), {} conflict(s) left as they are", verb("Renamed", "Would rename"), paths.len(), problems.len()), details, problems.len()))
        }
        RecipeStep::FbxFix { options } => {
            let opts = FixOptions { dry_run: options.dry_run || dry, ..options.clone() };
            let fbx = files(root, &["fbx"]);
            let results: Vec<_> = fbx.par_iter().map(|p| (p, fix_fbx(p, &opts))).collect();
            let (mut changed, mut paths, mut details, mut failed) = (0, 0, Vec::new(), Vec::new());
            for (p, r) in results {
                match r {
                    Ok(rep) => {
                        if !rep.changes.is_empty() {
                            changed += 1;
                            paths += rep.changes.len();
                            details.push(format!("{}: {} path(s)", rel(root, p), rep.changes.len()));
                        }
                        details.extend(rep.warnings.iter().map(|w| format!("{}: {w}", rel(root, p))));
                    }
                    Err(e) => failed.push(format!("! {}: {e}", rel(root, p))),
                }
            }
            details.extend(failed.iter().cloned());
            let summary = format!("{} {paths} path(s) in {changed} of {} FBX file(s), {} unreadable", verb("Rewrote", "Would rewrite"), fbx.len(), failed.len());
            Ok((summary, details, failed.len()))
        }
        RecipeStep::PackOrm { format, overwrite } => {
            let ext = if *format == OrmFormat::Tga { "tga" } else { "png" };
            let sets = find_texture_sets(root).sets;
            let mut configs = Vec::new();
            let mut details = Vec::new();
            for s in sets.iter().filter(|s| s.can_pack_orm) {
                let out = s.suggested_orm.with_extension(ext);
                if out.exists() && !overwrite {
                    details.push(format!("{}: exists, kept", rel(root, &out)));
                    continue;
                }
                let (roughness_path, gloss) = s.roughness_input().map_or((None, false), |(p, g)| (Some(p.clone()), g));
                configs.push(OrmPackConfig {
                    roughness_path,
                    roughness_from_gloss: gloss,
                    metallic_path: s.maps.get(&MapKind::Metallic).cloned(),
                    ao_path: s.maps.get(&MapKind::Ao).cloned(),
                    output_path: out,
                    format: *format,
                });
            }
            let mut failed = 0;
            if dry {
                details.extend(configs.iter().map(|c| format!("{}: would pack", rel(root, &c.output_path))));
            } else {
                for (c, r) in configs.par_iter().map(|c| (c, pack_orm(c))).collect::<Vec<_>>() {
                    match r {
                        Ok(_) => details.push(format!("{}: packed", rel(root, &c.output_path))),
                        Err(e) => {
                            failed += 1;
                            details.push(format!("! {}: {e}", rel(root, &c.output_path)));
                        }
                    }
                }
            }
            let summary = format!("{} {} ORM texture(s) from {} texture set(s)", verb("Packed", "Would pack"), configs.len() - failed, sets.len());
            Ok((with_failed(summary, failed), details, failed))
        }
        RecipeStep::ConvertTextures { options, extensions, name_contains } => {
            let opts = ConvertOptions { dry_run: options.dry_run || dry, ..options.clone() };
            let exts: Vec<&str> = if extensions.is_empty() { TEXTURE_EXTS.to_vec() } else { extensions.iter().map(String::as_str).collect() };
            // Earlier outputs live in the (relative) output folder: never convert them again.
            let out_name = (!opts.output_dir.is_absolute()).then(|| opts.output_dir.file_name().map(|n| n.to_os_string())).flatten();
            let needle = name_contains.to_lowercase();
            let sources: Vec<PathBuf> = files(root, &exts)
                .into_iter()
                .filter(|p| out_name.is_none() || p.parent().and_then(|d| d.file_name()) != out_name.as_deref())
                .filter(|p| needle.is_empty() || p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().contains(&needle)))
                .collect();
            let items = convert_textures(&sources, &opts);
            let done = items.iter().filter(|i| i.written || (opts.dry_run && i.error.is_none() && i.skipped.is_none())).count();
            let failed = items.iter().filter(|i| i.error.is_some()).count();
            let skipped = items.iter().filter(|i| i.skipped.is_some()).count();
            let details = items
                .iter()
                .map(|i| {
                    let target = i.output.as_deref().map(|o| rel(root, o)).unwrap_or_default();
                    match (&i.error, &i.skipped, i.to_size) {
                        (Some(e), _, _) => format!("! {}: {e}", rel(root, &i.source)),
                        (_, Some(s), _) => format!("{}: skipped, {s}", rel(root, &i.source)),
                        (_, _, Some((w, h))) => format!("{} -> {target} ({w}x{h})", rel(root, &i.source)),
                        _ => rel(root, &i.source),
                    }
                })
                .collect();
            let summary = format!("{} {done} texture(s), skipped {skipped}", verb("Converted", "Would convert"));
            Ok((with_failed(summary, failed), details, failed))
        }
        RecipeStep::InspectMeshes { tri_budget } => {
            let stats = inspect_meshes(&files(root, MESH_EXTS), *tri_budget);
            let tris: u64 = stats.iter().map(|s| s.triangles).sum();
            let mut details = Vec::new();
            for s in &stats {
                let name = rel(root, &s.path);
                match &s.error {
                    Some(e) => details.push(format!("! {name}: {e}")),
                    None => {
                        details.push(format!("{name}: {} tris, {} verts, {} UV set(s), {} material(s)", s.triangles, s.vertices, s.uv_sets, s.materials));
                        details.extend(s.warnings.iter().map(|w| format!("! {name}: {w}")));
                    }
                }
            }
            let flagged = stats.iter().filter(|s| !s.warnings.is_empty() || s.error.is_some()).count();
            Ok((format!("{} mesh file(s), {tris} triangles, {flagged} with warnings", stats.len()), details, flagged))
        }
        RecipeStep::FindUnused { include_blend } => {
            let reader = if *include_blend { Some(env.blend_reader.ok_or("Blender 5.0+ is needed to read .blend files")?) } else { None };
            let rep = find_unused_textures_with(root, reader);
            let mut details: Vec<String> = rep.textures.iter().map(|t| rel(root, &t.path)).collect();
            details.extend(rep.warnings.iter().map(|w| format!("! {w}")));
            let mb = rep.reclaimable_bytes as f64 / 1_048_576.0;
            Ok((format!("{} of {} texture(s) unreferenced ({mb:.1} MB)", rep.textures.len(), rep.total_textures), details, rep.warnings.len()))
        }
        RecipeStep::FindDuplicates {} => {
            let all = scan(root, &normalize_exts::<&str>(&[]), true, None).files;
            let rep = find_duplicates(&all, None);
            let details = rep
                .groups
                .iter()
                .map(|g| format!("{} copies: {}", g.files.len(), g.files.iter().map(|f| rel(root, Path::new(f))).collect::<Vec<_>>().join(", ")))
                .collect();
            let mb = rep.wasted_bytes as f64 / 1_048_576.0;
            Ok((format!("{} duplicate group(s), {mb:.1} MB reclaimable", rep.groups.len()), details, 0))
        }
    }
}

fn with_failed(summary: String, failed: usize) -> String {
    if failed > 0 { format!("{summary}, {failed} failed") } else { summary }
}

pub fn run_recipe(recipe: &Recipe, root: &Path, dry_run: bool, env: &mut RecipeEnv) -> RecipeRun {
    let started = Instant::now();
    let total = recipe.steps.len();
    let mut steps = Vec::with_capacity(total);
    let mut failed = false;
    for (i, step) in recipe.steps.iter().enumerate() {
        let mut outcome = StepOutcome { kind: step.kind(), title: step.title(), ok: false, skipped: failed, summary: String::new(), details: Vec::new(), problems: 0, elapsed_ms: 0 };
        if failed {
            outcome.summary = "Not run: an earlier step failed".into();
            steps.push(outcome);
            continue;
        }
        (env.on_step)(i, total, step.title());
        let t = Instant::now();
        match run_step(step, root, dry_run, env) {
            Ok((summary, mut details, problems)) => {
                outcome.ok = true;
                outcome.summary = summary;
                outcome.problems = problems;
                if details.len() > MAX_DETAILS {
                    let more = details.len() - MAX_DETAILS;
                    details.truncate(MAX_DETAILS);
                    details.push(format!("… {more} more"));
                }
                outcome.details = details;
            }
            Err(e) => {
                failed = true;
                outcome.summary = e;
            }
        }
        outcome.elapsed_ms = t.elapsed().as_millis() as u64;
        steps.push(outcome);
    }
    RecipeRun { name: recipe.name.clone(), folder: root.to_path_buf(), dry_run, ok: !failed, steps, elapsed_ms: started.elapsed().as_millis() as u64 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GrayImage;

    fn recipe(json: serde_json::Value) -> Recipe {
        Recipe::from_json(&json.to_string()).unwrap()
    }

    /// Run without a Blender reader, recording `i/n title` progress lines.
    fn run(r: &Recipe, root: &Path, dry: bool) -> (RecipeRun, Vec<String>) {
        let mut log = Vec::new();
        let mut on_step = |i: usize, n: usize, t: &str| log.push(format!("{}/{n} {t}", i + 1));
        let res = run_recipe(r, root, dry, &mut RecipeEnv { blend_reader: None, on_step: &mut on_step });
        (res, log)
    }

    #[test]
    fn parse_and_validate() {
        let r = recipe(serde_json::json!({
            "name": "UE5 prep",
            "steps": [
                { "kind": "rename", "rules": [{ "kind": "preset", "preset": "ue5" }] },
                { "kind": "fbxFix", "options": { "mode": "collect" } },
                { "kind": "packOrm" },
                { "kind": "convertTextures", "options": { "maxSize": 2048, "format": "tga" }, "nameContains": "_N" },
                { "kind": "inspectMeshes", "triBudget": 50000 },
                { "kind": "findUnused", "includeBlend": true },
                { "kind": "findDuplicates" }
            ]
        }));
        assert_eq!(r.steps.len(), 7);
        assert!(matches!(&r.steps[0], RecipeStep::Rename { recursive: true, .. }));
        assert!(matches!(&r.steps[2], RecipeStep::PackOrm { format: OrmFormat::Png, overwrite: false }));
        assert!(Recipe::from_json(r#"{"steps":[]}"#).is_err());
        let bad = r#"{"steps":[{"kind":"rename","rules":[{"kind":"searchReplace","find":"(","regex":true}]}]}"#;
        assert!(Recipe::from_json(bad).unwrap_err().contains("Step 1"));
        assert!(Recipe::from_json(r#"{"steps":[{"kind":"explode"}]}"#).is_err());
    }

    #[test]
    fn dry_run_changes_nothing_then_live_run_applies() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        GrayImage::from_pixel(4, 4, image::Luma([90])).save(root.join("wood_roughness.png")).unwrap();
        GrayImage::from_pixel(4, 4, image::Luma([20])).save(root.join("wood_ao.png")).unwrap();
        GrayImage::from_pixel(8, 8, image::Luma([20])).save(root.join("wood_basecolor.png")).unwrap();
        let r = recipe(serde_json::json!({
            "name": "t",
            "steps": [
                { "kind": "packOrm" },
                { "kind": "convertTextures", "options": { "maxSize": 2 }, "nameContains": "basecolor" },
                { "kind": "findDuplicates" }
            ]
        }));

        let (dry, log) = run(&r, root, true);
        assert!(dry.ok, "{dry:?}");
        assert!(dry.steps[0].summary.starts_with("Would pack 1"), "{}", dry.steps[0].summary);
        assert!(dry.steps[1].summary.starts_with("Would convert 1"), "{}", dry.steps[1].summary);
        assert!(!root.join("T_Wood_ORM.png").exists() && !root.join("converted").exists());
        assert_eq!(log, ["1/3 Pack ORM textures", "2/3 Convert textures", "3/3 Find duplicates"]);

        let (live, _) = run(&r, root, false);
        assert!(live.ok, "{live:?}");
        assert_eq!(image::open(root.join("T_Wood_ORM.png")).unwrap().to_rgb8().get_pixel(0, 0).0, [20, 90, 0]);
        assert_eq!(image::open(root.join("converted/wood_basecolor.png")).unwrap().width(), 2);

        assert_eq!(live.steps[1].problems, 0);

        // Second run: ORM exists (kept), converted output is not converted again.
        let (again, _) = run(&r, root, false);
        assert!(again.steps[0].summary.starts_with("Packed 0"), "{}", again.steps[0].summary);
        assert!(again.steps[1].summary.contains("skipped 1"), "{}", again.steps[1].summary);
    }

    #[test]
    fn broken_file_is_a_problem_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("broken_basecolor.png"), b"not a png").unwrap();
        GrayImage::from_pixel(4, 4, image::Luma([1])).save(dir.path().join("ok_basecolor.png")).unwrap();
        let r = recipe(serde_json::json!({ "steps": [{ "kind": "convertTextures" }, { "kind": "findDuplicates" }] }));
        let (res, _) = run(&r, dir.path(), false);
        assert!(res.ok, "{res:?}");
        assert_eq!(res.steps[0].problems, 1);
        assert!(res.steps[0].summary.ends_with("1 failed"), "{}", res.steps[0].summary);
        assert!(res.steps[0].details.iter().any(|d| d.starts_with("! broken_basecolor.png")));
        assert!(res.steps[1].ok && !res.steps[1].skipped);
    }

    #[test]
    fn failure_stops_later_steps() {
        let dir = tempfile::tempdir().unwrap();
        let r = recipe(serde_json::json!({ "steps": [{ "kind": "findUnused", "includeBlend": true }, { "kind": "findDuplicates" }] }));
        let (res, log) = run(&r, dir.path(), true);
        assert!(!res.ok);
        assert!(!res.steps[0].ok && res.steps[0].summary.contains("Blender"));
        assert!(res.steps[1].skipped && !res.steps[1].ok);
        assert_eq!(log.len(), 1, "skipped steps report no progress");
    }
}
