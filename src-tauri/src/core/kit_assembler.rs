//! Kit assembly: copy the meshes and texture sets of an asset manifest (Asset Matcher output)
//! into a clean project layout (`Meshes/`, `Textures/`), renamed to a convention, with ORM maps
//! packed and the texture paths inside each copied mesh pointed at the copied textures.
//!
//! The delivery folder is only read. Existing files in the destination are kept unless
//! `overwrite` is set; a dry run plans everything and writes nothing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::fbx::doctor::relink_fbx;
use super::image_ops::{pack_orm, OrmFormat, OrmPackConfig};
use super::renamer::split_words;
use super::texture_sets::MapKind;
use super::usage::{base_lower, mesh_texture_paths, percent_decode, MTL_MAP_RE};
use crate::utils::paths::{absolute, ext_lower, relpath_portable};

// ---------------------------------------------------------------- manifest (asset_manifest.json)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSet {
    pub name: String,
    /// Relative to the manifest root.
    #[serde(default)]
    pub folder: String,
    /// Map type -> file, relative to the manifest root.
    pub maps: BTreeMap<MapKind, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSlot {
    pub slot: String,
    #[serde(default)]
    pub texture_set: Option<ManifestSet>,
    /// `auto`, `manual` or `open` (still needs a decision).
    #[serde(default)]
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestAsset {
    /// Relative to the manifest root.
    pub mesh: String,
    pub slots: Vec<ManifestSlot>,
}

/// The parts of `asset_manifest.json` the assembler needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifest {
    pub root: PathBuf,
    pub assets: Vec<ManifestAsset>,
}

impl AssetManifest {
    pub fn load(path: &Path) -> Result<AssetManifest, String> {
        let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("Not an asset manifest: {e}"))
    }
}

// ---------------------------------------------------------------- options & report

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Naming {
    /// Original file names.
    Keep,
    /// `SM_Wall_Corner_01.fbx`, `T_Wall_Corner_D.png`, `T_Wall_Corner_ORM.png`.
    #[default]
    Ue5,
    /// `WallCorner01.fbx`, `WallCorner_BaseColor.png`.
    Unity,
}

fn default_mesh_dir() -> String {
    "Meshes".into()
}
fn default_texture_dir() -> String {
    "Textures".into()
}
const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitOptions {
    pub dest: PathBuf,
    #[serde(default)]
    pub naming: Naming,
    #[serde(default = "default_mesh_dir")]
    pub mesh_dir: String,
    #[serde(default = "default_texture_dir")]
    pub texture_dir: String,
    /// Keep the delivery's top folder as a package: `<dest>/Wall Modular/Meshes/…`.
    #[serde(default)]
    pub keep_packages: bool,
    /// Pack roughness / gloss / metallic / AO into one ORM map (the inputs are then not copied).
    #[serde(default = "yes")]
    pub pack_orm: bool,
    /// Point the texture paths inside copied meshes at the copied textures.
    #[serde(default = "yes")]
    pub relink: bool,
    /// Also take slots whose match still needs a decision.
    #[serde(default)]
    pub include_open: bool,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KitKind {
    Mesh,
    Texture,
    Orm,
    /// MTL, glTF buffer.
    Sidecar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KitStatus {
    /// Dry run: would be written.
    Planned,
    Written,
    /// The target exists and `overwrite` is off.
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitItem {
    pub kind: KitKind,
    pub sources: Vec<PathBuf>,
    pub target: PathBuf,
    pub status: KitStatus,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitReport {
    pub dest: PathBuf,
    pub items: Vec<KitItem>,
    /// Texture paths rewritten inside copied meshes.
    pub relinked: usize,
    /// `mesh / slot: why` for slots left out.
    pub skipped_slots: Vec<String>,
    pub warnings: Vec<String>,
    pub bytes_written: u64,
    /// `kit_manifest.json` in the destination (not on a dry run).
    pub kit_manifest: Option<PathBuf>,
    pub dry_run: bool,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------- naming

const GENERIC_DIRS: &[&str] = &["meshes", "mesh", "models", "model", "fbx", "obj", "geo", "geometry", "export", "exports", "textures", "texture", "tex", "maps"];
const MESH_PREFIXES: &[&str] = &["sm", "sk", "skm", "s", "mesh", "geo"];
const PACKED: &[MapKind] = &[MapKind::Roughness, MapKind::Gloss, MapKind::Metallic, MapKind::Ao];

fn cap(w: &str) -> String {
    let mut c = w.chars();
    c.next().map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
}

/// `wood planks 01` -> (`Wood_Planks_01`, `WoodPlanks01`).
fn styled(words: &[String]) -> (String, String) {
    let caps: Vec<String> = words.iter().map(|w| cap(w)).collect();
    (caps.join("_"), caps.concat())
}

fn ue5_suffix(k: MapKind) -> &'static str {
    match k {
        MapKind::BaseColor => "D",
        MapKind::Normal => "N",
        MapKind::Orm => "ORM",
        MapKind::Roughness => "R",
        MapKind::Gloss => "G",
        MapKind::Metallic => "M",
        MapKind::Ao => "AO",
        MapKind::Emissive => "E",
        MapKind::Height => "H",
        MapKind::Opacity => "A",
        MapKind::Specular => "S",
    }
}

fn unity_suffix(k: MapKind) -> &'static str {
    match k {
        MapKind::BaseColor => "BaseColor",
        MapKind::Normal => "Normal",
        MapKind::Orm => "ORM",
        MapKind::Roughness => "Roughness",
        MapKind::Gloss => "Smoothness",
        MapKind::Metallic => "Metallic",
        MapKind::Ao => "AO",
        MapKind::Emissive => "Emission",
        MapKind::Height => "Height",
        MapKind::Opacity => "Opacity",
        MapKind::Specular => "Specular",
    }
}

fn file_name(p: &str) -> String {
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}

fn ext_of(p: &str) -> String {
    let n = file_name(p);
    n.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
}

pub fn mesh_file_name(source: &str, naming: Naming) -> String {
    let name = file_name(source);
    let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
    let mut words = split_words(stem);
    let skeletal = words.first().is_some_and(|w| ["sk", "skm"].contains(&w.to_lowercase().as_str()));
    if words.len() > 1 && MESH_PREFIXES.contains(&words[0].to_lowercase().as_str()) {
        words.remove(0);
    }
    let (under, pascal) = styled(&words);
    match naming {
        Naming::Keep => name,
        Naming::Ue5 => format!("{}_{under}.{}", if skeletal { "SK" } else { "SM" }, ext_of(source)),
        Naming::Unity => format!("{pascal}.{}", ext_of(source)),
    }
}

fn set_words(set: &str) -> Vec<String> {
    let mut words = split_words(set);
    if words.len() > 1 && ["t", "tx", "tex"].contains(&words[0].to_lowercase().as_str()) {
        words.remove(0);
    }
    words
}

pub fn texture_file_name(set: &str, kind: MapKind, source: &str, naming: Naming) -> String {
    let (under, pascal) = styled(&set_words(set));
    match naming {
        Naming::Keep => file_name(source),
        Naming::Ue5 => format!("T_{under}_{}.{}", ue5_suffix(kind), ext_of(source)),
        Naming::Unity => format!("{pascal}_{}.{}", unity_suffix(kind), ext_of(source)),
    }
}

fn orm_file_name(set: &str, naming: Naming) -> String {
    let (under, pascal) = styled(&set_words(set));
    match naming {
        Naming::Ue5 => format!("T_{under}_ORM.png"),
        Naming::Unity => format!("{pascal}_ORM.png"),
        Naming::Keep => format!("T_{pascal}_ORM.png"),
    }
}

/// Package folder of a mesh: its first folder under the root, unless that is a generic one like `Meshes`.
fn package_of(mesh: &str) -> Option<String> {
    let parts: Vec<&str> = mesh.split(['\\', '/']).filter(|p| !p.is_empty()).collect();
    (parts.len() > 1 && !GENERIC_DIRS.contains(&parts[0].to_lowercase().as_str())).then(|| parts[0].to_string())
}

// ---------------------------------------------------------------- plan

enum Job {
    Copy { source: PathBuf, target: PathBuf, kind: KitKind },
    Orm { config: OrmPackConfig },
    Mesh { source: PathBuf, target: PathBuf, links: HashMap<String, PathBuf>, packed: HashSet<String> },
}

/// Copied texture targets of one set, shared by every slot that uses it.
#[derive(Default, Clone)]
struct SetTargets {
    /// Source file name (lower case) -> copied file.
    links: HashMap<String, PathBuf>,
    /// File names packed into the ORM (lower case).
    packed: HashSet<String>,
    maps: BTreeMap<MapKind, PathBuf>,
}

struct Planner {
    /// Lower-case target -> source, to give two different sources two different names.
    taken: HashMap<String, PathBuf>,
}

impl Planner {
    fn unique(&mut self, target: PathBuf, source: &Path) -> PathBuf {
        let mut n = 1;
        let mut t = target.clone();
        loop {
            let key = t.to_string_lossy().to_lowercase();
            match self.taken.get(&key) {
                Some(s) if s.as_path() != source => {
                    n += 1;
                    let stem = target.file_stem().unwrap_or_default().to_string_lossy();
                    let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                    t = target.with_file_name(format!("{stem}_{n}{ext}"));
                }
                _ => {
                    self.taken.insert(key, source.to_path_buf());
                    return t;
                }
            }
        }
    }
}

fn inside(child: &Path, parent: &Path) -> bool {
    let low = |p: &Path| PathBuf::from(absolute(p).to_string_lossy().to_lowercase());
    low(child).starts_with(low(parent))
}

fn rel_link(target: &Path, from_dir: &Path) -> String {
    relpath_portable(target, from_dir).unwrap_or_else(|| target.to_string_lossy().replace('\\', "/"))
}

/// URIs in glTF are percent-encoded; encode what commonly appears in file names.
fn uri_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '%' => "%25".to_string(),
            '#' => "%23".to_string(),
            c => c.to_string(),
        })
        .collect()
}

// ---------------------------------------------------------------- mesh writers

/// MTL text with every texture path whose file name is in `links` replaced.
fn rewrite_mtl(text: &str, links: &HashMap<String, String>) -> (String, usize) {
    let mut n = 0;
    let lines: Vec<String> = text
        .split_inclusive('\n')
        .map(|raw| {
            let body = raw.trim_end_matches(['\r', '\n']);
            let eol = &raw[body.len()..];
            let Some(c) = MTL_MAP_RE.captures(body) else { return raw.to_string() };
            let args = c.get(1).unwrap();
            let Some(last) = args.as_str().split_whitespace().last() else { return raw.to_string() };
            let Some(new) = links.get(&base_lower(last)) else { return raw.to_string() };
            let start = args.start() + args.as_str().rfind(last).unwrap_or(0);
            n += 1;
            format!("{}{new}{}{eol}", &body[..start], &body[start + last.len()..])
        })
        .collect();
    (lines.concat(), n)
}

struct MeshOutcome {
    relinked: usize,
    sidecars: Vec<KitItem>,
    warnings: Vec<String>,
}

fn write_mesh(source: &Path, target: &Path, links: &HashMap<String, String>, relink: bool, overwrite: bool) -> Result<MeshOutcome, String> {
    let err = |e: &dyn std::fmt::Display| format!("{}: {e}", source.display());
    let src_dir = source.parent().unwrap_or(Path::new(""));
    let dst_dir = target.parent().unwrap_or(Path::new(""));
    let mut out = MeshOutcome { relinked: 0, sidecars: Vec::new(), warnings: Vec::new() };
    let empty = HashMap::new();
    let links = if relink { links } else { &empty };
    // Writes a file that travels with the mesh; returns how many paths it relinked.
    let sidecar = |src: PathBuf, dst: PathBuf, write: &dyn Fn(&Path) -> Result<usize, String>| -> (KitItem, usize) {
        let item = |status, note| KitItem { kind: KitKind::Sidecar, sources: vec![src.clone()], target: dst.clone(), status, note };
        if dst.exists() && !overwrite {
            return (item(KitStatus::Skipped, Some("already in the destination".into())), 0);
        }
        match write(&dst) {
            Ok(n) => (item(KitStatus::Written, None), n),
            Err(e) => (item(KitStatus::Failed, Some(e)), 0),
        }
    };

    match ext_lower(source).as_str() {
        "fbx" => {
            fs::copy(source, target).map_err(|e| err(&e))?;
            if !links.is_empty() {
                out.relinked = relink_fbx(target, links).map_err(|e| err(&e))?.len();
            }
        }
        "obj" => {
            let data = fs::read(source).map_err(|e| err(&e))?;
            let mut obj = Vec::with_capacity(data.len());
            for line in data.split_inclusive(|&b| b == b'\n') {
                let text = String::from_utf8_lossy(line);
                let t = text.trim_start();
                if let Some(name) = t.strip_prefix("mtllib").filter(|r| r.starts_with([' ', '\t'])).map(str::trim) {
                    // The MTL goes next to the OBJ under its own file name.
                    let mtl_name = file_name(name);
                    let (src_mtl, dst_mtl) = (src_dir.join(name), dst_dir.join(&mtl_name));
                    let (item, n) = sidecar(src_mtl.clone(), dst_mtl, &|dst| {
                        let text = fs::read(&src_mtl).map_err(|e| format!("{}: {e}", src_mtl.display()))?;
                        let (text, n) = rewrite_mtl(&String::from_utf8_lossy(&text), links);
                        fs::write(dst, text).map(|_| n).map_err(|e| e.to_string())
                    });
                    out.sidecars.push(item);
                    out.relinked += n;
                    obj.extend_from_slice(format!("mtllib {mtl_name}\n").as_bytes());
                } else {
                    obj.extend_from_slice(line);
                }
            }
            fs::write(target, obj).map_err(|e| err(&e))?;
        }
        "gltf" => {
            let text = fs::read_to_string(source).map_err(|e| err(&e))?;
            let mut json: serde_json::Value = serde_json::from_str(&text).map_err(|e| err(&e))?;
            for img in json.get_mut("images").and_then(|i| i.as_array_mut()).into_iter().flatten() {
                let Some(uri) = img.get("uri").and_then(|u| u.as_str()).filter(|u| !u.starts_with("data:")) else { continue };
                if let Some(new) = links.get(&base_lower(&percent_decode(uri))) {
                    img["uri"] = serde_json::Value::String(uri_encode(new));
                    out.relinked += 1;
                }
            }
            for buf in json.get_mut("buffers").and_then(|b| b.as_array_mut()).into_iter().flatten() {
                let Some(uri) = buf.get("uri").and_then(|u| u.as_str()).filter(|u| !u.starts_with("data:")).map(str::to_string) else { continue };
                let decoded = percent_decode(&uri);
                let name = file_name(&decoded);
                let src = src_dir.join(&decoded);
                out.sidecars.push(sidecar(src.clone(), dst_dir.join(&name), &|dst| fs::copy(&src, dst).map(|_| 0).map_err(|e| e.to_string())).0);
                buf["uri"] = serde_json::Value::String(uri_encode(&name));
            }
            fs::write(target, serde_json::to_string_pretty(&json).map_err(|e| err(&e))?).map_err(|e| err(&e))?;
        }
        _ => {
            fs::copy(source, target).map_err(|e| err(&e))?;
            if ext_lower(source) == "glb" && !mesh_texture_paths(source).unwrap_or_default().is_empty() {
                out.warnings.push(format!("{}: external texture paths in a GLB are not rewritten", source.display()));
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- assemble

/// Plan (and unless `dry_run`, write) the kit. `progress(done, total, target)` is called per item.
pub fn assemble_kit(manifest: &AssetManifest, opts: &KitOptions, progress: &mut dyn FnMut(usize, usize, &Path)) -> Result<KitReport, String> {
    let start = Instant::now();
    let root = &manifest.root;
    if opts.dest.as_os_str().is_empty() {
        return Err("Choose a destination folder".into());
    }
    if inside(&opts.dest, root) {
        return Err(format!("The destination {} is inside the delivery folder: choose a folder outside it, the delivery stays untouched", opts.dest.display()));
    }

    let mut planner = Planner { taken: HashMap::new() };
    let mut sets: HashMap<String, SetTargets> = HashMap::new();
    let mut jobs: Vec<Job> = Vec::new();
    let mut skipped_slots = Vec::new();
    let mut warnings = Vec::new();
    let mut kit_assets = Vec::new();

    for asset in &manifest.assets {
        let source = root.join(&asset.mesh);
        if !source.is_file() {
            warnings.push(format!("{}: mesh not found, left out", asset.mesh));
            continue;
        }
        let base = match (&opts.keep_packages, package_of(&asset.mesh)) {
            (true, Some(p)) => opts.dest.join(p),
            _ => opts.dest.clone(),
        };
        let target = planner.unique(base.join(&opts.mesh_dir).join(mesh_file_name(&asset.mesh, opts.naming)), &source);
        let tex_dir = base.join(&opts.texture_dir);
        let mut links = HashMap::new();
        let mut packed = HashSet::new();
        let mut kit_slots = Vec::new();

        for slot in &asset.slots {
            let Some(set) = &slot.texture_set else { continue };
            if slot.decision == "open" && !opts.include_open {
                skipped_slots.push(format!("{} / {}: match not confirmed", asset.mesh, slot.slot));
                continue;
            }
            let key = format!("{}|{}", set.folder.to_lowercase(), set.name.to_lowercase());
            if !sets.contains_key(&key) {
                let has_orm = set.maps.contains_key(&MapKind::Orm);
                let pack = opts.pack_orm && !has_orm && PACKED.iter().any(|k| set.maps.contains_key(k));
                let mut t = SetTargets::default();
                for (&kind, rel) in &set.maps {
                    let src = root.join(rel);
                    if pack && PACKED.contains(&kind) {
                        t.packed.insert(base_lower(rel));
                        continue;
                    }
                    if !src.is_file() {
                        warnings.push(format!("{rel}: texture not found, left out"));
                        continue;
                    }
                    let dst = planner.unique(tex_dir.join(texture_file_name(&set.name, kind, rel, opts.naming)), &src);
                    t.links.insert(base_lower(rel), dst.clone());
                    t.maps.insert(kind, dst.clone());
                    jobs.push(Job::Copy { source: src, target: dst, kind: KitKind::Texture });
                }
                if pack {
                    let path = |k: MapKind| set.maps.get(&k).map(|r| root.join(r)).filter(|p| p.is_file());
                    let rough = path(MapKind::Roughness);
                    let from_gloss = rough.is_none() && path(MapKind::Gloss).is_some();
                    let marker = root.join(format!("{}#orm", key));
                    let output = planner.unique(tex_dir.join(orm_file_name(&set.name, opts.naming)), &marker);
                    t.maps.insert(MapKind::Orm, output.clone());
                    jobs.push(Job::Orm {
                        config: OrmPackConfig {
                            roughness_path: rough.or_else(|| path(MapKind::Gloss)),
                            metallic_path: path(MapKind::Metallic),
                            ao_path: path(MapKind::Ao),
                            output_path: output,
                            format: OrmFormat::Png,
                            roughness_from_gloss: from_gloss,
                        },
                    });
                }
                sets.insert(key.clone(), t);
            }
            let t = &sets[&key];
            links.extend(t.links.iter().map(|(k, v)| (k.clone(), v.clone())));
            packed.extend(t.packed.iter().cloned());
            kit_slots.push((slot.slot.clone(), set.name.clone(), t.maps.clone()));
        }
        kit_assets.push((asset.mesh.clone(), target.clone(), kit_slots));
        jobs.push(Job::Mesh { source, target, links, packed });
    }

    // ------------------------------------------------ execute
    let total = jobs.len();
    let mut items = Vec::new();
    let mut relinked = 0;
    let mut bytes_written = 0u64;
    for (i, job) in jobs.into_iter().enumerate() {
        let (kind, sources, target) = match &job {
            Job::Copy { source, target, kind } => (*kind, vec![source.clone()], target.clone()),
            Job::Orm { config } => (KitKind::Orm, [&config.roughness_path, &config.metallic_path, &config.ao_path].into_iter().flatten().cloned().collect(), config.output_path.clone()),
            Job::Mesh { source, target, .. } => (KitKind::Mesh, vec![source.clone()], target.clone()),
        };
        progress(i, total, &target);
        let mut item = KitItem { kind, sources, target: target.clone(), status: KitStatus::Planned, note: None };
        if target.exists() && !opts.overwrite {
            item.status = KitStatus::Skipped;
            item.note = Some("already in the destination".into());
            items.push(item);
            continue;
        }
        if opts.dry_run {
            items.push(item);
            continue;
        }
        if let Some(parent) = target.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                item.status = KitStatus::Failed;
                item.note = Some(e.to_string());
                items.push(item);
                continue;
            }
        }
        let result: Result<Option<String>, String> = match &job {
            Job::Copy { source, target, .. } => fs::copy(source, target).map(|_| None).map_err(|e| e.to_string()),
            Job::Orm { config } => pack_orm(config).map(|r| Some(format!("{}x{}", r.width, r.height))),
            Job::Mesh { source, target, links, packed } => {
                let dir = target.parent().unwrap_or(Path::new(""));
                let stored: HashMap<String, String> = links.iter().map(|(k, v)| (k.clone(), rel_link(v, dir))).collect();
                write_mesh(source, target, &stored, opts.relink, opts.overwrite).map(|o| {
                    relinked += o.relinked;
                    warnings.extend(o.warnings);
                    items.extend(o.sidecars);
                    let packed_refs: Vec<String> = mesh_texture_paths(source).unwrap_or_default().into_iter().filter(|r| packed.contains(&base_lower(r))).collect();
                    if !packed_refs.is_empty() {
                        warnings.push(format!("{}: references {} which went into the ORM map; left as is", file_name(&source.to_string_lossy()), packed_refs.join(", ")));
                    }
                    (o.relinked > 0).then(|| format!("{} texture path(s) relinked", o.relinked))
                })
            }
        };
        match result {
            Ok(note) => {
                item.status = KitStatus::Written;
                item.note = note;
                bytes_written += fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            }
            Err(e) => {
                item.status = KitStatus::Failed;
                item.note = Some(e);
            }
        }
        items.push(item);
    }
    progress(total, total, &opts.dest);

    let kit_manifest = if opts.dry_run {
        None
    } else {
        let rel = |p: &Path| rel_link(p, &opts.dest);
        let assets: Vec<serde_json::Value> = kit_assets
            .iter()
            .map(|(src, target, slots)| {
                serde_json::json!({
                    "mesh": rel(target),
                    "source": src,
                    "slots": slots.iter().map(|(slot, set, maps)| serde_json::json!({
                        "slot": slot,
                        "textureSet": set,
                        "maps": maps.iter().map(|(k, p)| (serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(), rel(p))).collect::<BTreeMap<_, _>>(),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        let doc = serde_json::json!({
            "format": "poseidon.kit-manifest",
            "version": 1,
            "source": root,
            "generatedUnix": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            "naming": opts.naming,
            "assets": assets,
        });
        let path = opts.dest.join("kit_manifest.json");
        match fs::create_dir_all(&opts.dest).and_then(|_| fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default())) {
            Ok(()) => Some(path),
            Err(e) => {
                warnings.push(format!("kit_manifest.json: {e}"));
                None
            }
        }
    };

    Ok(KitReport { dest: opts.dest.clone(), items, relinked, skipped_slots, warnings, bytes_written, kit_manifest, dry_run: opts.dry_run, elapsed_ms: start.elapsed().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fbx::doctor::referenced_paths;
    use crate::core::fbx::test_support::build_binary_fbx;

    #[test]
    fn names_follow_the_preset() {
        assert_eq!(mesh_file_name("Meshes/SM_wall_corner_01.FBX", Naming::Ue5), "SM_Wall_Corner_01.fbx");
        assert_eq!(mesh_file_name("hero_skel.fbx", Naming::Ue5), "SM_Hero_Skel.fbx");
        assert_eq!(mesh_file_name("SK_Hero.fbx", Naming::Ue5), "SK_Hero.fbx");
        assert_eq!(mesh_file_name("SM_wall_corner_01.obj", Naming::Unity), "WallCorner01.obj");
        assert_eq!(mesh_file_name("a/b/My Mesh.glb", Naming::Keep), "My Mesh.glb");
        assert_eq!(texture_file_name("wood_planks", MapKind::BaseColor, "x/wood_planks_basecolor.PNG", Naming::Ue5), "T_Wood_Planks_D.png");
        assert_eq!(texture_file_name("T_Rock", MapKind::Normal, "T_Rock_N.tga", Naming::Unity), "Rock_Normal.tga");
        assert_eq!(orm_file_name("wood_planks", Naming::Ue5), "T_Wood_Planks_ORM.png");
        assert_eq!(orm_file_name("wood_planks", Naming::Unity), "WoodPlanks_ORM.png");
        assert_eq!(package_of("Wall Modular/Meshes/SM_A.fbx").as_deref(), Some("Wall Modular"));
        assert_eq!(package_of("Meshes/SM_A.fbx"), None);
        assert_eq!(package_of("SM_A.fbx"), None);
    }

    #[test]
    fn mtl_paths_are_rewritten_in_place() {
        let links = HashMap::from([("brick_d.png".to_string(), "../Textures/T_Brick_D.png".to_string())]);
        let (text, n) = rewrite_mtl("newmtl a\r\nmap_Kd -bm 1.0 C:\\old\\Brick_D.png\r\nmap_Ks other.png\n", &links);
        assert_eq!(n, 1);
        assert_eq!(text, "newmtl a\r\nmap_Kd -bm 1.0 ../Textures/T_Brick_D.png\r\nmap_Ks other.png\n");
    }

    fn png(path: &Path, value: u8) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::GrayImage::from_pixel(4, 4, image::Luma([value])).save(path).unwrap();
    }

    fn set(name: &str, maps: &[(MapKind, &str)]) -> ManifestSet {
        ManifestSet { name: name.into(), folder: "Textures".into(), maps: maps.iter().map(|(k, p)| (*k, p.to_string())).collect() }
    }

    #[test]
    fn assembles_relinks_and_packs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("delivery");
        let dest = tmp.path().join("kit");
        png(&root.join("Textures/Crate_BaseColor.png"), 200);
        png(&root.join("Textures/Crate_Normal.png"), 128);
        png(&root.join("Textures/Crate_Roughness.png"), 90);
        png(&root.join("Textures/Crate_Metallic.png"), 10);
        png(&root.join("Textures/Brick_D.png"), 50);
        fs::create_dir_all(root.join("Meshes")).unwrap();
        build_binary_fbx(&root.join("Meshes/SM_Crate.fbx"), r"D:\artist\Crate_BaseColor.png", 7400, b"");
        fs::write(root.join("Meshes/wall.obj"), "mtllib mats/wall.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl M_Brick\nf 1 2 3\n").unwrap();
        fs::create_dir_all(root.join("Meshes/mats")).unwrap();
        fs::write(root.join("Meshes/mats/wall.mtl"), "newmtl M_Brick\nmap_Kd ../../Textures/Brick_D.png\n").unwrap();
        fs::write(root.join("Meshes/SM_Pending.fbx"), b"not used").unwrap();

        let crate_set = set("Crate", &[(MapKind::BaseColor, "Textures/Crate_BaseColor.png"), (MapKind::Normal, "Textures/Crate_Normal.png"), (MapKind::Roughness, "Textures/Crate_Roughness.png"), (MapKind::Metallic, "Textures/Crate_Metallic.png")]);
        let slot = |name: &str, s: ManifestSet, decision: &str| ManifestSlot { slot: name.into(), texture_set: Some(s), decision: decision.into() };
        let manifest = AssetManifest {
            root: root.clone(),
            assets: vec![
                ManifestAsset { mesh: "Meshes/SM_Crate.fbx".into(), slots: vec![slot("M_Crate", crate_set.clone(), "auto")] },
                ManifestAsset { mesh: "Meshes/wall.obj".into(), slots: vec![slot("M_Brick", set("Brick", &[(MapKind::BaseColor, "Textures/Brick_D.png")]), "manual")] },
                ManifestAsset { mesh: "Meshes/SM_Pending.fbx".into(), slots: vec![slot("M_X", crate_set, "open")] },
            ],
        };
        let mut opts = KitOptions { dest: dest.clone(), naming: Naming::Ue5, mesh_dir: "Meshes".into(), texture_dir: "Textures".into(), keep_packages: false, pack_orm: true, relink: true, include_open: false, overwrite: false, dry_run: true };

        // Dry run: a plan, nothing on disk.
        let plan = assemble_kit(&manifest, &opts, &mut |_, _, _| {}).unwrap();
        assert!(!dest.exists());
        assert!(plan.items.iter().all(|i| i.status == KitStatus::Planned));
        let targets: Vec<String> = plan.items.iter().map(|i| rel_link(&i.target, &dest)).collect();
        assert_eq!(targets, ["Textures/T_Crate_D.png", "Textures/T_Crate_N.png", "Textures/T_Crate_ORM.png", "Meshes/SM_Crate.fbx", "Textures/T_Brick_D.png", "Meshes/SM_Wall.obj", "Meshes/SM_Pending.fbx"]);
        assert_eq!(plan.skipped_slots, ["Meshes/SM_Pending.fbx / M_X: match not confirmed"]);

        opts.dry_run = false;
        let rep = assemble_kit(&manifest, &opts, &mut |_, _, _| {}).unwrap();
        assert!(rep.items.iter().all(|i| i.status == KitStatus::Written), "{:?}", rep.items);
        let paths = |p: &Path| {
            let mut v = referenced_paths(p).unwrap();
            v.dedup();
            v
        };
        // The test FBX stores the path in five fields (FileName, RelativeFilename, …).
        assert_eq!(paths(&dest.join("Meshes/SM_Crate.fbx")), ["../Textures/T_Crate_D.png"]);
        assert_eq!(fs::read_to_string(dest.join("Meshes/SM_Wall.obj")).unwrap().lines().next(), Some("mtllib wall.mtl"));
        assert_eq!(fs::read_to_string(dest.join("Meshes/wall.mtl")).unwrap(), "newmtl M_Brick\nmap_Kd ../Textures/T_Brick_D.png\n");
        assert_eq!(rep.relinked, 5 + 1);
        let orm = image::open(dest.join("Textures/T_Crate_ORM.png")).unwrap().to_rgb8();
        assert_eq!(orm.get_pixel(0, 0).0, [255, 90, 10], "AO default, roughness, metallic");
        assert!(!dest.join("Textures/T_Crate_R.png").exists(), "packed inputs are not copied");
        assert!(rep.kit_manifest.as_ref().is_some_and(|p| p.is_file()));
        // The delivery is untouched.
        assert_eq!(paths(&root.join("Meshes/SM_Crate.fbx")), [r"D:\artist\Crate_BaseColor.png"]);

        // A second run keeps what is there.
        let again = assemble_kit(&manifest, &opts, &mut |_, _, _| {}).unwrap();
        assert!(again.items.iter().filter(|i| i.kind != KitKind::Sidecar).all(|i| i.status == KitStatus::Skipped));

        opts.dest = root.join("out");
        assert!(assemble_kit(&manifest, &opts, &mut |_, _, _| {}).unwrap_err().contains("inside the delivery"));
    }
}

#[cfg(test)]
mod probe {
    use super::*;
    use crate::core::asset_matcher::{match_assets, MatchStatus};

    /// `KIT_PROBE_SRC=<delivery> KIT_PROBE_DEST=<kit> cargo test probe_kit -- --ignored --nocapture`
    #[test]
    #[ignore = "real-data run driven by environment variables"]
    fn probe_kit() {
        let src = PathBuf::from(std::env::var("KIT_PROBE_SRC").unwrap());
        let dest = PathBuf::from(std::env::var("KIT_PROBE_DEST").unwrap());
        let rep = match_assets(&src);
        let rel = |p: &Path| p.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        let manifest = AssetManifest {
            root: src.clone(),
            assets: rep
                .meshes
                .iter()
                .map(|m| ManifestAsset {
                    mesh: rel(&m.path),
                    slots: m
                        .slots
                        .iter()
                        .map(|s| ManifestSlot {
                            slot: s.name.clone(),
                            decision: if s.status == MatchStatus::Review { "open".into() } else { "auto".into() },
                            texture_set: s.candidates.first().map(|c| {
                                let set = &rep.sets[c.set];
                                ManifestSet { name: set.name.clone(), folder: rel(&set.dir), maps: set.maps.iter().map(|(k, p)| (*k, rel(p))).collect() }
                            }),
                        })
                        .collect(),
                })
                .collect(),
        };
        let opts = KitOptions { dest, naming: Naming::Ue5, mesh_dir: "Meshes".into(), texture_dir: "Textures".into(), keep_packages: true, pack_orm: true, relink: true, include_open: false, overwrite: false, dry_run: false };
        let out = assemble_kit(&manifest, &opts, &mut |_, _, _| {}).unwrap();
        for i in &out.items {
            println!("{:?} {:?} {} <- {:?} {:?}", i.status, i.kind, i.target.display(), i.sources.iter().map(|s| s.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>(), i.note);
        }
        println!("relinked={} skipped={:?}\nwarnings={:#?}", out.relinked, out.skipped_slots, out.warnings);
    }
}
