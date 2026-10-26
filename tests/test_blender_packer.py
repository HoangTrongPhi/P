import shutil
import zipfile

from core import blender_packer as bp


def test_discovery(blender):
    assert blender.supported and blender.executable.is_file()
    assert bp.probe_version(str(blender.executable)) == blender.version


def test_options_to_args(tmp_path):
    args = bp.PackOptions(consolidate=True, make_relative=True, pack_all=True, output=tmp_path / "o.blend").to_args()
    assert args[:3] == ["--consolidate", "--relative", "--pack"] and args[-2] == "--output"


def test_analyse_only_reports_absolute_dependency(blender, blender_fixtures, tmp_path):
    blend = tmp_path / "crate.blend"
    shutil.copy2(blender_fixtures["blend"], blend)
    before = blend.read_bytes()
    res = bp.run_pack(blender, blend, bp.PackOptions(consolidate=False, make_relative=False, analyse_only=True))
    assert res.ok, res.error
    deps = res.report["after"]
    assert len(deps) == 1 and deps[0]["exists"] and not deps[0]["relative"]
    assert blend.read_bytes() == before


def test_consolidate_to_new_location(blender, blender_fixtures, tmp_path):
    out = tmp_path / "packed" / "crate.blend"
    progress = []
    res = bp.run_pack(blender, blender_fixtures["blend"], bp.PackOptions(output=out, zip_archive=tmp_path / "c.zip"),
                      on_progress=lambda d, t, m: progress.append((d, t)))
    assert res.ok, res.error
    assert progress[-1][0] == progress[-1][1]
    dep = res.report["after"][0]
    assert dep["relative"] and dep["exists"] and dep["filepath"].replace("\\", "/") == "//textures/crate_diffuse.png"
    assert (out.parent / "textures" / "crate_diffuse.png").exists()
    assert not (out.parent / "crate.blend1").exists()
    assert sorted(zipfile.ZipFile(res.archive).namelist()) == ["crate.blend", "textures/crate_diffuse.png"]


def test_pack_all_in_place(blender, blender_fixtures, tmp_path):
    blend = tmp_path / "crate.blend"
    shutil.copy2(blender_fixtures["blend"], blend)
    res = bp.run_pack(blender, blend, bp.PackOptions(consolidate=False, pack_all=True))
    assert res.ok, res.error
    assert res.report["after"][0]["packed"]
    assert (tmp_path / "crate.blend1").exists()  # Blender's own backup of the original


def test_missing_file_reported(blender, blender_fixtures, tmp_path):
    work = tmp_path / "w"
    work.mkdir()
    blend = work / "crate.blend"
    shutil.copy2(blender_fixtures["blend"], blend)
    # Point the image somewhere that does not exist by relocating the texture folder copy.
    script_res = bp.run_pack(blender, blend, bp.PackOptions(consolidate=True, make_relative=True))
    assert script_res.ok
    shutil.rmtree(work / "textures")
    res = bp.run_pack(blender, blend, bp.PackOptions(consolidate=False, make_relative=False, analyse_only=True))
    assert res.ok and len(res.missing) == 1 and res.missing[0]["name"] == "crate_diffuse"
