import json
import urllib.error
import urllib.request

import numpy as np
import pytest
from conftest import build_binary_fbx

from core import preview_service as ps
from core import scanner


@pytest.mark.parametrize("name, is_float, bits", [
    ("wood_planks_basecolor.png", False, 8), ("metal_plate_diff.jpg", False, 8), ("decal_alpha.tga", False, 8),
    ("ui_icon.dds", False, 8), ("sky_studio.hdr", True, 32), ("sky_studio.exr", True, 32),
    ("height_16bit.png", True, 16),
])
def test_load_texture_formats(samples, name, is_float, bits):
    tex = ps.load_texture(samples / "textures" / name)
    assert tex.pixels.shape == (256, 256, 4)
    assert tex.is_float is is_float
    assert tex.info["bit_depth"] == bits
    out = ps.render_texture(tex, 0.0, 2.2 if is_float else 1.0)
    assert out.dtype == np.uint8 and out.shape == (256, 256, 4)


def test_hdr_values_and_exposure(samples):
    tex = ps.load_texture(samples / "textures" / "sky_studio.exr")
    assert tex.pixels[..., :3].max() > 4.0  # real HDR range preserved
    bright = ps.render_texture(tex, 0.0, 2.2)
    dark = ps.render_texture(tex, -4.0, 2.2)
    assert dark[..., :3].mean() < bright[..., :3].mean()


def test_channel_modes(samples):
    tex = ps.load_texture(samples / "textures" / "decal_alpha.tga")
    alpha = ps.render_texture(tex, channel="alpha")
    assert (alpha[..., 0] == tex.pixels[..., 3]).all() and (alpha[..., 3] == 255).all()
    red = ps.render_texture(tex, channel="r")
    assert (red[..., 1] == tex.pixels[..., 0]).all()
    rgb = ps.render_texture(tex, channel="rgb")
    assert (rgb[..., 3] == 255).all()


def test_psd_layers(samples):
    doc = ps.PsdDocument(samples / "source" / "poster.psd")
    tree = doc.layer_tree()
    assert [n.name for n in tree] == ["Blue Square", "Red Square", "Background"]
    assert tuple(doc.composite()[64, 64][:3]) == (220, 60, 60)
    doc.set_visible(tree[1].layer_id, False)
    assert tuple(doc.composite()[64, 64][:3]) == (40, 44, 52)


def test_asset_server(tmp_path):
    (tmp_path / "model").mkdir()
    (tmp_path / "model" / "a.obj").write_text("v 0 0 0")
    (tmp_path / "model" / "sub").mkdir()
    (tmp_path / "model" / "sub" / "deep.png").write_bytes(b"deep")
    (tmp_path / "extra").mkdir()
    (tmp_path / "extra" / "far.png").write_bytes(b"far")
    (tmp_path / "secret.txt").write_text("nope")

    srv = ps.AssetServer().start()
    try:
        url = srv.url_for(tmp_path / "model" / "a.obj", [tmp_path / "extra"])
        base = url.rsplit("/", 1)[0]
        get = lambda u: urllib.request.urlopen(u, timeout=5).read()  # noqa: E731
        assert get(url) == b"v 0 0 0"
        assert get(base + "/textures/deep.png") == b"deep"   # broken relative path, found by name
        assert get(base + "/C%3A%5Cx%5Cfar.png") == b"far"   # absolute path baked in, extra dir
        assert b"importmap" in get(srv.viewer_url)
        for bad in (base + "/../secret.txt", base + "/%2E%2E/secret.txt", srv.base_url + "/fs/unknown/a.obj",
                    srv.base_url + "/web/../../core/preview_service.py"):
            with pytest.raises(urllib.error.HTTPError):
                get(bad)
    finally:
        srv.stop()


def test_duplicates_and_unused(tmp_path):
    (tmp_path / "tex").mkdir()
    for name, content in (("a.png", b"same"), ("b.png", b"same"), ("c.png", b"other"), ("used.tga", b"u"),
                          ("from_mtl.jpg", b"m"), ("from_gltf.png", b"g")):
        (tmp_path / "tex" / name).write_bytes(content)
    build_binary_fbx(tmp_path / "m.fbx", r"C:\far\away\used.tga")
    (tmp_path / "m.mtl").write_text("newmtl x\nmap_Kd -bm 1.0 tex\\from_mtl.jpg\n")
    (tmp_path / "m.gltf").write_text(json.dumps({"images": [{"uri": "tex/from_gltf.png"}, {"uri": "data:x"}]}))

    files = scanner.scan(tmp_path)
    dups = scanner.find_duplicates(files)
    assert [sorted(f.path.name for f in g) for g in dups] == [["a.png", "b.png"]]

    unused = sorted(f.path.name for f in scanner.find_unused_textures(tmp_path))
    assert unused == ["a.png", "b.png", "c.png"]
