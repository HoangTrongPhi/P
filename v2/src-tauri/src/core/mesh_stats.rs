//! Mesh statistics without a renderer: vertex / triangle counts, UV sets, materials, normals,
//! bounding box, units and up axis for FBX (binary and ASCII 7.x), OBJ and glTF / GLB.
//!
//! Bounds are in each mesh's local space (node transforms are not applied), which is enough
//! to spot a wrong export scale.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use byteorder::{ByteOrder, LittleEndian as LE};
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;

use super::fbx::node::{FbxNode, FbxProperty};
use super::fbx::reader::{is_binary, parse_binary};
use super::usage::glb_json;
use crate::utils::paths::ext_lower;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Bounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Bounds {
    fn empty() -> Self {
        Bounds { min: [f64::INFINITY; 3], max: [f64::NEG_INFINITY; 3] }
    }
    fn add(&mut self, p: [f64; 3]) {
        for (i, v) in p.into_iter().enumerate() {
            self.min[i] = self.min[i].min(v);
            self.max[i] = self.max[i].max(v);
        }
    }
    fn merge(&mut self, o: &Bounds) {
        self.add(o.min);
        self.add(o.max);
    }
    fn valid(&self) -> bool {
        self.min[0] <= self.max[0]
    }
    pub fn size(&self) -> [f64; 3] {
        [self.max[0] - self.min[0], self.max[1] - self.min[1], self.max[2] - self.min[2]]
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshStats {
    pub path: PathBuf,
    /// `fbx-binary`, `fbx-ascii`, `obj`, `gltf` or `glb`.
    pub format: String,
    /// Mesh objects / geometries.
    pub meshes: usize,
    pub vertices: u64,
    pub triangles: u64,
    pub polygons: u64,
    pub materials: usize,
    /// Most UV sets on any one mesh.
    pub uv_sets: usize,
    pub has_normals: bool,
    pub bounds: Option<Bounds>,
    /// Centimetres per file unit (FBX `UnitScaleFactor`; glTF is metres = 100).
    pub unit_scale_cm: Option<f64>,
    pub up_axis: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

impl MeshStats {
    fn new(path: &Path, format: &str) -> Self {
        MeshStats {
            path: path.to_path_buf(),
            format: format.into(),
            meshes: 0,
            vertices: 0,
            triangles: 0,
            polygons: 0,
            materials: 0,
            uv_sets: 0,
            has_normals: false,
            bounds: None,
            unit_scale_cm: None,
            up_axis: None,
            warnings: Vec::new(),
            error: None,
        }
    }

    fn failed(path: &Path, err: String) -> Self {
        let mut s = MeshStats::new(path, &ext_lower(path));
        s.error = Some(err);
        s
    }

    fn add_bounds(&mut self, b: &Bounds) {
        if b.valid() {
            self.bounds.get_or_insert_with(Bounds::empty).merge(b);
        }
    }
}

/// Triangles and polygons from an FBX `PolygonVertexIndex` (a negative index closes a polygon).
fn count_polygons(indices: impl IntoIterator<Item = i64>) -> (u64, u64) {
    let (mut tris, mut polys, mut n) = (0u64, 0u64, 0u64);
    for i in indices {
        n += 1;
        if i < 0 {
            polys += 1;
            tris += n.saturating_sub(2);
            n = 0;
        }
    }
    (tris, polys)
}

fn bounds_of(coords: &[f64]) -> Bounds {
    let mut b = Bounds::empty();
    for c in coords.chunks_exact(3) {
        b.add([c[0], c[1], c[2]]);
    }
    b
}

// --------------------------------------------------------------------------- FBX binary

/// Values of an FBX array property (`d`, `f`, `i`, `l`), zlib-inflated when needed.
fn array_values(p: &FbxProperty) -> Result<Vec<f64>, String> {
    let elem = match p.type_code {
        b'd' | b'l' => 8,
        b'f' | b'i' => 4,
        b'b' | b'c' => 1,
        t => return Err(format!("Property {:?} is not an array", t as char)),
    };
    let raw = &p.raw;
    if raw.len() < 13 {
        return Err("Truncated array property".into());
    }
    let count = LE::read_u32(&raw[1..5]) as usize;
    let encoding = LE::read_u32(&raw[5..9]);
    let payload = &raw[13..];
    let data = if encoding == 1 {
        let mut out = Vec::with_capacity(count * elem);
        flate2::read::ZlibDecoder::new(payload).read_to_end(&mut out).map_err(|e| format!("Corrupt array data: {e}"))?;
        out
    } else {
        payload.to_vec()
    };
    if data.len() < count * elem {
        return Err("Array shorter than its declared length".into());
    }
    Ok((0..count)
        .map(|i| {
            let b = &data[i * elem..];
            match p.type_code {
                b'd' => LE::read_f64(b),
                b'f' => LE::read_f32(b) as f64,
                b'l' => LE::read_i64(b) as f64,
                b'i' => LE::read_i32(b) as f64,
                _ => b[0] as f64,
            }
        })
        .collect())
}

/// A numeric scalar property (`D`, `F`, `I`, `L`, `Y`, `C`).
fn scalar(p: &FbxProperty) -> Option<f64> {
    let b = p.raw.get(1..)?;
    Some(match p.type_code {
        b'D' => LE::read_f64(b),
        b'F' => LE::read_f32(b) as f64,
        b'I' => LE::read_i32(b) as f64,
        b'L' => LE::read_i64(b) as f64,
        b'Y' => LE::read_i16(b) as f64,
        b'C' => b[0] as f64,
        _ => return None,
    })
}

fn prop_str(n: &FbxNode, i: usize) -> Option<String> {
    let v = n.props.get(i)?.value.as_ref()?;
    // Binary names are `Name\0\x01Class`.
    let name = v.split(|&b| b == 0).next().unwrap_or(v);
    Some(String::from_utf8_lossy(name).into_owned())
}

fn is_mesh_object(n: &FbxNode) -> bool {
    prop_str(n, 2).as_deref() == Some("Mesh")
}

fn axis_name(axis: i64, sign: i64) -> String {
    let a = match axis {
        0 => "X",
        1 => "Y",
        _ => "Z",
    };
    format!("{}{a}", if sign < 0 { "-" } else { "+" })
}

fn fbx_binary_stats(path: &Path, data: &[u8]) -> Result<MeshStats, String> {
    let doc = parse_binary(data).map_err(|e| e.to_string())?;
    let mut s = MeshStats::new(path, "fbx-binary");
    if let Some(props) = doc.nodes.iter().find(|n| n.is("GlobalSettings")).and_then(|g| g.child("Properties70")) {
        let get = |name: &str| props.children.iter().find(|p| prop_str(p, 0).as_deref() == Some(name)).and_then(|p| p.props.get(4)).and_then(scalar);
        s.unit_scale_cm = get("UnitScaleFactor");
        if let Some(axis) = get("UpAxis") {
            s.up_axis = Some(axis_name(axis as i64, get("UpAxisSign").unwrap_or(1.0) as i64));
        }
    }
    let Some(objects) = doc.nodes.iter().find(|n| n.is("Objects")) else { return Ok(s) };
    s.materials = objects.children.iter().filter(|n| n.is("Material")).count();
    let mut all_normals = true;
    for geo in objects.children.iter().filter(|n| n.is("Geometry") && is_mesh_object(n)) {
        s.meshes += 1;
        if let Some(v) = geo.child("Vertices").and_then(|n| n.props.first()) {
            let coords = array_values(v)?;
            s.vertices += (coords.len() / 3) as u64;
            let b = bounds_of(&coords);
            s.add_bounds(&b);
        }
        if let Some(idx) = geo.child("PolygonVertexIndex").and_then(|n| n.props.first()) {
            let (t, p) = count_polygons(array_values(idx)?.into_iter().map(|v| v as i64));
            s.triangles += t;
            s.polygons += p;
        }
        s.uv_sets = s.uv_sets.max(geo.children.iter().filter(|c| c.is("LayerElementUV")).count());
        all_normals &= geo.child("LayerElementNormal").is_some();
    }
    s.has_normals = s.meshes > 0 && all_normals;
    Ok(s)
}

// --------------------------------------------------------------------------- FBX ASCII

static NUM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?").unwrap());
static P_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^P:\s*"(UnitScaleFactor|UpAxis|UpAxisSign)",.*,\s*(-?[\d.eE+-]+)\s*$"#).unwrap());

#[derive(PartialEq)]
enum Collect {
    None,
    Vertices,
    Indices,
}

fn fbx_ascii_stats(path: &Path, text: &str) -> MeshStats {
    let mut s = MeshStats::new(path, "fbx-ascii");
    let (mut up, mut up_sign) = (None, 1.0);
    let mut collect = Collect::None;
    let mut values: Vec<f64> = Vec::new();
    let mut geo_uvs = 0usize;
    let mut in_geo = false;
    let mut all_normals = true;
    let mut geo_normals = false;
    let mut bounds = Bounds::empty();

    let mut finish_geo = |s: &mut MeshStats, uvs: usize, normals: bool| {
        s.uv_sets = s.uv_sets.max(uvs);
        all_normals &= normals;
    };
    for line in text.lines() {
        let t = line.trim();
        if collect != Collect::None {
            let body = t.strip_prefix("a:").unwrap_or(t);
            values.extend(NUM_RE.find_iter(body).filter_map(|m| m.as_str().parse::<f64>().ok()));
            if t.contains('}') {
                match collect {
                    Collect::Vertices => {
                        s.vertices += (values.len() / 3) as u64;
                        bounds.merge(&bounds_of(&values));
                    }
                    Collect::Indices => {
                        let (tr, p) = count_polygons(values.iter().map(|&v| v as i64));
                        s.triangles += tr;
                        s.polygons += p;
                    }
                    Collect::None => {}
                }
                values.clear();
                collect = Collect::None;
            }
            continue;
        }
        if t.starts_with("Geometry:") && t.contains("\"Mesh\"") {
            if in_geo {
                finish_geo(&mut s, geo_uvs, geo_normals);
            }
            in_geo = true;
            s.meshes += 1;
            geo_uvs = 0;
            geo_normals = false;
        } else if t.starts_with("Vertices:") && t.contains('*') {
            collect = Collect::Vertices;
        } else if t.starts_with("PolygonVertexIndex:") && t.contains('*') {
            collect = Collect::Indices;
        } else if t.starts_with("LayerElementUV:") {
            geo_uvs += 1;
        } else if t.starts_with("LayerElementNormal:") {
            geo_normals = true;
        } else if t.starts_with("Material:") {
            s.materials += 1;
        } else if let Some(c) = P_RE.captures(t) {
            let v: f64 = c[2].parse().unwrap_or(0.0);
            match &c[1] {
                "UnitScaleFactor" => s.unit_scale_cm = Some(v),
                "UpAxis" => up = Some(v as i64),
                _ => up_sign = v,
            }
        }
    }
    if in_geo {
        finish_geo(&mut s, geo_uvs, geo_normals);
    }
    s.has_normals = s.meshes > 0 && all_normals;
    s.add_bounds(&bounds);
    s.up_axis = up.map(|a| axis_name(a, up_sign as i64));
    s
}

// --------------------------------------------------------------------------- OBJ

fn obj_stats(path: &Path) -> Result<MeshStats, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut s = MeshStats::new(path, "obj");
    let (mut uvs, mut normals) = (0u64, 0u64);
    let mut objects = 0usize;
    let mut materials = HashSet::new();
    let mut b = Bounds::empty();
    let mut buf = Vec::new();
    let mut reader = BufReader::new(file);
    while reader.read_until(b'\n', &mut buf).map_err(|e| e.to_string())? > 0 {
        let line = String::from_utf8_lossy(&buf);
        let mut it = line.split_whitespace();
        match it.next() {
            Some("v") => {
                s.vertices += 1;
                let c: Vec<f64> = it.take(3).filter_map(|v| v.parse().ok()).collect();
                if c.len() == 3 {
                    b.add([c[0], c[1], c[2]]);
                }
            }
            Some("vt") => uvs += 1,
            Some("vn") => normals += 1,
            Some("f") => {
                let n = it.count() as u64;
                s.polygons += 1;
                s.triangles += n.saturating_sub(2);
            }
            Some("o") | Some("g") => objects += 1,
            Some("usemtl") => {
                materials.insert(it.collect::<Vec<_>>().join(" "));
            }
            _ => {}
        }
        buf.clear();
    }
    s.meshes = objects.max(usize::from(s.vertices > 0));
    s.materials = materials.len();
    s.uv_sets = usize::from(uvs > 0);
    s.has_normals = normals > 0;
    s.add_bounds(&b);
    // OBJ carries no units; Y-up is the de-facto convention.
    s.up_axis = Some("+Y".into());
    Ok(s)
}

// --------------------------------------------------------------------------- glTF

fn gltf_stats(path: &Path, json: &serde_json::Value, format: &str) -> MeshStats {
    let mut s = MeshStats::new(path, format);
    let accessors = json.get("accessors").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let acc = |i: &serde_json::Value| i.as_u64().and_then(|i| accessors.get(i as usize));
    let count = |a: &serde_json::Value| a.get("count").and_then(|c| c.as_u64()).unwrap_or(0);
    let vec3 = |a: &serde_json::Value, k: &str| -> Option<[f64; 3]> {
        let v = a.get(k)?.as_array()?;
        Some([v.first()?.as_f64()?, v.get(1)?.as_f64()?, v.get(2)?.as_f64()?])
    };
    let meshes = json.get("meshes").and_then(|m| m.as_array()).cloned().unwrap_or_default();
    s.meshes = meshes.len();
    s.materials = json.get("materials").and_then(|m| m.as_array()).map_or(0, Vec::len);
    let mut all_normals = !meshes.is_empty();
    for mesh in &meshes {
        for prim in mesh.get("primitives").and_then(|p| p.as_array()).into_iter().flatten() {
            let attrs = prim.get("attributes");
            let Some(pos) = attrs.and_then(|a| a.get("POSITION")).and_then(acc) else { continue };
            let verts = count(pos);
            s.vertices += verts;
            if let (Some(min), Some(max)) = (vec3(pos, "min"), vec3(pos, "max")) {
                s.add_bounds(&Bounds { min, max });
            }
            let uv_sets = attrs.and_then(|a| a.as_object()).map_or(0, |o| o.keys().filter(|k| k.starts_with("TEXCOORD_")).count());
            s.uv_sets = s.uv_sets.max(uv_sets);
            all_normals &= attrs.and_then(|a| a.get("NORMAL")).is_some();
            let n = prim.get("indices").and_then(acc).map(count).unwrap_or(verts);
            let tris = match prim.get("mode").and_then(|m| m.as_u64()).unwrap_or(4) {
                4 => n / 3,
                5 | 6 => n.saturating_sub(2),
                _ => 0,
            };
            s.triangles += tris;
            s.polygons += tris;
        }
    }
    s.has_normals = all_normals;
    s.unit_scale_cm = Some(100.0);
    s.up_axis = Some("+Y".into());
    s
}

// --------------------------------------------------------------------------- entry points

fn analyse(path: &Path) -> Result<MeshStats, String> {
    match ext_lower(path).as_str() {
        "fbx" => {
            let data = fs::read(path).map_err(|e| e.to_string())?;
            if is_binary(&data) {
                fbx_binary_stats(path, &data)
            } else {
                Ok(fbx_ascii_stats(path, &String::from_utf8_lossy(&data)))
            }
        }
        "obj" => obj_stats(path),
        "gltf" => {
            let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
            let json = serde_json::from_str(&text).map_err(|e| format!("Invalid glTF JSON: {e}"))?;
            Ok(gltf_stats(path, &json, "gltf"))
        }
        "glb" => {
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let json = glb_json(&data).ok_or("Not a valid GLB file")?;
            Ok(gltf_stats(path, &json, "glb"))
        }
        e => Err(format!("Unsupported mesh format .{e}")),
    }
}

fn add_warnings(s: &mut MeshStats, tri_budget: Option<u64>) {
    if s.meshes == 0 || s.vertices == 0 {
        s.warnings.push("No mesh geometry found".into());
        return;
    }
    if s.uv_sets == 0 {
        s.warnings.push("No UV set: textures and lightmaps cannot be mapped".into());
    }
    if !s.has_normals {
        s.warnings.push("Missing normals on some meshes: the engine will compute them".into());
    }
    if let Some(budget) = tri_budget.filter(|&b| b > 0 && s.triangles > b) {
        s.warnings.push(format!("{} triangles, over the {budget} budget", s.triangles));
    }
    if let Some(u) = s.unit_scale_cm.filter(|u| ![1.0, 100.0].iter().any(|k| (u - k).abs() < 1e-6)) {
        s.warnings.push(format!("Unusual unit scale: 1 unit = {u} cm"));
    }
    if let Some(b) = s.bounds {
        let unit_cm = s.unit_scale_cm.unwrap_or(1.0);
        let largest_cm = b.size().into_iter().fold(0.0f64, f64::max) * unit_cm;
        if largest_cm > 1_000_000.0 {
            s.warnings.push(format!("Very large: {:.0} m across, check the export scale", largest_cm / 100.0));
        } else if largest_cm > 0.0 && largest_cm < 0.1 {
            s.warnings.push(format!("Very small: {largest_cm:.3} cm across, check the export scale"));
        }
    }
}

pub fn inspect_mesh(path: &Path, tri_budget: Option<u64>) -> MeshStats {
    match analyse(path) {
        Ok(mut s) => {
            add_warnings(&mut s, tri_budget);
            s
        }
        Err(e) => MeshStats::failed(path, e),
    }
}

pub fn inspect_meshes(paths: &[PathBuf], tri_budget: Option<u64>) -> Vec<MeshStats> {
    paths.par_iter().map(|p| inspect_mesh(p, tri_budget)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fbx::node::{FbxBinaryDocument, FbxProperty};
    use crate::core::fbx::test_support::make_footer;
    use crate::core::fbx::writer::serialize_binary;
    use std::io::Write;

    fn node(name: &str, props: Vec<FbxProperty>, children: Vec<FbxNode>) -> FbxNode {
        FbxNode { name: name.as_bytes().to_vec(), props, has_nested: !children.is_empty(), children }
    }
    fn s(text: &str) -> FbxProperty {
        FbxProperty::string(text.as_bytes(), b'S')
    }
    fn prim(code: u8, bytes: &[u8]) -> FbxProperty {
        let mut raw = vec![code];
        raw.extend_from_slice(bytes);
        FbxProperty { type_code: code, raw, value: None }
    }
    fn array(code: u8, elems: &[u8], count: usize, compress: bool) -> FbxProperty {
        let payload = if compress {
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(elems).unwrap();
            e.finish().unwrap()
        } else {
            elems.to_vec()
        };
        let mut raw = vec![code];
        raw.extend((count as u32).to_le_bytes());
        raw.extend((compress as u32).to_le_bytes());
        raw.extend((payload.len() as u32).to_le_bytes());
        raw.extend(payload);
        FbxProperty { type_code: code, raw, value: None }
    }

    /// One cube-ish quad mesh: 4 vertices, 1 quad + 1 triangle.
    fn binary_fbx(path: &Path, compress: bool) {
        let verts: Vec<u8> = [0.0f64, 0.0, 0.0, 200.0, 0.0, 0.0, 200.0, 50.0, 0.0, 0.0, 50.0, 10.0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let idx: Vec<u8> = [0i32, 1, 2, -4, 0, 2, -4].iter().flat_map(|v| v.to_le_bytes()).collect();
        let geo = node(
            "Geometry",
            vec![prim(b'L', &1i64.to_le_bytes()), s("Plane\x00\x01Geometry"), s("Mesh")],
            vec![
                node("Vertices", vec![array(b'd', &verts, 12, compress)], vec![]),
                node("PolygonVertexIndex", vec![array(b'i', &idx, 7, compress)], vec![]),
                node("LayerElementNormal", vec![prim(b'I', &0i32.to_le_bytes())], vec![]),
                node("LayerElementUV", vec![prim(b'I', &0i32.to_le_bytes())], vec![]),
                node("LayerElementUV", vec![prim(b'I', &1i32.to_le_bytes())], vec![]),
            ],
        );
        let p70 = |name: &str, v: FbxProperty| node("P", vec![s(name), s("double"), s("Number"), s(""), v], vec![]);
        let settings = node(
            "GlobalSettings",
            vec![],
            vec![node("Properties70", vec![], vec![p70("UpAxis", prim(b'I', &2i32.to_le_bytes())), p70("UnitScaleFactor", prim(b'D', &1f64.to_le_bytes()))])],
        );
        let objects = node("Objects", vec![], vec![geo, node("Material", vec![s("Mat")], vec![])]);
        let mut doc = FbxBinaryDocument { version: 7400, nodes: vec![settings, objects], footer: vec![] };
        let body = serialize_binary(&doc, None);
        doc.footer = make_footer(body.len(), 7400);
        fs::write(path, serialize_binary(&doc, None)).unwrap();
    }

    #[test]
    fn fbx_binary_counts() {
        let dir = tempfile::tempdir().unwrap();
        for compress in [false, true] {
            let p = dir.path().join(format!("m{compress}.fbx"));
            binary_fbx(&p, compress);
            let st = inspect_mesh(&p, Some(1));
            assert!(st.error.is_none(), "{:?}", st.error);
            assert_eq!((st.format.as_str(), st.meshes, st.vertices, st.triangles, st.polygons), ("fbx-binary", 1, 4, 3, 2));
            assert_eq!((st.uv_sets, st.materials, st.has_normals), (2, 1, true));
            assert_eq!(st.bounds.unwrap().size(), [200.0, 50.0, 10.0]);
            assert_eq!((st.unit_scale_cm, st.up_axis.as_deref()), (Some(1.0), Some("+Z")));
            assert!(st.warnings.iter().any(|w| w.contains("budget")), "{:?}", st.warnings);
        }
    }

    #[test]
    fn fbx_ascii_counts() {
        let text = r#"; FBX 7.4.0 project file
GlobalSettings:  {
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",2.54
	}
}
Objects:  {
	Geometry: 1, "Geometry::Box", "Mesh" {
		Vertices: *9 {
			a: 0,0,0,1,0,0,
1,1,-5
		}
		PolygonVertexIndex: *3 {
			a: 0,1,-3
		}
		LayerElementUV: 0 {
		}
	}
	Material: 2, "Material::m", "" {
	}
}
"#;
        let st = fbx_ascii_stats(Path::new("a.fbx"), text);
        assert_eq!((st.meshes, st.vertices, st.triangles, st.polygons, st.uv_sets, st.materials), (1, 3, 1, 1, 1, 1));
        assert!(!st.has_normals);
        assert_eq!(st.bounds.unwrap().min, [0.0, 0.0, -5.0]);
        assert_eq!((st.unit_scale_cm, st.up_axis.as_deref()), (Some(2.54), Some("+Y")));
    }

    #[test]
    fn obj_and_gltf() {
        let dir = tempfile::tempdir().unwrap();
        let obj = dir.path().join("a.obj");
        fs::write(&obj, "o A\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nusemtl wood\nf 1/1/1 2/1/1 3/1/1 4/1/1\nusemtl wood\n").unwrap();
        let st = inspect_mesh(&obj, None);
        assert_eq!((st.meshes, st.vertices, st.triangles, st.polygons, st.materials, st.uv_sets, st.has_normals), (1, 4, 2, 1, 1, 1, true));

        let gltf = dir.path().join("a.gltf");
        fs::write(
            &gltf,
            r#"{"accessors":[{"count":24,"min":[-1,-1,-1],"max":[1,1,1]},{"count":36}],
               "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":0,"TEXCOORD_0":0},"indices":1}]}],"materials":[{}]}"#,
        )
        .unwrap();
        let st = inspect_mesh(&gltf, None);
        assert_eq!((st.meshes, st.vertices, st.triangles, st.uv_sets, st.materials, st.has_normals), (1, 24, 12, 1, 1, true));
        assert_eq!(st.bounds.unwrap().size(), [2.0, 2.0, 2.0]);
        assert!(st.warnings.is_empty(), "{:?}", st.warnings);

        let bad = dir.path().join("b.gltf");
        fs::write(&bad, "{").unwrap();
        assert!(inspect_mesh(&bad, None).error.is_some());
    }
}
