//! Texture set matching: group textures by base name and map suffix (`Rock_BaseColor`, `T_Rock_N`, …),
//! report which maps a set lacks and which sets can be packed into an ORM texture.

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::renamer::{convert_case, split_words, CaseStyle};
use super::scanner::{normalize_exts, scan};
use crate::utils::paths::TEXTURE_EXTS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MapKind {
    BaseColor,
    Normal,
    Orm,
    Roughness,
    Gloss,
    Metallic,
    Ao,
    Emissive,
    Height,
    Opacity,
    Specular,
}

/// Trailing name aliases (lower-case, words joined by a space) -> map type.
const ALIASES: &[(&str, MapKind)] = &[
    ("basecolor", MapKind::BaseColor), ("base color", MapKind::BaseColor), ("albedo", MapKind::BaseColor),
    ("diffuse", MapKind::BaseColor), ("diff", MapKind::BaseColor), ("color", MapKind::BaseColor),
    ("col", MapKind::BaseColor), ("d", MapKind::BaseColor), ("bc", MapKind::BaseColor),
    ("normal", MapKind::Normal), ("normalgl", MapKind::Normal), ("normaldx", MapKind::Normal), ("normal gl", MapKind::Normal),
    ("normal dx", MapKind::Normal), ("nrm", MapKind::Normal), ("nor", MapKind::Normal), ("norm", MapKind::Normal), ("n", MapKind::Normal),
    ("orm", MapKind::Orm), ("arm", MapKind::Orm), ("mask map", MapKind::Orm), ("maskmap", MapKind::Orm),
    ("roughness", MapKind::Roughness), ("rough", MapKind::Roughness), ("rgh", MapKind::Roughness), ("r", MapKind::Roughness),
    ("gloss", MapKind::Gloss), ("glossiness", MapKind::Gloss), ("smoothness", MapKind::Gloss),
    ("metallic", MapKind::Metallic), ("metalness", MapKind::Metallic), ("metal", MapKind::Metallic), ("mtl", MapKind::Metallic), ("m", MapKind::Metallic),
    ("ao", MapKind::Ao), ("occlusion", MapKind::Ao), ("ambient occlusion", MapKind::Ao),
    ("emissive", MapKind::Emissive), ("emission", MapKind::Emissive), ("emit", MapKind::Emissive),
    ("height", MapKind::Height), ("displacement", MapKind::Height), ("disp", MapKind::Height), ("bump", MapKind::Height),
    ("opacity", MapKind::Opacity), ("alpha", MapKind::Opacity),
    ("specular", MapKind::Specular), ("spec", MapKind::Specular),
];
const KNOWN_PREFIXES: &[&str] = &["t", "tx", "tex"];

/// `(base words, map type)` when the stem ends in a known map alias.
pub fn classify_map(stem: &str) -> Option<(Vec<String>, MapKind)> {
    let words = split_words(stem);
    for n in (1..=2.min(words.len().saturating_sub(1))).rev() {
        let key = words[words.len() - n..].iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join(" ");
        if let Some(&(_, kind)) = ALIASES.iter().find(|(k, _)| *k == key) {
            let mut base = words[..words.len() - n].to_vec();
            if base.len() > 1 && KNOWN_PREFIXES.contains(&base[0].to_lowercase().as_str()) {
                base.remove(0);
            }
            return Some((base, kind));
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureSet {
    pub dir: PathBuf,
    /// Base name shared by the maps, e.g. `Wood_Planks`.
    pub name: String,
    pub maps: BTreeMap<MapKind, PathBuf>,
    /// Further files of a map type the set already has (same map in two formats, …).
    pub extra: Vec<PathBuf>,
    /// Maps a PBR material usually needs: base color, normal and ORM or roughness.
    pub missing: Vec<MapKind>,
    /// Has roughness / gloss / metallic / AO inputs but no ORM texture yet.
    pub can_pack_orm: bool,
    /// `<dir>/T_<Name>_ORM.png`.
    pub suggested_orm: PathBuf,
}

impl TextureSet {
    pub fn roughness_input(&self) -> Option<(&PathBuf, bool)> {
        self.maps.get(&MapKind::Roughness).map(|p| (p, false)).or_else(|| self.maps.get(&MapKind::Gloss).map(|p| (p, true)))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureSetReport {
    pub sets: Vec<TextureSet>,
    pub total_textures: usize,
    /// Textures whose name has no recognisable map suffix.
    pub unmatched: Vec<PathBuf>,
}

/// `(folder, lower-case base key)` -> `(display name, maps found)`.
type Groups = HashMap<(PathBuf, String), (String, Vec<(MapKind, PathBuf)>)>;

pub fn group_texture_sets(paths: &[PathBuf]) -> TextureSetReport {
    let mut groups: Groups = HashMap::new();
    let mut unmatched = Vec::new();
    for p in paths {
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        match classify_map(&stem) {
            Some((base, kind)) if !base.is_empty() => {
                let key = base.iter().map(|w| w.to_lowercase()).collect::<String>();
                let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
                groups.entry((dir, key)).or_insert_with(|| (base.join("_"), Vec::new())).1.push((kind, p.clone()));
            }
            _ => unmatched.push(p.clone()),
        }
    }

    let mut sets: Vec<TextureSet> = groups
        .into_iter()
        .map(|((dir, _), (name, mut files))| {
            files.sort_by(|a, b| a.1.cmp(&b.1));
            let mut maps = BTreeMap::new();
            let mut extra = Vec::new();
            for (kind, path) in files {
                match maps.entry(kind) {
                    Entry::Occupied(_) => extra.push(path),
                    Entry::Vacant(v) => {
                        v.insert(path);
                    }
                }
            }
            let has = |k: MapKind| maps.contains_key(&k);
            let mut missing = Vec::new();
            for k in [MapKind::BaseColor, MapKind::Normal] {
                if !has(k) {
                    missing.push(k);
                }
            }
            if !has(MapKind::Orm) && !has(MapKind::Roughness) && !has(MapKind::Gloss) {
                missing.push(MapKind::Roughness);
            }
            let can_pack_orm = !has(MapKind::Orm) && [MapKind::Roughness, MapKind::Gloss, MapKind::Metallic, MapKind::Ao].into_iter().any(has);
            let suggested_orm = dir.join(format!("T_{}_ORM.png", convert_case(&name, CaseStyle::Pascal)));
            TextureSet { dir, name, maps, extra, missing, can_pack_orm, suggested_orm }
        })
        .collect();
    sets.sort_by(|a, b| (&a.dir, a.name.to_lowercase()).cmp(&(&b.dir, b.name.to_lowercase())));
    unmatched.sort();
    TextureSetReport { sets, total_textures: paths.len(), unmatched }
}

pub fn find_texture_sets(root: &Path) -> TextureSetReport {
    let files: Vec<PathBuf> = scan(root, &normalize_exts(TEXTURE_EXTS), true, None).files.into_iter().map(|f| f.path).collect();
    group_texture_sets(&files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_names() {
        let k = |s: &str| classify_map(s).map(|(b, k)| (b.join("_"), k));
        assert_eq!(k("wood_planks_basecolor"), Some(("wood_planks".into(), MapKind::BaseColor)));
        assert_eq!(k("T_Rock_N"), Some(("Rock".into(), MapKind::Normal)));
        assert_eq!(k("Metal-Plate_Ambient_Occlusion"), Some(("Metal_Plate".into(), MapKind::Ao)));
        assert_eq!(k("crate_Glossiness"), Some(("crate".into(), MapKind::Gloss)));
        assert_eq!(k("brick_normal_gl"), Some(("brick".into(), MapKind::Normal)));
        assert_eq!(k("sky_studio"), None);
        assert_eq!(k("normal"), None, "a lone alias has no base name");
    }

    #[test]
    fn groups_sets_and_flags_missing_maps() {
        let p = |s: &str| PathBuf::from("/a").join(s);
        let files = [
            "wood_planks_basecolor.png", "wood_planks_normal.png", "wood_planks_roughness.png", "wood_planks_ao.png",
            "T_Rock_D.tga", "T_Rock_N.tga", "T_Rock_ORM.tga",
            "crate_diffuse.png", "crate_diffuse.jpg", "crate_gloss.png",
            "sky_studio.hdr",
        ]
        .map(p)
        .to_vec();
        let rep = group_texture_sets(&files);
        assert_eq!(rep.total_textures, 11);
        assert_eq!(rep.unmatched, [p("sky_studio.hdr")]);
        assert_eq!(rep.sets.len(), 3);

        let by = |n: &str| rep.sets.iter().find(|s| s.name.eq_ignore_ascii_case(n)).unwrap();
        let wood = by("wood_planks");
        assert!(wood.missing.is_empty() && wood.can_pack_orm);
        assert_eq!(wood.suggested_orm, p("T_WoodPlanks_ORM.png"));

        let rock = by("Rock");
        assert!(rock.missing.is_empty() && !rock.can_pack_orm, "already has an ORM");

        let crate_set = by("crate");
        assert_eq!(crate_set.missing, [MapKind::Normal]);
        assert_eq!(crate_set.extra.len(), 1, "second diffuse kept aside");
        assert_eq!(crate_set.roughness_input(), Some((&p("crate_gloss.png"), true)));
    }
}
