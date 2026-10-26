import struct
import subprocess

import pytest
from conftest import build_ascii_fbx, build_binary_fbx

from core import fbx_doctor as fd


@pytest.mark.parametrize("value, kind", [
    (r"C:\Users\John\wood.png", fd.PathKind.ABSOLUTE_LOCAL),
    ("D:/assets/wood.png", fd.PathKind.ABSOLUTE_LOCAL),
    ("/home/john/wood.png", fd.PathKind.ABSOLUTE_LOCAL),
    (r"\\server\share\wood.png", fd.PathKind.UNC_NETWORK),
    (r"textures\wood.png", fd.PathKind.RELATIVE_PORTABLE),
    ("./wood.png", fd.PathKind.RELATIVE_PORTABLE),
    ("", fd.PathKind.EMPTY),
])
def test_classify(value, kind):
    assert fd.classify_path(value) is kind


@pytest.mark.parametrize("version", [7400, 7500])
def test_binary_roundtrip_and_scan(tmp_path, version):
    fbx = build_binary_fbx(tmp_path / "m.fbx", r"C:\Users\John\Textures\wood.png", version)
    data = fbx.read_bytes()
    doc = fd.parse_binary(data)
    assert doc.version == version
    assert fd.serialize_binary(doc, len(data) - len(doc.footer)) == data

    res = fd.scan_fbx(fbx)
    assert res.format == "binary"
    assert {r.field for r in res.references} == {"P:Path", "Filename", "RelativeFilename", "FileName"}
    assert all(r.kind is fd.PathKind.ABSOLUTE_LOCAL and r.resolution == "missing" for r in res.references)
    assert {r.owner for r in res.references} == {"Video::wood", "Texture::wood"}


@pytest.mark.parametrize("version", [7400, 7500])
def test_binary_fix_rewrites_offsets_and_footer(tmp_path, version):
    (tmp_path / "textures").mkdir()
    (tmp_path / "textures" / "wood.png").write_bytes(b"png")
    fbx = build_binary_fbx(tmp_path / "m.fbx", r"C:\Users\Someone\Very\Long\Path\To\Textures\wood.png", version)
    original = fbx.read_bytes()

    rep = fd.fix_fbx(fbx, fd.FixMode.RELATIVE)
    assert rep.written and len(rep.changes) == 5
    assert {c.new for c in rep.changes} == {"textures/wood.png"}  # found by name next to the FBX
    assert (tmp_path / "m.fbx.bak").read_bytes() == original

    data = fbx.read_bytes()
    doc = fd.parse_binary(data)  # parses => every end-offset is consistent
    footer = doc.footer
    pad = len(footer) - 20 - 140
    body_end = len(data) - len(footer)
    assert (body_end + 20 + pad) % 16 == 0  # footer alignment recomputed
    assert footer[-140:-136] == struct.pack("<I", version)
    res = fd.scan_fbx(fbx)
    assert not res.problems and all(r.resolution == "found" for r in res.references)


def test_fix_modes(tmp_path):
    src_tex = tmp_path / "elsewhere" / "wood.png"
    src_tex.parent.mkdir()
    src_tex.write_bytes(b"png-data")
    model_dir = tmp_path / "model"
    model_dir.mkdir()

    fbx = build_binary_fbx(model_dir / "strip.fbx", str(src_tex))
    rep = fd.fix_fbx(fbx, "strip")
    assert {c.new for c in rep.changes} == {"wood.png"}

    fbx = build_binary_fbx(model_dir / "rel.fbx", str(src_tex))
    rep = fd.fix_fbx(fbx, "relative")
    assert {c.new for c in rep.changes} == {"../elsewhere/wood.png"}
    assert all(r.resolution == "found" for r in fd.scan_fbx(fbx).references)

    fbx = build_binary_fbx(model_dir / "col.fbx", str(src_tex))
    rep = fd.fix_fbx(fbx, "collect", subfolder="tex")
    assert {c.new for c in rep.changes} == {"tex/wood.png"}
    assert (model_dir / "tex" / "wood.png").read_bytes() == b"png-data"

    fbx = build_binary_fbx(model_dir / "dry.fbx", str(src_tex))
    before = fbx.read_bytes()
    rep = fd.fix_fbx(fbx, "strip", dry_run=True)
    assert rep.changes and not rep.written and fbx.read_bytes() == before


def test_missing_texture_warns(tmp_path):
    fbx = build_binary_fbx(tmp_path / "m.fbx", r"Z:\nowhere\ghost.png")
    rep = fd.fix_fbx(fbx, "relative")
    assert {c.new for c in rep.changes} == {"textures/ghost.png"}
    assert any("missing" in w for w in rep.warnings)


def test_embedded_media_detected(tmp_path):
    fbx = build_binary_fbx(tmp_path / "m.fbx", r"C:\x\wood.png", embed=b"\x89PNG fake")
    refs = fd.scan_fbx(fbx).references
    video_refs = [r for r in refs if r.owner == "Video::wood"]
    assert video_refs and all(r.embedded and r.resolution == "embedded" for r in video_refs)


def test_ascii_scan_and_fix(tmp_path):
    (tmp_path / "wood.png").write_bytes(b"png")
    fbx = build_ascii_fbx(tmp_path / "a.fbx")
    res = fd.scan_fbx(fbx)
    assert res.format == "ascii" and res.version == 7400
    fields = [(r.owner, r.field) for r in res.references]
    assert ("Video::wood", "P:Path") in fields and ("Texture::wood", "RelativeFilename") in fields
    assert not any(r.owner.startswith("Model") for r in res.references)
    # "wood.png" relative entry is fine; the absolute and broken-relative ones are problems
    assert len(res.problems) == 4

    rep = fd.fix_fbx(fbx, "relative")
    assert len(rep.changes) == 4 and {c.new for c in rep.changes} == {"wood.png"}
    raw = fbx.read_bytes()
    assert b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"")  # line endings preserved
    text = raw.decode("utf-8").replace("\r\n", "\n")
    assert "C:\\Users" not in text
    assert 'P: "Path", "KString", "XRefUrl", "", "wood.png"' in text
    assert not fd.scan_fbx(fbx).problems


def test_restore_backup(tmp_path):
    fbx = build_binary_fbx(tmp_path / "m.fbx", r"C:\x\wood.png")
    original = fbx.read_bytes()
    fd.fix_fbx(fbx, "strip")
    assert fbx.read_bytes() != original
    assert fd.restore_backup(fbx)
    assert fbx.read_bytes() == original


def test_not_an_fbx(tmp_path):
    p = tmp_path / "x.fbx"
    p.write_text("hello")
    with pytest.raises(fd.FbxError):
        fd.scan_fbx(p)


# --------------------------------------------------------------------------- real Blender files


def test_blender_export_roundtrip(blender_fixtures):
    data = blender_fixtures["fbx"].read_bytes()
    doc = fd.parse_binary(data)
    assert fd.serialize_binary(doc, len(data) - len(doc.footer)) == data
    res = fd.scan_fbx(blender_fixtures["fbx"])
    assert res.references and all(r.kind is fd.PathKind.ABSOLUTE_LOCAL for r in res.references)
    assert all(r.resolution == "found" for r in res.references)


def test_fixed_fbx_imports_in_blender(blender, blender_fixtures, tmp_path):
    """The rewritten file must still be a valid FBX for a real importer, with a portable texture path."""
    import shutil

    work = tmp_path / "portable"
    work.mkdir()
    fbx = work / "crate.fbx"
    shutil.copy2(blender_fixtures["fbx"], fbx)
    rep = fd.fix_fbx(fbx, "collect")
    assert rep.written and (work / "textures" / "crate_diffuse.png").exists()

    script = (
        "import bpy, sys\n"
        "bpy.ops.wm.read_factory_settings(use_empty=True)\n"
        f"bpy.ops.import_scene.fbx(filepath={str(fbx)!r})\n"
        "imgs = [i for i in bpy.data.images if i.source == 'FILE']\n"
        "print('IMPORT_RESULT', len(bpy.data.meshes), [bpy.path.abspath(i.filepath) for i in imgs], "
        "[i.has_data or i.size[0] > 0 for i in imgs])\n"
    )
    proc = subprocess.run(
        [str(blender.executable), "-b", "--factory-startup", "--python-expr", script],
        capture_output=True, text=True, timeout=300,
    )
    line = next((l for l in proc.stdout.splitlines() if l.startswith("IMPORT_RESULT")), None)
    assert line, proc.stdout + proc.stderr
    assert "IMPORT_RESULT 1" in line
    assert "portable" in line and "crate_diffuse.png" in line and "True" in line
