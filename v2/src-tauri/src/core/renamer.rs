//! Batch renaming rules, engine presets, dry-run planning and undo (port of `src/core/renamer.py`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::utils::history::{RenameHistory, RenameOp, Transaction};
use crate::utils::paths::{category_for, path_key, unique_token, validate_filename};

// --------------------------------------------------------------------------- words & case

type CharClass = fn(&char) -> bool;

fn run_end(c: &[char], i: usize, pred: CharClass) -> usize {
    c[i..].iter().position(|ch| !pred(ch)).map_or(c.len(), |p| i + p)
}

/// Split `"brickWall_01-Normal"` into `["brick", "Wall", "01", "Normal"]`.
///
/// Hand-rolled equivalent of the prototype's
/// `[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+` (the `regex` crate has no look-ahead).
pub fn split_words(text: &str) -> Vec<String> {
    let c: Vec<char> = text.chars().collect();
    let (up, low, dig): (CharClass, CharClass, CharClass) = (char::is_ascii_uppercase, char::is_ascii_lowercase, char::is_ascii_digit);
    let mut words = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let end = if up(&c[i]) {
            let j = run_end(&c, i, up);
            if j - i >= 2 && j < c.len() && low(&c[j]) {
                j - 1 // acronym followed by a capitalized word: "PBRTexture" -> "PBR" + "Texture"
            } else if j == i + 1 && j < c.len() && low(&c[j]) {
                run_end(&c, j, low)
            } else {
                j
            }
        } else if low(&c[i]) {
            run_end(&c, i, low)
        } else if dig(&c[i]) {
            run_end(&c, i, dig)
        } else {
            i += 1;
            continue;
        };
        words.push(c[i..end].iter().collect());
        i = end;
    }
    words
}

fn is_upper_word(w: &str) -> bool {
    w.chars().any(|c| c.is_ascii_alphabetic()) && !w.chars().any(|c| c.is_ascii_lowercase())
}

fn cap(word: &str) -> String {
    if is_upper_word(word) && word.chars().count() <= 3 {
        return word.to_string(); // keep short acronyms like UV, PBR, ORM
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().chain(chars.as_str().to_lowercase().chars()).collect(),
        None => String::new(),
    }
}

/// PascalCase, keeping digit groups separated (`Rock_01`) as UE/Unity projects usually do.
fn pascal_join(words: &[String]) -> String {
    let mut out = String::new();
    for w in words {
        if w.chars().all(|c| c.is_ascii_digit()) && !out.is_empty() {
            out.push('_');
            out.push_str(w);
        } else {
            out.push_str(&cap(w));
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaseStyle {
    Camel,
    Snake,
    Pascal,
    Upper,
    Lower,
    Kebab,
}

pub fn convert_case(text: &str, style: CaseStyle) -> String {
    let words = split_words(text);
    if words.is_empty() {
        return text.to_string();
    }
    let lower = || words.iter().map(|w| w.to_lowercase());
    match style {
        CaseStyle::Snake => lower().collect::<Vec<_>>().join("_"),
        CaseStyle::Kebab => lower().collect::<Vec<_>>().join("-"),
        CaseStyle::Upper => words.iter().map(|w| w.to_uppercase()).collect::<Vec<_>>().join("_"),
        CaseStyle::Lower => lower().collect(),
        CaseStyle::Pascal => words.iter().map(|w| cap(w)).collect(),
        CaseStyle::Camel => words[0].to_lowercase() + &words[1..].iter().map(|w| cap(w)).collect::<String>(),
    }
}

// --------------------------------------------------------------------------- presets

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Ue5,
    Unity,
}

/// Texture map aliases -> (Unreal suffix, Unity suffix).
const TEXTURE_MAPS: &[(&str, &str, &str)] = &[
    ("basecolor", "D", "Albedo"), ("base color", "D", "Albedo"), ("albedo", "D", "Albedo"),
    ("diffuse", "D", "Albedo"), ("diff", "D", "Albedo"), ("color", "D", "Albedo"),
    ("col", "D", "Albedo"), ("d", "D", "Albedo"), ("bc", "D", "Albedo"),
    ("normal", "N", "Normal"), ("normalgl", "N", "Normal"), ("normaldx", "N", "Normal"),
    ("nrm", "N", "Normal"), ("nor", "N", "Normal"), ("norm", "N", "Normal"), ("n", "N", "Normal"),
    ("roughness", "R", "Roughness"), ("rough", "R", "Roughness"), ("rgh", "R", "Roughness"), ("r", "R", "Roughness"),
    ("metallic", "M", "Metallic"), ("metalness", "M", "Metallic"), ("metal", "M", "Metallic"),
    ("mtl", "M", "Metallic"), ("m", "M", "Metallic"),
    ("orm", "ORM", "MaskMap"), ("arm", "ORM", "MaskMap"), ("mask map", "ORM", "MaskMap"), ("maskmap", "ORM", "MaskMap"),
    ("ao", "AO", "Occlusion"), ("occlusion", "AO", "Occlusion"), ("ambient occlusion", "AO", "Occlusion"),
    ("emissive", "E", "Emission"), ("emission", "E", "Emission"), ("emit", "E", "Emission"),
    ("height", "H", "Height"), ("displacement", "H", "Height"), ("disp", "H", "Height"), ("bump", "H", "Height"),
    ("opacity", "A", "Opacity"), ("alpha", "A", "Opacity"),
    ("mask", "Mask", "Mask"),
    ("specular", "S", "Specular"), ("spec", "S", "Specular"),
];
const MAX_MAP_WORDS: usize = 2;
const KNOWN_PREFIXES: &[&str] = &["sm", "sk", "t", "tx", "tex"];
const SKELETAL_HINTS: &[&str] = &["skel", "skeletal", "skinned", "sk"];

/// Detect a trailing map-type alias (`..._Normal`) and remove it from `words`.
fn strip_texture_map(words: &[String]) -> (&[String], Option<(&'static str, &'static str)>) {
    for n in (1..=MAX_MAP_WORDS.min(words.len().saturating_sub(1))).rev() {
        let key = words[words.len() - n..].iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join(" ");
        if let Some(&(_, ue, unity)) = TEXTURE_MAPS.iter().find(|(k, _, _)| *k == key) {
            return (&words[..words.len() - n], Some((ue, unity)));
        }
    }
    (words, None)
}

fn apply_preset(preset: Preset, stem: &str, path: &Path) -> String {
    let category = category_for(path);
    if !matches!(category, "mesh" | "texture" | "source") {
        return stem.to_string();
    }
    let mut words = split_words(stem);
    if words.is_empty() {
        return stem.to_string();
    }
    let mut skeletal = false;
    if words.len() > 1 && KNOWN_PREFIXES.contains(&words[0].to_lowercase().as_str()) {
        skeletal = words[0].eq_ignore_ascii_case("sk");
        words.remove(0);
    }

    if category == "mesh" {
        let is_hint = |w: &String| SKELETAL_HINTS.contains(&w.to_lowercase().as_str());
        if words.iter().any(is_hint) {
            skeletal = true;
            let kept: Vec<String> = words.iter().filter(|w| !is_hint(w)).cloned().collect();
            if !kept.is_empty() {
                words = kept;
            }
        }
        let name = pascal_join(&words);
        return match preset {
            Preset::Unity => name,
            Preset::Ue5 => format!("{}_{name}", if skeletal { "SK" } else { "SM" }),
        };
    }

    let (rest, map_kind) = strip_texture_map(&words);
    let name = pascal_join(rest);
    match (preset, map_kind) {
        (Preset::Unity, Some((_, unity))) => format!("{name}_{unity}"),
        (Preset::Unity, None) => name,
        (Preset::Ue5, Some((ue, _))) => format!("T_{name}_{ue}"),
        (Preset::Ue5, None) => format!("T_{name}"),
    }
}

// --------------------------------------------------------------------------- rules

const fn yes() -> bool {
    true
}

/// Rule definition as sent by the frontend (`RenameRuleSpec` in `src/types/pipeline.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuleSpec {
    #[serde(rename_all = "camelCase")]
    SearchReplace {
        find: String,
        #[serde(default)]
        replace: String,
        /// Regex mode uses `$1` / `${name}` replacement references.
        #[serde(default)]
        regex: bool,
        #[serde(default = "yes")]
        case_sensitive: bool,
    },
    #[serde(rename_all = "camelCase")]
    Prefix {
        prefix: String,
        #[serde(default = "yes")]
        skip_if_present: bool,
    },
    #[serde(rename_all = "camelCase")]
    Suffix {
        suffix: String,
        #[serde(default = "yes")]
        skip_if_present: bool,
    },
    Case { style: CaseStyle },
    Preset { preset: Preset },
}

/// A rule ready to apply. Transforms the file stem; extensions are never touched.
pub enum Rule {
    SearchReplace { pattern: Option<Regex>, replace: String, regex: bool },
    Prefix { prefix: String, skip_if_present: bool },
    Suffix { suffix: String, skip_if_present: bool },
    Case(CaseStyle),
    Preset(Preset),
}

impl Rule {
    pub fn compile(spec: &RuleSpec) -> Result<Rule, String> {
        Ok(match spec {
            RuleSpec::SearchReplace { find, replace, regex, case_sensitive } => {
                let pattern = if find.is_empty() {
                    None
                } else {
                    let src = if *regex { find.clone() } else { regex::escape(find) };
                    Some(
                        RegexBuilder::new(&src)
                            .case_insensitive(!case_sensitive)
                            .build()
                            .map_err(|e| format!("Invalid regex '{find}': {e}"))?,
                    )
                };
                Rule::SearchReplace { pattern, replace: replace.clone(), regex: *regex }
            }
            RuleSpec::Prefix { prefix, skip_if_present } => Rule::Prefix { prefix: prefix.clone(), skip_if_present: *skip_if_present },
            RuleSpec::Suffix { suffix, skip_if_present } => Rule::Suffix { suffix: suffix.clone(), skip_if_present: *skip_if_present },
            RuleSpec::Case { style } => Rule::Case(*style),
            RuleSpec::Preset { preset } => Rule::Preset(*preset),
        })
    }

    pub fn apply(&self, stem: &str, path: &Path) -> String {
        match self {
            Rule::SearchReplace { pattern: None, .. } => stem.to_string(),
            Rule::SearchReplace { pattern: Some(p), replace, regex: true } => p.replace_all(stem, replace.as_str()).into_owned(),
            // Literal mode must not interpret `$` in the replacement.
            Rule::SearchReplace { pattern: Some(p), replace, regex: false } => p.replace_all(stem, NoExpand(replace)).into_owned(),
            Rule::Prefix { prefix, skip_if_present } => {
                if *skip_if_present && stem.starts_with(prefix.as_str()) {
                    stem.to_string()
                } else {
                    format!("{prefix}{stem}")
                }
            }
            Rule::Suffix { suffix, skip_if_present } => {
                if *skip_if_present && stem.ends_with(suffix.as_str()) {
                    stem.to_string()
                } else {
                    format!("{stem}{suffix}")
                }
            }
            Rule::Case(style) => convert_case(stem, *style),
            Rule::Preset(preset) => apply_preset(*preset, stem, path),
        }
    }
}

pub fn compile_rules(specs: &[RuleSpec]) -> Result<Vec<Rule>, String> {
    specs.iter().map(Rule::compile).collect()
}

pub fn apply_rules(stem: &str, path: &Path, rules: &[Rule]) -> String {
    rules.iter().fold(stem.to_string(), |s, r| r.apply(&s, path))
}

// --------------------------------------------------------------------------- planning

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Status {
    #[serde(rename = "OK")]
    Ok,
    #[serde(rename = "Skipped")]
    Unchanged,
    Collision,
    Invalid,
}

#[derive(Debug, Clone)]
pub struct RenameEntry {
    pub src: PathBuf,
    /// Equals `src` for skipped and invalid entries.
    pub dst: PathBuf,
    pub status: Status,
    pub message: String,
    /// Proposed name; differs from `dst`'s name only for invalid entries.
    pub new_name: String,
}

impl RenameEntry {
    pub fn new(src: PathBuf, dst: PathBuf) -> Self {
        let new_name = file_name(&dst);
        Self { src, dst, status: Status::Ok, message: String::new(), new_name }
    }
}

/// One dry-run table row (`RenameRow` in `src/types/pipeline.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRow {
    pub original_path: String,
    pub original_name: String,
    pub new_name: String,
    pub target_path: String,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl From<&RenameEntry> for RenameRow {
    fn from(e: &RenameEntry) -> Self {
        RenameRow {
            original_path: e.src.to_string_lossy().into_owned(),
            original_name: file_name(&e.src),
            new_name: e.new_name.clone(),
            target_path: e.dst.to_string_lossy().into_owned(),
            status: e.status,
            reason: (!e.message.is_empty()).then(|| e.message.clone()),
        }
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Split a file name into (stem, suffix-with-dot) the way Python's `Path.stem` / `.suffix` do.
fn stem_and_suffix(path: &Path) -> (String, String) {
    let name = file_name(path);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let suffix = name[stem.len().min(name.len())..].to_string();
    (stem, suffix)
}

/// Turn proposals `(src, new_name, forced_error)` into entries and flag invalid names and collisions.
fn plan_proposals(proposals: Vec<(PathBuf, String, Option<&'static str>)>) -> Vec<RenameEntry> {
    let mut entries: Vec<RenameEntry> = proposals
        .into_iter()
        .map(|(src, new_name, forced)| {
            if let Some(err) = forced {
                RenameEntry { dst: src.clone(), src, status: Status::Invalid, message: err.into(), new_name }
            } else if new_name == file_name(&src) {
                RenameEntry { dst: src.clone(), src, status: Status::Unchanged, message: "Name unchanged".into(), new_name }
            } else if let Some(err) = validate_filename(&new_name) {
                RenameEntry { dst: src.clone(), src, status: Status::Invalid, message: err.into(), new_name }
            } else {
                RenameEntry::new(src.clone(), src.with_file_name(&new_name))
            }
        })
        .collect();

    let active = |e: &&mut RenameEntry| e.status == Status::Ok;
    let mut target_counts: HashMap<String, usize> = HashMap::new();
    let mut leaving: HashSet<String> = HashSet::new();
    for e in entries.iter_mut().filter(active) {
        *target_counts.entry(path_key(&e.dst)).or_insert(0) += 1;
        leaving.insert(path_key(&e.src));
    }
    for e in entries.iter_mut().filter(|e| e.status == Status::Ok) {
        let dst_key = path_key(&e.dst);
        if target_counts[&dst_key] > 1 {
            e.status = Status::Collision;
            e.message = "Several files map to this name".into();
        } else if dst_key == path_key(&e.src) {
            e.message = "Case-only change".into();
        } else if e.dst.exists() && !leaving.contains(&dst_key) {
            e.status = Status::Collision;
            e.message = "Target already exists".into();
        }
    }
    entries
}

/// Dry run: compute every new name and flag collisions without touching the disk.
pub fn build_plan(paths: &[PathBuf], rules: &[Rule]) -> Vec<RenameEntry> {
    plan_proposals(
        paths
            .iter()
            .map(|p| {
                let (stem, suffix) = stem_and_suffix(p);
                (p.clone(), apply_rules(&stem, p, rules) + &suffix, None)
            })
            .collect(),
    )
}

/// Re-validate explicit `(src, dst)` pairs coming back from the UI before applying them.
pub fn plan_from_pairs(pairs: &[(PathBuf, PathBuf)]) -> Vec<RenameEntry> {
    plan_proposals(
        pairs
            .iter()
            .map(|(src, dst)| {
                let forced = if src.parent().map(path_key) != dst.parent().map(path_key) {
                    Some("Target must stay in the same folder")
                } else if !src.is_file() {
                    Some("Source file no longer exists")
                } else {
                    None
                };
                (src.clone(), file_name(dst), forced)
            })
            .collect(),
    )
}

// --------------------------------------------------------------------------- execution & undo

/// Rename `src -> dst` for every pair, safely handling swaps, chains and case-only changes.
///
/// Phase 1 moves every source to a unique temp name, phase 2 moves temps to targets.
/// Any failure rolls back everything already done.
fn apply_moves_with(pairs: &[(PathBuf, PathBuf)], rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>) -> io::Result<()> {
    let token = &unique_token()[..12];
    let temps: Vec<(&PathBuf, PathBuf, &PathBuf)> = pairs
        .iter()
        .enumerate()
        .map(|(i, (src, dst))| {
            let (_, suffix) = stem_and_suffix(src);
            (src, src.with_file_name(format!(".__pp_{token}_{i}{suffix}")), dst)
        })
        .collect();
    let mut staged: Vec<(&Path, &Path)> = Vec::new();
    let mut placed: Vec<(&Path, &Path)> = Vec::new();

    let result = (|| -> io::Result<()> {
        for (src, tmp, _) in &temps {
            rename(src, tmp)?;
            staged.push((src.as_path(), tmp.as_path()));
        }
        for (_, tmp, dst) in &temps {
            if dst.exists() {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("Target appeared during rename: {}", dst.display())));
            }
            rename(tmp, dst)?;
            placed.push((tmp.as_path(), dst.as_path()));
        }
        Ok(())
    })();

    if let Err(err) = result {
        for (tmp, dst) in placed.iter().rev() {
            let _ = fs::rename(dst, tmp);
        }
        for (src, tmp) in staged.iter().rev() {
            let _ = fs::rename(tmp, src);
        }
        return Err(err);
    }
    Ok(())
}

fn apply_moves(pairs: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    apply_moves_with(pairs, &mut |a, b| fs::rename(a, b))
}

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Apply the OK entries of a plan. Returns the recorded transaction, or `None` if nothing to do.
pub fn execute_plan(entries: &[RenameEntry], history: Option<&RenameHistory>) -> io::Result<Option<Transaction>> {
    let todo: Vec<(PathBuf, PathBuf)> = entries.iter().filter(|e| e.status == Status::Ok).map(|e| (e.src.clone(), e.dst.clone())).collect();
    if todo.is_empty() {
        return Ok(None);
    }
    apply_moves(&todo)?;
    let tx = Transaction {
        id: unique_token(),
        timestamp: now_secs(),
        ops: todo
            .iter()
            .map(|(s, d)| RenameOp { src: s.to_string_lossy().into_owned(), dst: d.to_string_lossy().into_owned() })
            .collect(),
    };
    if let Some(h) = history {
        h.push(tx.clone())?;
    }
    Ok(Some(tx))
}

/// Reverse the most recent transaction. Refuses (and keeps the history) if files moved since.
pub fn undo_last(history: &RenameHistory) -> io::Result<Option<Transaction>> {
    let Some(tx) = history.peek() else { return Ok(None) };
    let pairs: Vec<(PathBuf, PathBuf)> = tx.ops.iter().map(|op| (PathBuf::from(&op.dst), PathBuf::from(&op.src))).collect();
    let leaving: HashSet<String> = pairs.iter().map(|(cur, _)| path_key(cur)).collect();
    for (cur, orig) in &pairs {
        if !cur.exists() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("Cannot undo: {} no longer exists", cur.display())));
        }
        if orig.exists() && !leaving.contains(&path_key(orig)) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("Cannot undo: {} is occupied", orig.display())));
        }
    }
    apply_moves(&pairs)?;
    history.pop()?;
    Ok(Some(tx))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|n| {
                let p = dir.join(n);
                fs::write(&p, n).unwrap();
                p
            })
            .collect()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn rule(spec: RuleSpec) -> Rule {
        Rule::compile(&spec).unwrap()
    }

    fn sr(find: &str, replace: &str, regex: bool) -> Rule {
        rule(RuleSpec::SearchReplace { find: find.into(), replace: replace.into(), regex, case_sensitive: true })
    }

    fn renamed(name: &str, rules: &[Rule]) -> String {
        let p = Path::new(name);
        let (stem, suffix) = stem_and_suffix(p);
        apply_rules(&stem, p, rules) + &suffix
    }

    #[test]
    fn split_words_matches_prototype() {
        assert_eq!(split_words("brickWall_01-Normal"), ["brick", "Wall", "01", "Normal"]);
        assert_eq!(split_words("PBRTexture"), ["PBR", "Texture"]);
        assert_eq!(split_words("T_Wood_D"), ["T", "Wood", "D"]);
    }

    #[test]
    fn case_conversion() {
        let src = "Rusty metal-Plate_02";
        assert_eq!(convert_case(src, CaseStyle::Snake), "rusty_metal_plate_02");
        assert_eq!(convert_case(src, CaseStyle::Camel), "rustyMetalPlate02");
        assert_eq!(convert_case(src, CaseStyle::Pascal), "RustyMetalPlate02");
        assert_eq!(convert_case(src, CaseStyle::Upper), "RUSTY_METAL_PLATE_02");
        assert_eq!(convert_case(src, CaseStyle::Kebab), "rusty-metal-plate-02");
    }

    #[test]
    fn ue5_preset() {
        let r = [Rule::Preset(Preset::Ue5)];
        for (name, expected) in [
            ("wood_planks_basecolor.png", "T_WoodPlanks_D.png"),
            ("wood_planks_Base_Color.png", "T_WoodPlanks_D.png"),
            ("rock01_Roughness.tga", "T_Rock_01_R.tga"),
            ("metal-plate_nrm.png", "T_MetalPlate_N.png"),
            ("crate_ORM.png", "T_Crate_ORM.png"),
            ("T_Crate_D.png", "T_Crate_D.png"),
            ("chair.fbx", "SM_Chair.fbx"),
            ("hero_skel.fbx", "SK_Hero.fbx"),
            ("SM_Rock.obj", "SM_Rock.obj"),
            ("poster.psd", "T_Poster.psd"),
            ("level.blend", "level.blend"),
        ] {
            assert_eq!(renamed(name, &r), expected, "{name}");
        }
    }

    #[test]
    fn unity_preset() {
        let r = [Rule::Preset(Preset::Unity)];
        assert_eq!(renamed("wood_planks_basecolor.png", &r), "WoodPlanks_Albedo.png");
        assert_eq!(renamed("crate_arm.png", &r), "Crate_MaskMap.png");
        assert_eq!(renamed("SM_chair.fbx", &r), "Chair.fbx");
    }

    #[test]
    fn rule_pipeline_and_literal_replace() {
        let rules = [
            sr("old", "new$1", false),
            rule(RuleSpec::Prefix { prefix: "X_".into(), skip_if_present: true }),
            rule(RuleSpec::Suffix { suffix: "_v2".into(), skip_if_present: true }),
        ];
        assert_eq!(apply_rules("my_old_file", Path::new("a.png"), &rules), "X_my_new$1_file_v2");
        assert_eq!(sr(r"(\d+)", "<${1}>", true).apply("lod12", Path::new("a")), "lod<12>");
        let insensitive = rule(RuleSpec::SearchReplace { find: "TEX".into(), replace: "T".into(), regex: false, case_sensitive: false });
        assert_eq!(insensitive.apply("tex_wood", Path::new("a")), "T_wood");
        assert!(Rule::compile(&RuleSpec::SearchReplace { find: "(".into(), replace: "".into(), regex: true, case_sensitive: true }).is_err());
    }

    #[test]
    fn plan_statuses() {
        let dir = tempfile::tempdir().unwrap();
        let p = touch(dir.path(), &["a.png", "b.png", "taken.png", "keep.png"]);
        let plan = build_plan(&p, &[sr("^(a|b)$", "same", true), sr("keep", "kee/p", false)]);
        let by: HashMap<String, &RenameEntry> = plan.iter().map(|e| (file_name(&e.src), e)).collect();
        assert_eq!(by["a.png"].status, Status::Collision);
        assert_eq!(by["b.png"].status, Status::Collision);
        assert_eq!(by["taken.png"].status, Status::Unchanged);
        assert_eq!(by["keep.png"].status, Status::Invalid);
        assert_eq!(by["keep.png"].new_name, "kee/p.png");
        assert_eq!(by["keep.png"].dst, p[3]);

        fs::write(dir.path().join("x.png"), "x").unwrap();
        let plan = build_plan(&p[..1], &[sr("a", "x", false)]);
        assert_eq!(plan[0].status, Status::Collision);
        assert!(plan[0].message.contains("exists"));
    }

    #[test]
    fn swap_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let p = touch(dir.path(), &["a.png", "b.png"]);
        let hist = RenameHistory::new(dir.path());
        let plan = [RenameEntry::new(p[0].clone(), p[1].clone()), RenameEntry::new(p[1].clone(), p[0].clone())];
        execute_plan(&plan, Some(&hist)).unwrap();
        assert_eq!(fs::read_to_string(&p[0]).unwrap(), "b.png");
        assert_eq!(fs::read_to_string(&p[1]).unwrap(), "a.png");
        undo_last(&hist).unwrap();
        assert_eq!(fs::read_to_string(&p[0]).unwrap(), "a.png");
        assert!(hist.load().is_empty());
    }

    #[test]
    fn case_only_rename() {
        let dir = tempfile::tempdir().unwrap();
        let p = touch(dir.path(), &["wood.png"]);
        let plan = build_plan(&p, &[Rule::Case(CaseStyle::Upper)]);
        assert_eq!(plan[0].status, Status::Ok);
        execute_plan(&plan, None).unwrap();
        assert_eq!(names(dir.path()), ["WOOD.png"]);
    }

    #[test]
    fn execute_rolls_back_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let p = touch(dir.path(), &["a.png", "b.png"]);
        let pairs = [(p[0].clone(), dir.path().join("c.png")), (p[1].clone(), dir.path().join("d.png"))];
        let mut calls = 0;
        let err = apply_moves_with(&pairs, &mut |a, b| {
            calls += 1;
            if calls == 3 {
                return Err(io::Error::other("disk on fire")); // fail in phase two
            }
            fs::rename(a, b)
        });
        assert!(err.is_err());
        assert_eq!(names(dir.path()), ["a.png", "b.png"]);
    }

    #[test]
    fn undo_refuses_when_target_occupied() {
        let dir = tempfile::tempdir().unwrap();
        let p = touch(dir.path(), &["a.png"]);
        let hist = RenameHistory::new(dir.path());
        let prefix = rule(RuleSpec::Prefix { prefix: "T_".into(), skip_if_present: true });
        execute_plan(&build_plan(&p, &[prefix]), Some(&hist)).unwrap();
        fs::write(&p[0], "new file").unwrap();
        let err = undo_last(&hist).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(hist.load().len(), 1); // kept so the user can resolve and retry
    }

    #[test]
    fn pairs_from_ui_are_revalidated() {
        let dir = tempfile::tempdir().unwrap();
        let p = touch(dir.path(), &["a.png", "b.png"]);
        let other = dir.path().join("sub").join("z.png");
        let plan = plan_from_pairs(&[(p[0].clone(), p[1].clone()), (p[1].clone(), other), (dir.path().join("gone.png"), dir.path().join("x.png"))]);
        assert_eq!(plan[0].status, Status::Collision);
        assert_eq!(plan[1].status, Status::Invalid);
        assert_eq!(plan[2].status, Status::Invalid);
    }
}
