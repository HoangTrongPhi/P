//! FBX texture-path classifier and fix engine (port of `src/core/fbx_doctor.py`).
//!
//! Path values are handled as raw bytes so strings in legacy code pages survive a rewrite.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::bytes::{Captures, Regex};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::node::*;
use super::reader::{is_binary, parse_ascii, parse_binary};
use super::writer::serialize_binary;
use crate::utils::paths::{canonical, relpath_portable, same_path};

const PATH_FIELD_NAMES: &[&str] = &["FileName", "Filename", "RelativeFilename"];
const PATH_P_NAMES: &[&str] = &["Path", "RelPath", "FileName"];
const OWNER_NODE_NAMES: &[&str] = &["Video", "Texture"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PathKind {
    AbsoluteLocal,
    UncNetwork,
    RelativePortable,
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FixMode {
    /// Rebase to the real location (or a target folder), relative to the FBX.
    #[default]
    Relative,
    /// Keep only the file name.
    Strip,
    /// Copy textures into `<fbx_dir>/<subfolder>/` and point there.
    Collect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    Found,
    FoundByName,
    Missing,
    Embedded,
}

pub fn classify_path(value: &str) -> PathKind {
    let v = value.trim();
    let b = v.as_bytes();
    if v.is_empty() {
        PathKind::Empty
    } else if v.starts_with(r"\\") || v.starts_with("//") {
        PathKind::UncNetwork
    } else if (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || v.starts_with('/') {
        PathKind::AbsoluteLocal // "C:\x", "C:/x", drive-relative "C:x", Unix root
    } else {
        PathKind::RelativePortable
    }
}

fn trim_bytes(v: &[u8]) -> &[u8] {
    v.trim_ascii()
}

/// Last path segment of a raw value (splits on `\` and `/`).
pub fn basename_bytes(value: &[u8]) -> &[u8] {
    let v = trim_bytes(value);
    v.rsplit(|&b| b == b'\\' || b == b'/').next().unwrap_or(v)
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

// =========================================================================== references

#[derive(Debug, Clone)]
enum Locator {
    Binary { node_path: Vec<usize>, prop: usize },
    Ascii { line: usize },
}

#[derive(Debug, Clone)]
pub struct TextureRef {
    /// `FileName`, `RelativeFilename`, `P:Path`, …
    pub field: String,
    /// e.g. `Video::wood`.
    pub owner: String,
    pub value: Vec<u8>,
    pub kind: PathKind,
    owner_key: String,
    pub resolved: Option<PathBuf>,
    pub resolution: Resolution,
    pub embedded: bool,
    locator: Locator,
}

impl TextureRef {
    pub fn value_str(&self) -> String {
        lossy(&self.value)
    }

    pub fn basename(&self) -> String {
        lossy(basename_bytes(&self.value))
    }

    pub fn is_problem(&self) -> bool {
        match self.kind {
            PathKind::Empty => false,
            PathKind::RelativePortable => !matches!(self.resolution, Resolution::Found | Resolution::Embedded),
            _ => true,
        }
    }
}

fn new_ref(field: String, owner: String, value: Vec<u8>, owner_key: String, embedded: bool, locator: Locator) -> TextureRef {
    let kind = classify_path(&lossy(&value));
    TextureRef { field, owner, value, kind, owner_key, resolved: None, resolution: Resolution::Missing, embedded, locator }
}

/// FBX 7 stores `name\0\x01Class`, FBX 6 stores `Class::name`.
fn owner_label(node: &FbxNode) -> String {
    let strings: Vec<&[u8]> = node.props.iter().filter(|p| p.is_string()).filter_map(|p| p.value.as_deref()).collect();
    let Some(first) = strings.first() else { return node.name_str() };
    let has = |s: &[u8], pat: &[u8]| s.windows(pat.len()).any(|w| w == pat);
    let raw = strings.iter().find(|s| has(s, b"\x00\x01") || has(s, b"::")).unwrap_or(first);
    if let Some(i) = raw.windows(2).position(|w| w == b"\x00\x01") {
        return format!("{}::{}", lossy(&raw[i + 2..]), lossy(&raw[..i]));
    }
    lossy(raw)
}

fn binary_refs(doc: &FbxBinaryDocument) -> Vec<TextureRef> {
    // `path[d]` is the child index at depth `d`; `parents[d]` is the ancestor at depth `d`.
    fn walk<'a>(node: &'a FbxNode, path: &mut Vec<usize>, parents: &mut Vec<&'a FbxNode>, out: &mut Vec<TextureRef>) {
        // Depth of the nearest Video / Texture ancestor.
        let owner = parents.iter().rposition(|p| OWNER_NODE_NAMES.iter().any(|n| p.is(n)));
        let mut hit: Option<(String, usize)> = None;
        let is_field = PATH_FIELD_NAMES.iter().any(|n| node.is(n));
        if is_field && owner.is_some_and(|o| o == parents.len() - 1) {
            if node.props.first().is_some_and(FbxProperty::is_string) {
                hit = Some((node.name_str(), 0));
            }
        } else if node.is("P") && owner.is_some() && node.props.len() >= 5 {
            if let Some(p0) = node.props[0].value.as_deref() {
                let p0 = lossy(p0);
                if PATH_P_NAMES.contains(&p0.as_str()) && node.props[4].is_string() {
                    hit = Some((format!("P:{p0}"), 4));
                }
            }
        }
        if let (Some((field, prop)), Some(oi)) = (hit, owner) {
            let owner_node = parents[oi];
            let owner_path = &path[..oi + 1];
            let embedded = owner_node
                .child("Content")
                .and_then(|c| c.props.first())
                .and_then(|p| p.value.as_ref())
                .is_some_and(|v| !v.is_empty());
            out.push(new_ref(
                field,
                owner_label(owner_node),
                node.props[prop].value.clone().unwrap_or_default(),
                format!("b{owner_path:?}"),
                embedded,
                Locator::Binary { node_path: path.clone(), prop },
            ));
        }
        parents.push(node);
        for (i, c) in node.children.iter().enumerate() {
            path.push(i);
            walk(c, path, parents, out);
            path.pop();
        }
        parents.pop();
    }

    let mut out = Vec::new();
    for (i, top) in doc.nodes.iter().enumerate() {
        walk(top, &mut vec![i], &mut Vec::new(), &mut out);
    }
    out
}

// ---- ASCII

static ASCII_FIELD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?-u)^(\s*(FileName|Filename|RelativeFilename)\s*:\s*")(.*)("[ \t]*\r?\n?)$"#).unwrap()
});
static ASCII_P_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?-u)^(\s*P\s*:\s*"(Path|RelPath|FileName)"\s*,\s*"KString"\s*,\s*"XRefUrl"\s*,\s*"[^"]*"\s*,\s*")(.*)("[ \t]*\r?\n?)$"#,
    )
    .unwrap()
});
static ASCII_OWNER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?-u)^\s*(Video|Texture)\s*:\s*(?:-?\d+\s*,\s*)?"([^"]*)""#).unwrap());
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?-u)"[^"]*""#).unwrap());

/// Match a path line; the bool is true for `P:` property lines.
fn ascii_match(line: &[u8]) -> Option<(Captures<'_>, bool)> {
    ASCII_FIELD_RE.captures(line).map(|c| (c, false)).or_else(|| ASCII_P_RE.captures(line).map(|c| (c, true)))
}

fn replace_bytes(src: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        if src[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(src[i]);
            i += 1;
        }
    }
    out
}

fn brace_delta(line: &[u8]) -> (i64, bool) {
    let code = line.split(|&b| b == b';').next().unwrap_or(line);
    let stripped = QUOTED_RE.replace_all(code, &b""[..]);
    let opens = stripped.iter().filter(|&&b| b == b'{').count() as i64;
    let closes = stripped.iter().filter(|&&b| b == b'}').count() as i64;
    (opens - closes, closes > 0)
}

fn ascii_refs(doc: &FbxAsciiDocument) -> Vec<TextureRef> {
    let mut refs = Vec::new();
    let mut depth: i64 = 0;
    let mut owner: Option<(String, i64, usize)> = None; // (label, depth at open, line no)
    for (i, line) in doc.lines.iter().enumerate() {
        if let Some(om) = ASCII_OWNER_RE.captures(line) {
            let name = lossy(&om[2]);
            let label = if name.contains("::") { name } else { format!("{}::{name}", lossy(&om[1])) };
            owner = Some((label, depth, i));
        }
        if let Some((label, _, owner_line)) = &owner {
            if let Some((m, is_p)) = ascii_match(line) {
                let field = if is_p { format!("P:{}", lossy(&m[2])) } else { lossy(&m[2]) };
                let value = replace_bytes(&m[3], b"&quot;", b"\"");
                refs.push(new_ref(field, label.clone(), value, format!("a{owner_line}"), false, Locator::Ascii { line: i }));
            }
        }
        let (delta, has_close) = brace_delta(line);
        depth += delta;
        if owner.as_ref().is_some_and(|(_, d, _)| depth <= *d && has_close) {
            owner = None;
        }
    }
    refs
}

fn ascii_set(doc: &mut FbxAsciiDocument, line_no: usize, new_value: &[u8]) -> FbxResult<()> {
    let line = &doc.lines[line_no];
    let (m, _) = ascii_match(line).ok_or_else(|| FbxError(format!("Line {} no longer matches a path field", line_no + 1)))?;
    let mut out = m[1].to_vec();
    out.extend(replace_bytes(new_value, b"\"", b"&quot;"));
    out.extend_from_slice(&m[4]);
    doc.lines[line_no] = out;
    Ok(())
}

// =========================================================================== resolution

/// Lazy case-insensitive basename -> path index of files near the FBX (shallowest match wins;
/// on a tie the earlier root wins, so the FBX's own folder beats the parent).
struct NameIndex {
    /// (root, walkdir max depth): 1 = files in the root itself, 2 = also its direct subfolders, …
    roots: Vec<(PathBuf, usize)>,
    index: Option<HashMap<String, (PathBuf, usize)>>,
}

/// FBX folder and user-given folders: files up to 4 directory levels below them.
const DEEP: usize = 4 + 1;
/// Parent of the FBX folder: itself and its direct subfolders only (`../Textures/x.png`).
const SHALLOW: usize = 2;

impl NameIndex {
    fn new(fbx_dir: &Path, search_dirs: &[PathBuf], search_parent: bool) -> Self {
        let mut roots = vec![(fbx_dir.to_path_buf(), DEEP)];
        roots.extend(search_dirs.iter().map(|d| (d.clone(), DEEP)));
        if search_parent {
            // Never index a whole drive: skip when the parent is a filesystem root.
            if let Some(parent) = fbx_dir.parent().filter(|p| p.parent().is_some()) {
                roots.push((parent.to_path_buf(), SHALLOW));
            }
        }
        Self { roots, index: None }
    }

    fn find(&mut self, name: &str) -> Option<PathBuf> {
        let roots = &self.roots;
        let index = self.index.get_or_insert_with(|| {
            let mut idx: HashMap<String, (PathBuf, usize)> = HashMap::new();
            for (root, max_depth) in roots.iter().filter(|(r, _)| r.is_dir()) {
                for e in WalkDir::new(root).max_depth(*max_depth).into_iter().flatten() {
                    if !e.file_type().is_file() {
                        continue;
                    }
                    let key = e.file_name().to_string_lossy().to_lowercase();
                    let depth = e.depth();
                    match idx.get(&key) {
                        Some((_, d)) if *d <= depth => {}
                        _ => {
                            idx.insert(key, (e.into_path(), depth));
                        }
                    }
                }
            }
            idx
        });
        index.get(&name.to_lowercase()).map(|(p, _)| p.clone())
    }
}

fn resolve(r: &mut TextureRef, fbx_dir: &Path, index: &mut NameIndex) {
    if r.kind == PathKind::Empty {
        return;
    }
    let value = r.value_str().trim().to_string();
    let candidate = if r.kind == PathKind::RelativePortable { fbx_dir.join(value.replace('\\', "/")) } else { PathBuf::from(&value) };
    if candidate.is_file() {
        r.resolved = Some(canonical(&candidate));
        r.resolution = Resolution::Found;
    } else if let Some(hit) = index.find(&r.basename()) {
        r.resolved = Some(canonical(&hit));
        r.resolution = Resolution::FoundByName;
    } else if r.embedded {
        r.resolution = Resolution::Embedded;
    }
}

// =========================================================================== loading & scanning

#[derive(Debug)]
enum Doc {
    Binary { doc: FbxBinaryDocument, body_end: usize },
    Ascii(FbxAsciiDocument),
}

struct Loaded {
    doc: Doc,
    refs: Vec<TextureRef>,
}

fn load_and_resolve(path: &Path, search_dirs: &[PathBuf], search_parent: bool) -> FbxResult<Loaded> {
    let data = fs::read(path)?;
    let (doc, mut refs) = if is_binary(&data) {
        let doc = parse_binary(&data)?;
        let body_end = data.len() - doc.footer.len();
        let refs = binary_refs(&doc);
        (Doc::Binary { doc, body_end }, refs)
    } else {
        let doc = parse_ascii(&data)?;
        let refs = ascii_refs(&doc);
        (Doc::Ascii(doc), refs)
    };

    let fbx_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut index = NameIndex::new(&fbx_dir, search_dirs, search_parent);
    for r in refs.iter_mut() {
        resolve(r, &fbx_dir, &mut index);
    }

    // Share the best resolution between the FileName / RelativeFilename pair of one owner.
    let mut best: HashMap<String, (PathBuf, Resolution, String)> = HashMap::new();
    for r in &refs {
        let Some(resolved) = &r.resolved else { continue };
        let replace = match best.get(&r.owner_key) {
            None => true,
            Some((_, res, _)) => *res != Resolution::Found && r.resolution == Resolution::Found,
        };
        if replace {
            best.insert(r.owner_key.clone(), (resolved.clone(), r.resolution, r.basename().to_lowercase()));
        }
    }
    for r in refs.iter_mut() {
        if r.resolved.is_none() {
            if let Some((p, _, base)) = best.get(&r.owner_key) {
                if *base == r.basename().to_lowercase() {
                    r.resolved = Some(p.clone());
                    r.resolution = Resolution::FoundByName;
                }
            }
        }
    }
    Ok(Loaded { doc, refs })
}

/// Lower-cased texture file names referenced by an FBX (no disk lookups; for usage reports).
pub fn referenced_basenames(path: &Path) -> FbxResult<Vec<String>> {
    let data = fs::read(path)?;
    let refs = if is_binary(&data) { binary_refs(&parse_binary(&data)?) } else { ascii_refs(&parse_ascii(&data)?) };
    Ok(refs.iter().filter(|r| r.kind != PathKind::Empty).map(|r| r.basename().to_lowercase()).collect())
}

/// One reference as shown in the UI (`FbxPathEntry` in `src/types/pipeline.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbxPathEntry {
    pub node_name: String,
    pub property_name: String,
    pub original_path: String,
    pub resolved_path: Option<String>,
    pub kind: PathKind,
    pub exists_on_disk: bool,
    pub resolution: Resolution,
    pub embedded: bool,
    pub is_problem: bool,
}

impl From<&TextureRef> for FbxPathEntry {
    fn from(r: &TextureRef) -> Self {
        FbxPathEntry {
            node_name: r.owner.clone(),
            property_name: r.field.clone(),
            original_path: r.value_str(),
            resolved_path: r.resolved.as_ref().map(|p| p.to_string_lossy().into_owned()),
            kind: r.kind,
            exists_on_disk: r.resolved.is_some(),
            resolution: r.resolution,
            embedded: r.embedded,
            is_problem: r.is_problem(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbxFileInfo {
    pub path: String,
    pub version: u32,
    pub is_binary: bool,
    pub entries: Vec<FbxPathEntry>,
    pub has_issues: bool,
    pub problem_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl FbxFileInfo {
    pub fn failed(path: &Path, err: impl ToString) -> Self {
        FbxFileInfo {
            path: path.to_string_lossy().into_owned(),
            version: 0,
            is_binary: false,
            entries: Vec::new(),
            has_issues: true,
            problem_count: 0,
            error: Some(err.to_string()),
        }
    }
}

/// Every texture/media path referenced by `path`, classified and resolved against the disk.
/// `search_parent` also looks in the FBX folder's parent and its direct subfolders.
pub fn scan_fbx(path: &Path, search_dirs: &[PathBuf], search_parent: bool) -> FbxResult<FbxFileInfo> {
    let loaded = load_and_resolve(path, search_dirs, search_parent)?;
    let (version, is_binary) = match &loaded.doc {
        Doc::Binary { doc, .. } => (doc.version, true),
        Doc::Ascii(doc) => (doc.version, false),
    };
    let entries: Vec<FbxPathEntry> = loaded.refs.iter().map(FbxPathEntry::from).collect();
    let problem_count = entries.iter().filter(|e| e.is_problem).count();
    Ok(FbxFileInfo { path: path.to_string_lossy().into_owned(), version, is_binary, has_issues: problem_count > 0, problem_count, entries, error: None })
}

// =========================================================================== fixing

fn default_subfolder() -> String {
    "textures".into()
}

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixOptions {
    #[serde(default)]
    pub mode: FixMode,
    /// Relative mode: point every texture at this folder instead of its found location.
    #[serde(default)]
    pub rebase_dir: Option<PathBuf>,
    #[serde(default = "default_subfolder")]
    pub subfolder: String,
    /// Rewrite every non-empty reference, not only problematic ones.
    #[serde(default)]
    pub fix_all: bool,
    #[serde(default = "yes")]
    pub backup: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub search_dirs: Vec<PathBuf>,
    /// Also look for textures in the FBX folder's parent and its direct subfolders
    /// (the common `FBX/` + `Textures/` layout).
    #[serde(default = "yes")]
    pub search_parent: bool,
    /// Rewrite textures that cannot be found to `<subfolder>/<name>`. Off by default:
    /// unresolved paths are left as they are and reported.
    #[serde(default)]
    pub guess_missing: bool,
}

impl Default for FixOptions {
    fn default() -> Self {
        FixOptions {
            mode: FixMode::Relative,
            rebase_dir: None,
            subfolder: default_subfolder(),
            fix_all: false,
            backup: true,
            dry_run: false,
            search_dirs: Vec::new(),
            search_parent: true,
            guess_missing: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathChange {
    pub field: String,
    pub owner: String,
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedFile {
    pub from: PathBuf,
    pub to: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixReport {
    pub path: PathBuf,
    pub changes: Vec<PathChange>,
    pub copied: Vec<CopiedFile>,
    pub warnings: Vec<String>,
    pub backup: Option<PathBuf>,
    pub written: bool,
    pub dry_run: bool,
}

fn join_sub(subfolder: &str, name: &[u8]) -> Vec<u8> {
    if subfolder.is_empty() {
        return name.to_vec();
    }
    let mut v = subfolder.trim_matches('/').as_bytes().to_vec();
    v.push(b'/');
    v.extend_from_slice(name);
    v
}

/// New raw value for one reference, plus an optional warning.
///
/// Unless `guess_missing` is set, a texture that cannot be found keeps its current path in
/// Relative and Collect mode (Strip and an explicit rebase folder are deliberate choices).
pub fn compute_new_path(r: &TextureRef, fbx_dir: &Path, mode: FixMode, rebase_dir: Option<&Path>, subfolder: &str, guess_missing: bool) -> (Vec<u8>, Option<String>) {
    let name = basename_bytes(&r.value).to_vec();
    let name_s = lossy(&name);
    let keep = || (r.value.clone(), Some(format!("{name_s}: not found, path left unchanged (add a texture folder, or enable guessing)")));
    match mode {
        FixMode::Strip => (name, None),
        FixMode::Collect => {
            if r.resolved.is_none() && !guess_missing {
                return keep();
            }
            let warn = r.resolved.is_none().then(|| format!("{name_s}: source texture not found, path set but nothing copied"));
            (join_sub(subfolder, &name), warn)
        }
        FixMode::Relative => {
            if let Some(rebase) = rebase_dir {
                let target = rebase.join(&name_s);
                return match relpath_portable(&target, fbx_dir) {
                    Some(rel) => {
                        let warn = (!target.exists()).then(|| format!("{name_s}: not present in {}", rebase.display()));
                        (rel.into_bytes(), warn)
                    }
                    None => (name, Some(format!("{name_s}: rebase folder is on another drive, stripped to file name"))),
                };
            }
            if let Some(resolved) = &r.resolved {
                return match relpath_portable(resolved, fbx_dir) {
                    Some(rel) => (rel.into_bytes(), None),
                    None => (name, Some(format!("{name_s}: texture is on another drive, stripped to file name (use Collect mode)"))),
                };
            }
            if !guess_missing {
                return keep();
            }
            let fallback = join_sub(subfolder, &name);
            let warn = format!("{name_s}: texture missing, guessed '{}'", lossy(&fallback));
            (fallback, Some(warn))
        }
    }
}

fn file_size(p: &Path) -> Option<u64> {
    fs::metadata(p).ok().map(|m| m.len())
}

/// Rewrite texture paths in `path`.
///
/// By default only problematic references (absolute, UNC or unresolvable) are rewritten.
/// A `<file>.fbx.bak` copy of the original is kept unless one already exists.
pub fn fix_fbx(path: &Path, opts: &FixOptions) -> FbxResult<FixReport> {
    let fbx_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let Loaded { mut doc, refs } = load_and_resolve(path, &opts.search_dirs, opts.search_parent)?;
    let mut report = FixReport { path: path.to_path_buf(), changes: vec![], copied: vec![], warnings: vec![], backup: None, written: false, dry_run: opts.dry_run };

    for r in &refs {
        if r.kind == PathKind::Empty || !(opts.fix_all || r.is_problem()) {
            continue;
        }
        let (new_value, warn) = compute_new_path(r, &fbx_dir, opts.mode, opts.rebase_dir.as_deref(), &opts.subfolder, opts.guess_missing);
        if let Some(w) = warn {
            if !report.warnings.contains(&w) {
                report.warnings.push(w);
            }
        }
        if let (FixMode::Collect, Some(resolved)) = (opts.mode, &r.resolved) {
            let dest = fbx_dir.join(lossy(&new_value));
            let already = report.copied.iter().any(|c| c.from == *resolved && same_path(&c.to, &dest));
            if !same_path(&dest, resolved) && !already {
                if dest.exists() {
                    if file_size(&dest) != file_size(resolved) {
                        let parent = dest.parent().map(|p| p.display().to_string()).unwrap_or_default();
                        report.warnings.push(format!("{}: a different file already exists in {parent}, kept it", lossy(basename_bytes(&new_value))));
                    }
                } else {
                    report.copied.push(CopiedFile { from: resolved.clone(), to: dest });
                }
            }
        }
        if new_value == r.value {
            continue;
        }
        report.changes.push(PathChange { field: r.field.clone(), owner: r.owner.clone(), old: r.value_str(), new: lossy(&new_value) });
        match (&mut doc, &r.locator) {
            (Doc::Binary { doc, .. }, Locator::Binary { node_path, prop }) => {
                let node = doc.node_mut(node_path).ok_or_else(|| FbxError("Internal error: node path vanished".into()))?;
                node.props[*prop] = FbxProperty::string(&new_value, b'S');
            }
            (Doc::Ascii(doc), Locator::Ascii { line }) => ascii_set(doc, *line, &new_value)?,
            _ => return Err(FbxError("Internal error: locator / document mismatch".into())),
        }
    }

    if opts.dry_run || (report.changes.is_empty() && report.copied.is_empty()) {
        return Ok(report);
    }

    for c in &report.copied {
        if let Some(parent) = c.to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&c.from, &c.to)?;
    }

    if !report.changes.is_empty() {
        if opts.backup {
            let bak = backup_path(path);
            if !bak.exists() {
                fs::copy(path, &bak)?;
            }
            report.backup = Some(bak);
        }
        let data = match &doc {
            Doc::Binary { doc, body_end } => serialize_binary(doc, Some(*body_end)),
            Doc::Ascii(doc) => doc.lines.concat(),
        };
        let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
        tmp_name.push(".tmp");
        let tmp = path.with_file_name(tmp_name);
        fs::write(&tmp, data)?;
        fs::rename(&tmp, path)?;
        report.written = true;
    }
    Ok(report)
}

pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Restore `<file>.fbx` from `<file>.fbx.bak`. Returns `false` if there is no backup.
pub fn restore_backup(path: &Path) -> FbxResult<bool> {
    let bak = backup_path(path);
    if !bak.exists() {
        return Ok(false);
    }
    fs::copy(&bak, path)?;
    Ok(true)
}
