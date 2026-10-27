//! Asset matching: which texture set goes with which mesh (and material slot), with a
//! confidence score and the reasons behind it.
//!
//! Evidence, strongest first:
//! 1. the mesh file references one of the set's textures (FBX / MTL / glTF paths); a path that
//!    resolves to the very file scores 100, a file name match is narrowed down by its folders,
//! 2. a material slot name matches the set name (`M_Wall_Corner` ~ `T_Wall_Corner_*`),
//! 3. the mesh file name matches the set name (`SM_Wall_Corner_01` ~ `Wall_Corner`),
//! 4. folder proximity adds or removes a few points.
//!
//! When two sets score about the same the slot is marked for review instead of guessing.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use super::mesh_stats::inspect_mesh;
use super::renamer::split_words;
use super::scanner::{normalize_exts, scan};
use super::texture_sets::{group_texture_sets, TextureSet};
use super::usage::{base_lower, mesh_texture_paths};
use crate::utils::paths::{MESH_EXTS, TEXTURE_EXTS};

/// Naming-convention prefixes that say what an asset is, not which one.
const TYPE_PREFIXES: &[&str] = &["sm", "sk", "s", "m", "mi", "mat", "mtl", "t", "tx", "tex", "mesh", "geo", "skm"];
/// Words that carry no identity at the end of a name.
const NOISE_SUFFIXES: &[&str] = &["mat", "mtl", "material", "mesh", "geo", "low", "high", "lp", "hp"];
/// Default material names exporters invent; they say nothing about the texture.
const GENERIC_MATERIALS: &[&str] = &["material", "lambert", "blinn", "phong", "default", "standard", "standardsurface", "surface", "defaultmaterial", "none", "aistandardsurface", "wire"];

const MAX_CANDIDATES: usize = 5;
/// Scores below this are not offered as candidates.
const MIN_SCORE: u8 = 30;
/// A best match needs this lead over the runner-up to be called "likely".
const MIN_MARGIN: u8 = 12;
/// Name evidence alone never reaches the score of a file reference.
const MAX_NAME_SCORE: f64 = 95.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchStatus {
    /// The mesh file itself references the set.
    Exact,
    /// Clear winner by name.
    Likely,
    /// Close call or weak evidence: a person should pick.
    Review,
    /// Nothing scored high enough.
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Index into `MatchReport::sets`.
    pub set: usize,
    pub score: u8,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotMatch {
    /// Material name, or the mesh name when the file has no materials.
    pub name: String,
    pub is_material: bool,
    /// Best first.
    pub candidates: Vec<Candidate>,
    pub status: MatchStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshMatch {
    pub path: PathBuf,
    /// Texture paths as written in the mesh file.
    pub references: Vec<String>,
    /// References whose file name is nowhere under the folder.
    pub missing_references: Vec<String>,
    pub slots: Vec<SlotMatch>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchReport {
    pub root: PathBuf,
    pub meshes: Vec<MeshMatch>,
    pub sets: Vec<TextureSet>,
    /// Indices of sets no slot picked as its best match.
    pub orphan_sets: Vec<usize>,
    /// Textures without a recognisable map suffix (not grouped into sets).
    pub loose_textures: Vec<PathBuf>,
    pub elapsed_ms: u64,
}

/// Identity words of an asset name: lower case, type prefix and noise suffixes removed.
pub fn name_tokens(name: &str) -> Vec<String> {
    let mut w: Vec<String> = split_words(name).into_iter().map(|w| w.to_lowercase()).collect();
    if w.len() > 1 && TYPE_PREFIXES.contains(&w[0].as_str()) {
        w.remove(0);
    }
    while w.len() > 1 {
        let n = w.len();
        // `split_words` splits `LOD0` into `lod`, `0`.
        if n > 2 && w[n - 2] == "lod" && is_number(&w[n - 1]) {
            w.truncate(n - 2);
        } else if w[n - 1] == "lod" || NOISE_SUFFIXES.contains(&w[n - 1].as_str()) {
            w.pop();
        } else {
            break;
        }
    }
    w
}

fn is_number(w: &str) -> bool {
    !w.is_empty() && w.chars().all(|c| c.is_ascii_digit())
}

/// 0..=1 similarity of two token lists, with the reason it matched.
fn similarity(a: &[String], b: &[String]) -> (f64, &'static str) {
    if a.is_empty() || b.is_empty() {
        return (0.0, "");
    }
    if a == b {
        return (1.0, "same name");
    }
    let words = |t: &[String]| t.iter().filter(|w| !is_number(w)).cloned().collect::<Vec<_>>();
    let (wa, wb) = (words(a), words(b));
    if !wa.is_empty() && wa == wb {
        return (0.85, "same name, different number");
    }
    let sa: HashSet<&String> = wa.iter().collect();
    let sb: HashSet<&String> = wb.iter().collect();
    let inter = sa.intersection(&sb).count() as f64;
    if inter == 0.0 {
        return (0.0, "");
    }
    let union = sa.union(&sb).count() as f64;
    let contained = inter / sa.len().min(sb.len()) as f64;
    let score = 0.4 * (inter / union) + 0.4 * contained;
    (score, if contained >= 1.0 { "name contains the other" } else { "shares name words" })
}

fn is_generic_material(name: &str) -> bool {
    let key: String = name.to_lowercase().chars().filter(|c| c.is_ascii_alphabetic()).collect();
    key.is_empty() || GENERIC_MATERIALS.contains(&key.as_str())
}

/// +6 same folder, +3 related (one contains the other, or siblings), -10 unrelated.
fn folder_bonus(mesh_dir: &Path, set_dir: &Path) -> (f64, &'static str) {
    if mesh_dir == set_dir {
        (6.0, "same folder")
    } else if set_dir.starts_with(mesh_dir) || mesh_dir.starts_with(set_dir) || mesh_dir.parent() == set_dir.parent() {
        (3.0, "nearby folder")
    } else {
        (-10.0, "different folder")
    }
}

/// Lower-case path components, either separator.
fn components(p: &str) -> Vec<String> {
    p.split(['\\', '/']).filter(|c| !c.is_empty() && *c != ".").map(str::to_lowercase).collect()
}

/// Folders above the file name that a stored path and a real file have in common, counted from the file up.
fn shared_parents(stored: &[String], file: &Path) -> usize {
    let real = components(&file.to_string_lossy());
    stored.iter().rev().skip(1).zip(real.iter().rev().skip(1)).take_while(|(a, b)| a == b).count()
}

/// A texture path stored in a mesh file.
struct Reference {
    raw: String,
    base: String,
    parts: Vec<String>,
    /// Where it points when read as absolute, or relative to the mesh folder (only if that file exists).
    resolved: Option<PathBuf>,
}

struct SetInfo {
    tokens: Vec<String>,
    /// Lower-case file name -> file, for every map of the set.
    files: HashMap<String, PathBuf>,
}

/// What one mesh file tells about all of its slots.
struct MeshCtx<'a> {
    tokens: Vec<String>,
    dir: &'a Path,
    refs: Vec<Reference>,
    /// Sets with at least one texture the file references.
    referenced_sets: usize,
    single_slot: bool,
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Score of a set the mesh file references: 100 when a stored path points at one of its files,
/// otherwise by how many folders the stored path shares with the file, and by folder proximity.
fn reference_score(mesh: &MeshCtx, set: &TextureSet, info: &SetInfo) -> Option<(f64, String)> {
    let mut best: Option<(f64, String)> = None;
    for r in &mesh.refs {
        let Some(file) = info.files.get(&r.base) else { continue };
        let (score, why) = if r.resolved.as_deref().is_some_and(|p| same_file(p, file)) {
            (100.0, format!("mesh file points at it ({})", r.raw))
        } else {
            let shared = shared_parents(&r.parts, file).min(2);
            let (bonus, _) = folder_bonus(mesh.dir, &set.dir);
            let detail = if shared > 0 { format!(", {shared} folder name(s) agree") } else { String::new() };
            ((88.0 + 3.0 * shared as f64 + bonus).min(99.0), format!("mesh file names it ({}{detail})", r.raw))
        };
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, why));
        }
    }
    best
}

fn score_slot(slot_tokens: Option<&[String]>, mesh: &MeshCtx, set: &TextureSet, info: &SetInfo) -> Option<(u8, Vec<String>)> {
    let mut reasons = Vec::new();
    let (slot_sim, slot_why) = slot_tokens.map_or((0.0, ""), |t| similarity(t, &info.tokens));
    let (mesh_sim, mesh_why) = similarity(&mesh.tokens, &info.tokens);

    if let Some((mut score, why)) = reference_score(mesh, set, info) {
        reasons.push(why);
        // With several materials and several referenced sets, the file alone does not say which slot gets which.
        if !(mesh.single_slot || mesh.referenced_sets == 1 || slot_sim >= 0.5) {
            score -= 25.0 * (1.0 - slot_sim);
            reasons.push("several materials: slot not certain".into());
        }
        if slot_sim > 0.0 {
            reasons.push(format!("material: {slot_why}"));
        }
        return Some((score.round() as u8, reasons));
    }

    let mut score = 0.0f64;
    if slot_sim > 0.0 {
        score = slot_sim * 80.0;
        reasons.push(format!("material: {slot_why}"));
    }
    if mesh_sim > 0.0 {
        score = score.max(mesh_sim * 70.0);
        reasons.push(format!("mesh name: {mesh_why}"));
    }
    if score <= 0.0 {
        return None;
    }
    if slot_sim >= 0.5 && mesh_sim >= 0.5 {
        score += 6.0;
    }
    let (bonus, why) = folder_bonus(mesh.dir, &set.dir);
    score += bonus;
    reasons.push(why.to_string());
    let score = score.clamp(0.0, MAX_NAME_SCORE).round() as u8;
    (score >= MIN_SCORE).then_some((score, reasons))
}

fn status_of(candidates: &[Candidate], referenced: bool) -> MatchStatus {
    match candidates {
        [] => MatchStatus::None,
        [best, rest @ ..] => {
            let margin = best.score.saturating_sub(rest.first().map_or(0, |c| c.score));
            if referenced && best.score >= 90 && margin > 0 {
                MatchStatus::Exact
            } else if best.score >= 60 && margin >= MIN_MARGIN {
                MatchStatus::Likely
            } else {
                MatchStatus::Review
            }
        }
    }
}

fn match_mesh(path: &Path, sets: &[TextureSet], infos: &[SetInfo], texture_names: &HashSet<String>) -> MeshMatch {
    let stats = inspect_mesh(path, None);
    let (mut raw, error) = match mesh_texture_paths(path) {
        Ok(r) => (r, stats.error.clone()),
        Err(e) => (Vec::new(), Some(e)),
    };
    raw.sort();
    raw.dedup();
    let dir = path.parent().unwrap_or(Path::new(""));
    let refs: Vec<Reference> = raw
        .iter()
        .map(|r| {
            let p = Path::new(r.trim());
            let resolved = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
            Reference { raw: r.clone(), base: base_lower(r), parts: components(r), resolved: Some(resolved).filter(|p| p.is_file()) }
        })
        .collect();
    let missing_references = refs.iter().filter(|r| !texture_names.contains(&r.base)).map(|r| r.raw.clone()).collect();
    let referenced_sets = infos.iter().filter(|i| refs.iter().any(|r| i.files.contains_key(&r.base))).count();

    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let slots_src: Vec<(String, bool)> = if stats.material_names.is_empty() { vec![(stem.clone(), false)] } else { stats.material_names.iter().map(|m| (m.clone(), true)).collect() };
    let ctx = MeshCtx { tokens: name_tokens(&stem), dir, refs, referenced_sets, single_slot: slots_src.len() == 1 };

    let slots = slots_src
        .into_iter()
        .map(|(name, is_material)| {
            let tokens = (is_material && !is_generic_material(&name)).then(|| name_tokens(&name));
            let mut candidates: Vec<Candidate> = sets
                .iter()
                .zip(infos)
                .enumerate()
                .filter_map(|(i, (set, info))| score_slot(tokens.as_deref(), &ctx, set, info).map(|(score, reasons)| Candidate { set: i, score, reasons }))
                .collect();
            candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| sets[a.set].name.cmp(&sets[b.set].name)));
            candidates.truncate(MAX_CANDIDATES);
            let referenced = candidates.first().is_some_and(|c| ctx.refs.iter().any(|r| infos[c.set].files.contains_key(&r.base)));
            let status = status_of(&candidates, referenced);
            SlotMatch { name, is_material, candidates, status }
        })
        .collect();

    MeshMatch { path: path.to_path_buf(), references: raw, missing_references, slots, error }
}

/// Match every mesh under `root` (recursively) against the texture sets under `root`.
pub fn match_assets(root: &Path) -> MatchReport {
    let start = Instant::now();
    let textures: Vec<PathBuf> = scan(root, &normalize_exts(TEXTURE_EXTS), true, None).files.into_iter().map(|f| f.path).collect();
    let texture_names: HashSet<String> = textures.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().to_lowercase()).collect();
    let grouped = group_texture_sets(&textures);
    let infos: Vec<SetInfo> = grouped
        .sets
        .iter()
        .map(|s| SetInfo {
            tokens: name_tokens(&s.name),
            files: s.maps.values().chain(&s.extra).filter_map(|p| Some((p.file_name()?.to_string_lossy().to_lowercase(), p.clone()))).collect(),
        })
        .collect();

    let mut mesh_paths: Vec<PathBuf> = scan(root, &normalize_exts(MESH_EXTS), true, None).files.into_iter().map(|f| f.path).collect();
    mesh_paths.sort();
    let meshes: Vec<MeshMatch> = mesh_paths.par_iter().map(|p| match_mesh(p, &grouped.sets, &infos, &texture_names)).collect();

    let picked: HashSet<usize> = meshes.iter().flat_map(|m| &m.slots).filter_map(|s| s.candidates.first()).map(|c| c.set).collect();
    let orphan_sets = (0..grouped.sets.len()).filter(|i| !picked.contains(i)).collect();
    MatchReport {
        root: root.to_path_buf(),
        meshes,
        sets: grouped.sets,
        orphan_sets,
        loose_textures: grouped.unmatched,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fbx::test_support::build_binary_fbx;
    use std::fs;

    fn toks(s: &str) -> Vec<String> {
        name_tokens(s)
    }

    fn relative(p: &Path, root: &Path) -> String {
        p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn tokens_drop_prefixes_and_noise() {
        assert_eq!(toks("SM_Wall_Corner_01_LOD0"), ["wall", "corner", "01"]);
        assert_eq!(toks("M_WallCorner_Mat"), ["wall", "corner"]);
        assert_eq!(toks("T_Rock"), ["rock"]);
        assert_eq!(toks("SM"), ["sm"], "a lone prefix is kept");
    }

    #[test]
    fn similarity_levels() {
        let s = |a: &str, b: &str| similarity(&toks(a), &toks(b)).0;
        assert_eq!(s("SM_Wall_01", "T_Wall_01"), 1.0);
        assert_eq!(s("SM_Wall_02", "Wall_01"), 0.85);
        assert!(s("SM_Wall_Corner_Broken", "Wall_Corner") > 0.6);
        assert!(s("SM_Wall_Corner", "Floor_Tile") == 0.0);
        assert!(is_generic_material("Material.001") && is_generic_material("lambert1") && !is_generic_material("M_Brick"));
    }

    #[test]
    fn stored_paths_share_folders() {
        let parts = components(r"D:\Artist\Wall\Textures\T_Wall_D.png");
        assert_eq!(shared_parents(&parts, Path::new("/drive/Wall/Textures/T_Wall_D.png")), 2);
        assert_eq!(shared_parents(&parts, Path::new("/drive/Old/T_Wall_D.png")), 0);
    }

    #[test]
    fn matches_by_reference_material_and_name() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        let w = |n: &str, d: &[u8]| {
            let p = r.join(n);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, d).unwrap();
        };
        for t in [
            "Textures/T_Crate_BaseColor.png", "Textures/T_Crate_Normal.png",
            "Textures/T_Wall_Corner_BaseColor.png", "Textures/T_Wall_Corner_N.png",
            "Textures/T_Brick_D.png", "Textures/T_Brick_N.png",
            "Textures/T_Floor_A_D.png", "Textures/T_Floor_B_D.png",
            "Textures/T_Unused_D.png", "Textures/noise.png",
            // Same file name in a second, unrelated folder.
            "Old/Backup/T_Crate_BaseColor.png",
        ] {
            w(t, b"px");
        }
        fs::create_dir_all(r.join("Meshes")).unwrap();
        // 1. An absolute path from the artist's machine: the file name and its folder decide.
        build_binary_fbx(&r.join("Meshes/SM_Box.fbx"), r"D:\artist\Textures\T_Crate_BaseColor.png", 7400, b"");
        // 2. Material slot names in an OBJ (one generic), plus an MTL that references nothing on disk.
        w("Meshes/SM_Thing.obj", b"mtllib thing.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nusemtl M_Brick\nf 1 2 3\nusemtl Material.001\nf 1 2 3\n");
        w("Meshes/thing.mtl", b"newmtl M_Brick\nmap_Kd gone.png\n");
        // 3. Name only.
        w("Meshes/SM_Wall_Corner_01.obj", b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
        // 4. Ambiguous: two floor variants.
        w("Meshes/SM_Floor.obj", b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
        // 5. A relative path that resolves to the file.
        w("Meshes/SM_Tile.obj", b"mtllib tile.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
        w("Meshes/tile.mtl", b"newmtl x\nmap_Kd ../Textures/T_Floor_B_D.png\n");

        let rep = match_assets(r);
        assert_eq!(rep.meshes.len(), 5);
        assert_eq!(rep.loose_textures.len(), 1);
        let mesh = |n: &str| rep.meshes.iter().find(|m| m.path.ends_with(n)).unwrap();
        let best = |s: &SlotMatch| rep.sets[s.candidates[0].set].clone();

        let boxm = mesh("SM_Box.fbx");
        assert_eq!(boxm.references, [r"D:\artist\Textures\T_Crate_BaseColor.png"]);
        let slot = &boxm.slots[0];
        assert_eq!((relative(&best(slot).dir, r), slot.status), ("Textures".to_string(), MatchStatus::Exact));
        assert!(slot.candidates[0].score > slot.candidates[1].score, "the Textures copy beats Old/Backup");

        let tile = &mesh("SM_Tile.obj").slots[0];
        assert_eq!((best(tile).name.as_str(), tile.candidates[0].score, tile.status), ("Floor_B", 100, MatchStatus::Exact));

        let thing = mesh("SM_Thing.obj");
        assert_eq!(thing.missing_references, ["gone.png"]);
        assert_eq!(thing.slots.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["M_Brick", "Material.001"]);
        assert_eq!((best(&thing.slots[0]).name.as_str(), thing.slots[0].status), ("Brick", MatchStatus::Likely));
        assert_eq!(thing.slots[1].status, MatchStatus::None, "generic material and an unrelated mesh name");

        let wall = &mesh("SM_Wall_Corner_01.obj").slots[0];
        assert_eq!((best(wall).name.as_str(), wall.status), ("Wall_Corner", MatchStatus::Likely));
        assert!(wall.candidates[0].reasons.iter().any(|r| r.contains("nearby folder")));

        let floor = &mesh("SM_Floor.obj").slots[0];
        assert_eq!(floor.status, MatchStatus::Review, "Floor_A vs Floor_B is a coin toss");
        assert_eq!(floor.candidates.len(), 2);

        let mut orphans: Vec<String> = rep.orphan_sets.iter().map(|&i| format!("{}/{}", relative(&rep.sets[i].dir, r), rep.sets[i].name)).collect();
        orphans.sort();
        assert_eq!(orphans, ["Old/Backup/Crate", "Textures/Unused"]);
    }

    #[test]
    #[ignore = "prints the matches for sample-assets"]
    fn probe_samples() {
        let rep = match_assets(&Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("sample-assets"));
        for m in &rep.meshes {
            println!("{} refs={:?} missing={:?} err={:?}", relative(&m.path, &rep.root), m.references, m.missing_references, m.error);
            for s in &m.slots {
                let c: Vec<_> = s.candidates.iter().map(|c| (relative(&rep.sets[c.set].dir, &rep.root), c.score, c.reasons.join("; "))).collect();
                println!("   [{:?}] {} -> {c:?}", s.status, s.name);
            }
        }
    }
}
