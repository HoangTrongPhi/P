import struct
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))

from core import blender_packer, fbx_doctor as fd  # noqa: E402


@pytest.fixture(scope="session")
def blender():
    install = blender_packer.best_blender()
    if install is None:
        pytest.skip("Blender 5.0+ not installed")
    return install


@pytest.fixture(scope="session")
def blender_fixtures(blender, tmp_path_factory):
    """Real Blender-exported FBX / GLB / OBJ / .blend with an absolute external texture."""
    base = tmp_path_factory.mktemp("blender_fx")
    out, tex = base / "out", base / "ext_tex"
    script = ROOT / "tests" / "fixtures" / "blender_make_fixtures.py"
    proc = subprocess.run(
        [str(blender.executable), "-b", "--factory-startup", "-P", str(script), "--", str(out), str(tex)],
        capture_output=True, text=True, timeout=300,
    )
    assert "FIXTURES_OK" in proc.stdout, proc.stdout + proc.stderr
    return {"dir": out, "tex_dir": tex, "fbx": out / "crate_abs.fbx", "blend": out / "scene" / "crate.blend",
            "texture": tex / "crate_diffuse.png"}


@pytest.fixture(scope="session")
def samples(tmp_path_factory):
    import make_samples

    base = tmp_path_factory.mktemp("samples")
    make_samples.make_textures(base / "textures")
    (base / "source").mkdir()
    make_samples.make_psd(base / "source" / "poster.psd")
    return base


# --------------------------------------------------------------------------- synthetic FBX builders

FOOTER_ID = bytes(range(16))
FOOTER_MAGIC = b"\xf8\x5a\x8c\x6a\xde\xf5\xd9\x7e\xec\xe9\x0c\xe3\x75\x8f\x29\x0b"


def _prim(code: str, fmt: str, value) -> fd.FbxProperty:
    return fd.FbxProperty(code, code.encode() + struct.pack(fmt, value))


def _s(text: str) -> fd.FbxProperty:
    return fd.FbxProperty.string(text.encode("utf-8"))


def _node(name, props=(), children=()):
    return fd.FbxNode(name, list(props), list(children), has_nested=bool(children))


def make_footer(body_len: int, version: int) -> bytes:
    ofs = body_len + 20
    pad = ((ofs + 15) & ~15) - ofs or 16
    return FOOTER_ID + b"\x00" * 4 + b"\x00" * pad + struct.pack("<I", version) + b"\x00" * 120 + FOOTER_MAGIC


def build_binary_fbx(path: Path, texture_path: str, version: int = 7400, embed: bytes = b"") -> Path:
    """Minimal but structurally valid binary FBX with a Video + Texture pointing at ``texture_path``."""
    video_children = [
        _node("Type", [_s("Clip")]),
        _node("Properties70", children=[
            _node("P", [_s("Path"), _s("KString"), _s("XRefUrl"), _s(""), _s(texture_path)]),
        ]),
        _node("UseMipMap", [_prim("I", "<i", 0)]),
        _node("Filename", [_s(texture_path)]),
        _node("RelativeFilename", [_s(texture_path)]),
    ]
    if embed:
        video_children.append(_node("Content", [fd.FbxProperty.string(embed, "R")]))
    objects = _node("Objects", children=[
        _node("Video", [_prim("L", "<q", 1001), _s("wood\x00\x01Video"), _s("Clip")], video_children),
        _node("Texture", [_prim("L", "<q", 1002), _s("wood\x00\x01Texture"), _s("")], [
            _node("Type", [_s("TextureVideoClip")]),
            _node("FileName", [_s(texture_path)]),
            _node("RelativeFilename", [_s(texture_path)]),
            _node("ModelUVScaling", [_prim("D", "<d", 1.0), _prim("D", "<d", 1.0)]),
        ]),
    ])
    header = _node("FBXHeaderExtension", children=[_node("FBXVersion", [_prim("I", "<i", version)])])
    doc = fd.FbxBinaryDocument(version, [header, objects], b"")
    body = fd.serialize_binary(doc)
    doc.footer = make_footer(len(body), version)
    path.write_bytes(fd.serialize_binary(doc))
    return path


ASCII_FBX = r'''; FBX 7.4.0 project file
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
'''


def build_ascii_fbx(path: Path, abs_path: str = r"C:\Users\John\Textures\wood.png") -> Path:
    path.write_text(ASCII_FBX.replace("{abs}", abs_path), encoding="utf-8", newline="\r\n")
    return path
