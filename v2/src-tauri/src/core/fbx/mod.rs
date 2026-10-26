//! Pure Rust FBX path doctor: binary 7.x / ASCII parsing, byte-exact rewriting and path fixing.

pub mod doctor;
pub mod node;
pub mod reader;
pub mod writer;

pub use doctor::{fix_fbx, restore_backup, scan_fbx, FbxFileInfo, FixMode, FixOptions, FixReport, PathKind};
pub use node::{FbxError, FbxResult};

/// Builders for structurally valid synthetic FBX files (mirrors `tests/conftest.py`).
#[cfg(test)]
pub mod test_support {
    use super::node::*;
    use super::writer::serialize_binary;
    use std::path::{Path, PathBuf};

    pub const FOOTER_MAGIC: [u8; 16] = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

    fn prim(code: u8, bytes: &[u8]) -> FbxProperty {
        let mut raw = vec![code];
        raw.extend_from_slice(bytes);
        FbxProperty { type_code: code, raw, value: None }
    }

    fn s(text: &str) -> FbxProperty {
        FbxProperty::string(text.as_bytes(), b'S')
    }

    fn node(name: &str, props: Vec<FbxProperty>, children: Vec<FbxNode>) -> FbxNode {
        FbxNode { name: name.as_bytes().to_vec(), props, has_nested: !children.is_empty(), children }
    }

    pub fn make_footer(body_len: usize, version: u32) -> Vec<u8> {
        let ofs = body_len + 20;
        let pad = match ((ofs + 15) & !15) - ofs {
            0 => 16,
            p => p,
        };
        let mut f: Vec<u8> = (0u8..16).collect();
        f.extend(std::iter::repeat_n(0u8, 4 + pad));
        f.extend_from_slice(&version.to_le_bytes());
        f.extend(std::iter::repeat_n(0u8, 120));
        f.extend_from_slice(&FOOTER_MAGIC);
        f
    }

    /// Minimal binary FBX with a Video + Texture pointing at `texture_path`.
    pub fn build_binary_fbx(path: &Path, texture_path: &str, version: u32, embed: &[u8]) -> PathBuf {
        let mut video_children = vec![
            node("Type", vec![s("Clip")], vec![]),
            node("Properties70", vec![], vec![node("P", vec![s("Path"), s("KString"), s("XRefUrl"), s(""), s(texture_path)], vec![])]),
            node("UseMipMap", vec![prim(b'I', &0i32.to_le_bytes())], vec![]),
            node("Filename", vec![s(texture_path)], vec![]),
            node("RelativeFilename", vec![s(texture_path)], vec![]),
        ];
        if !embed.is_empty() {
            video_children.push(node("Content", vec![FbxProperty::string(embed, b'R')], vec![]));
        }
        let objects = node(
            "Objects",
            vec![],
            vec![
                node("Video", vec![prim(b'L', &1001i64.to_le_bytes()), s("wood\x00\x01Video"), s("Clip")], video_children),
                node(
                    "Texture",
                    vec![prim(b'L', &1002i64.to_le_bytes()), s("wood\x00\x01Texture"), s("")],
                    vec![
                        node("Type", vec![s("TextureVideoClip")], vec![]),
                        node("FileName", vec![s(texture_path)], vec![]),
                        node("RelativeFilename", vec![s(texture_path)], vec![]),
                        node("ModelUVScaling", vec![prim(b'D', &1f64.to_le_bytes()), prim(b'D', &1f64.to_le_bytes())], vec![]),
                    ],
                ),
            ],
        );
        let header = node("FBXHeaderExtension", vec![], vec![node("FBXVersion", vec![prim(b'I', &(version as i32).to_le_bytes())], vec![])]);
        let mut doc = FbxBinaryDocument { version, nodes: vec![header, objects], footer: vec![] };
        let body = serialize_binary(&doc, None);
        doc.footer = make_footer(body.len(), version);
        std::fs::write(path, serialize_binary(&doc, None)).unwrap();
        path.to_path_buf()
    }

    pub const ASCII_FBX: &str = r#"; FBX 7.4.0 project file
; ----------------------------------------------------
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
Objects:  {
	Video: 123, "Video::wood", "Clip" {
		Type: "Clip"
		Properties70:  {
			P: "Path", "KString", "XRefUrl", "", "{abs}"
		}
		UseMipMap: 0
		Filename: "{abs}"
		RelativeFilename: "..\..\..\John\Textures\wood.png"
	}
	Texture: 456, "Texture::wood", "" {
		Type: "TextureVideoClip"
		FileName: "{abs}"
		RelativeFilename: "wood.png"
	}
	Model: 789, "Model::Cube", "Mesh" {
		Version: 232
	}
}
"#;

    /// ASCII FBX written with CRLF line endings.
    pub fn build_ascii_fbx(path: &Path, abs_path: &str) -> PathBuf {
        let text = ASCII_FBX.replace("{abs}", abs_path).replace('\n', "\r\n");
        std::fs::write(path, text).unwrap();
        path.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::doctor::*;
    use super::reader::parse_binary;
    use super::test_support::*;
    use super::writer::serialize_binary;
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;

    fn opts(mode: FixMode) -> FixOptions {
        FixOptions { mode, ..Default::default() }
    }

    fn new_values(rep: &FixReport) -> HashSet<String> {
        rep.changes.iter().map(|c| c.new.clone()).collect()
    }

    #[test]
    fn classify() {
        assert_eq!(classify_path(r"C:\Users\John\wood.png"), PathKind::AbsoluteLocal);
        assert_eq!(classify_path("D:/assets/wood.png"), PathKind::AbsoluteLocal);
        assert_eq!(classify_path("/home/john/wood.png"), PathKind::AbsoluteLocal);
        assert_eq!(classify_path(r"\\server\share\wood.png"), PathKind::UncNetwork);
        assert_eq!(classify_path(r"textures\wood.png"), PathKind::RelativePortable);
        assert_eq!(classify_path("./wood.png"), PathKind::RelativePortable);
        assert_eq!(classify_path(""), PathKind::Empty);
    }

    #[test]
    fn binary_roundtrip_and_scan() {
        for version in [7400, 7500] {
            let dir = tempfile::tempdir().unwrap();
            let fbx = build_binary_fbx(&dir.path().join("m.fbx"), r"C:\Users\John\Textures\wood.png", version, b"");
            let data = fs::read(&fbx).unwrap();
            let doc = parse_binary(&data).unwrap();
            assert_eq!(doc.version, version);
            assert_eq!(serialize_binary(&doc, Some(data.len() - doc.footer.len())), data);

            let info = scan_fbx(&fbx, &[]).unwrap();
            assert!(info.is_binary);
            let fields: HashSet<_> = info.entries.iter().map(|e| e.property_name.as_str()).collect();
            assert_eq!(fields, HashSet::from(["P:Path", "Filename", "RelativeFilename", "FileName"]));
            assert!(info.entries.iter().all(|e| e.kind == PathKind::AbsoluteLocal && e.resolution == Resolution::Missing));
            let owners: HashSet<_> = info.entries.iter().map(|e| e.node_name.as_str()).collect();
            assert_eq!(owners, HashSet::from(["Video::wood", "Texture::wood"]));
        }
    }

    #[test]
    fn binary_fix_rewrites_offsets_and_footer() {
        for version in [7400, 7500] {
            let dir = tempfile::tempdir().unwrap();
            fs::create_dir(dir.path().join("textures")).unwrap();
            fs::write(dir.path().join("textures").join("wood.png"), b"png").unwrap();
            let fbx = build_binary_fbx(&dir.path().join("m.fbx"), r"C:\Users\Someone\Very\Long\Path\To\Textures\wood.png", version, b"");
            let original = fs::read(&fbx).unwrap();

            let rep = fix_fbx(&fbx, &opts(FixMode::Relative)).unwrap();
            assert!(rep.written);
            assert_eq!(rep.changes.len(), 5);
            assert_eq!(new_values(&rep), HashSet::from(["textures/wood.png".to_string()]));
            assert_eq!(fs::read(dir.path().join("m.fbx.bak")).unwrap(), original);

            let data = fs::read(&fbx).unwrap();
            let doc = parse_binary(&data).unwrap(); // parses => every end offset is consistent
            let footer = &doc.footer;
            let pad = footer.len() - 20 - 140;
            let body_end = data.len() - footer.len();
            assert_eq!((body_end + 20 + pad) % 16, 0, "footer alignment recomputed");
            assert_eq!(&footer[footer.len() - 140..footer.len() - 136], &version.to_le_bytes());
            let info = scan_fbx(&fbx, &[]).unwrap();
            assert!(!info.has_issues && info.entries.iter().all(|e| e.resolution == Resolution::Found));
        }
    }

    #[test]
    fn fix_modes() {
        let dir = tempfile::tempdir().unwrap();
        let src_tex = dir.path().join("elsewhere").join("wood.png");
        fs::create_dir_all(src_tex.parent().unwrap()).unwrap();
        fs::write(&src_tex, b"png-data").unwrap();
        let model = dir.path().join("model");
        fs::create_dir(&model).unwrap();
        let tex = src_tex.to_string_lossy().into_owned();

        let fbx = build_binary_fbx(&model.join("strip.fbx"), &tex, 7400, b"");
        assert_eq!(new_values(&fix_fbx(&fbx, &opts(FixMode::Strip)).unwrap()), HashSet::from(["wood.png".into()]));

        let fbx = build_binary_fbx(&model.join("rel.fbx"), &tex, 7400, b"");
        assert_eq!(new_values(&fix_fbx(&fbx, &opts(FixMode::Relative)).unwrap()), HashSet::from(["../elsewhere/wood.png".into()]));
        assert!(scan_fbx(&fbx, &[]).unwrap().entries.iter().all(|e| e.resolution == Resolution::Found));

        let fbx = build_binary_fbx(&model.join("col.fbx"), &tex, 7400, b"");
        let rep = fix_fbx(&fbx, &FixOptions { subfolder: "tex".into(), ..opts(FixMode::Collect) }).unwrap();
        assert_eq!(new_values(&rep), HashSet::from(["tex/wood.png".into()]));
        assert_eq!(fs::read(model.join("tex").join("wood.png")).unwrap(), b"png-data");

        let fbx = build_binary_fbx(&model.join("dry.fbx"), &tex, 7400, b"");
        let before = fs::read(&fbx).unwrap();
        let rep = fix_fbx(&fbx, &FixOptions { dry_run: true, ..opts(FixMode::Strip) }).unwrap();
        assert!(!rep.changes.is_empty() && !rep.written);
        assert_eq!(fs::read(&fbx).unwrap(), before);
    }

    #[test]
    fn rebase_dir() {
        let dir = tempfile::tempdir().unwrap();
        let fbx = build_binary_fbx(&dir.path().join("m.fbx"), r"Z:\nowhere\wood.png", 7400, b"");
        let rebase = dir.path().join("shared").join("tex");
        let rep = fix_fbx(&fbx, &FixOptions { rebase_dir: Some(rebase), ..opts(FixMode::Relative) }).unwrap();
        assert_eq!(new_values(&rep), HashSet::from(["shared/tex/wood.png".into()]));
        assert!(rep.warnings.iter().any(|w| w.contains("not present")));
    }

    #[test]
    fn missing_texture_warns() {
        let dir = tempfile::tempdir().unwrap();
        let fbx = build_binary_fbx(&dir.path().join("m.fbx"), r"Z:\nowhere\ghost.png", 7400, b"");
        let rep = fix_fbx(&fbx, &opts(FixMode::Relative)).unwrap();
        assert_eq!(new_values(&rep), HashSet::from(["textures/ghost.png".into()]));
        assert!(rep.warnings.iter().any(|w| w.contains("missing")));
    }

    #[test]
    fn embedded_media_detected() {
        let dir = tempfile::tempdir().unwrap();
        let fbx = build_binary_fbx(&dir.path().join("m.fbx"), r"C:\x\wood.png", 7400, b"\x89PNG fake");
        let info = scan_fbx(&fbx, &[]).unwrap();
        let video: Vec<_> = info.entries.iter().filter(|e| e.node_name == "Video::wood").collect();
        assert!(!video.is_empty() && video.iter().all(|e| e.embedded && e.resolution == Resolution::Embedded));
    }

    #[test]
    fn ascii_scan_and_fix() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("wood.png"), b"png").unwrap();
        let fbx = build_ascii_fbx(&dir.path().join("a.fbx"), r"C:\Users\John\Textures\wood.png");
        let info = scan_fbx(&fbx, &[]).unwrap();
        assert!(!info.is_binary);
        assert_eq!(info.version, 7400);
        let fields: Vec<_> = info.entries.iter().map(|e| (e.node_name.as_str(), e.property_name.as_str())).collect();
        assert!(fields.contains(&("Video::wood", "P:Path")) && fields.contains(&("Texture::wood", "RelativeFilename")));
        assert!(!info.entries.iter().any(|e| e.node_name.starts_with("Model")));
        assert_eq!(info.problem_count, 4);

        let rep = fix_fbx(&fbx, &opts(FixMode::Relative)).unwrap();
        assert_eq!(rep.changes.len(), 4);
        assert_eq!(new_values(&rep), HashSet::from(["wood.png".into()]));
        let raw = fs::read(&fbx).unwrap();
        let text = String::from_utf8(raw.clone()).unwrap();
        assert!(text.contains("\r\n") && !text.replace("\r\n", "").contains('\n'), "line endings preserved");
        assert!(!text.contains(r"C:\Users"));
        assert!(text.contains(r#"P: "Path", "KString", "XRefUrl", "", "wood.png""#));
        assert!(!scan_fbx(&fbx, &[]).unwrap().has_issues);
    }

    #[test]
    fn ascii_roundtrip_is_identity() {
        let dir = tempfile::tempdir().unwrap();
        let fbx = build_ascii_fbx(&dir.path().join("a.fbx"), r"C:\x\wood.png");
        let data = fs::read(&fbx).unwrap();
        let doc = super::reader::parse_ascii(&data).unwrap();
        assert_eq!(doc.lines.concat(), data);
    }

    #[test]
    fn restore_from_backup() {
        let dir = tempfile::tempdir().unwrap();
        let fbx = build_binary_fbx(&dir.path().join("m.fbx"), r"C:\x\wood.png", 7400, b"");
        let original = fs::read(&fbx).unwrap();
        fix_fbx(&fbx, &opts(FixMode::Strip)).unwrap();
        assert_ne!(fs::read(&fbx).unwrap(), original);
        assert!(restore_backup(&fbx).unwrap());
        assert_eq!(fs::read(&fbx).unwrap(), original);
    }

    #[test]
    fn rejects_non_fbx_and_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.fbx");
        fs::write(&p, "hello").unwrap();
        assert!(scan_fbx(&p, &[]).is_err());

        let fbx = build_binary_fbx(&dir.path().join("t.fbx"), r"C:\x\wood.png", 7500, b"");
        let data = fs::read(&fbx).unwrap();
        fs::write(&fbx, &data[..data.len() / 2]).unwrap();
        assert!(scan_fbx(&fbx, &[]).is_err());
    }

    /// Byte parity over any real FBX files in `PP_FBX_FIXTURES` (a folder), when provided.
    #[test]
    fn external_fixture_parity() {
        let Ok(dir) = std::env::var("PP_FBX_FIXTURES") else { return };
        let mut checked = 0;
        for e in walkdir::WalkDir::new(Path::new(&dir)).into_iter().flatten() {
            if !e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("fbx")) {
                continue;
            }
            let data = fs::read(e.path()).unwrap();
            if super::reader::is_binary(&data) {
                let doc = parse_binary(&data).unwrap_or_else(|err| panic!("{}: {err}", e.path().display()));
                assert!(serialize_binary(&doc, Some(data.len() - doc.footer.len())) == data, "{} not byte-identical", e.path().display());
            } else {
                let doc = super::reader::parse_ascii(&data).unwrap();
                assert!(doc.lines.concat() == data);
            }
            checked += 1;
        }
        eprintln!("external_fixture_parity: {checked} file(s) byte-identical");
    }
}
