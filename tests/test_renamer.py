from pathlib import Path

import pytest

from core import renamer as rn


def touch(folder: Path, *names: str) -> list[Path]:
    paths = []
    for n in names:
        p = folder / n
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(n)
        paths.append(p)
    return paths


@pytest.mark.parametrize("text, words", [
    ("brickWall_01-Normal", ["brick", "Wall", "01", "Normal"]),
    ("PBRTexture", ["PBR", "Texture"]),
    ("T_Wood_D", ["T", "Wood", "D"]),
])
def test_split_words(text, words):
    assert rn.split_words(text) == words


@pytest.mark.parametrize("style, expected", [
    ("snake", "rusty_metal_plate_02"), ("camel", "rustyMetalPlate02"), ("pascal", "RustyMetalPlate02"),
    ("upper", "RUSTY_METAL_PLATE_02"), ("kebab", "rusty-metal-plate-02"),
])
def test_convert_case(style, expected):
    assert rn.convert_case("Rusty metal-Plate_02", style) == expected


@pytest.mark.parametrize("name, expected", [
    ("wood_planks_basecolor.png", "T_WoodPlanks_D.png"),
    ("wood_planks_Base_Color.png", "T_WoodPlanks_D.png"),
    ("rock01_Roughness.tga", "T_Rock_01_R.tga"),
    ("metal-plate_nrm.png", "T_MetalPlate_N.png"),
    ("crate_ORM.png", "T_Crate_ORM.png"),
    ("T_Crate_D.png", "T_Crate_D.png"),          # already compliant
    ("chair.fbx", "SM_Chair.fbx"),
    ("hero_skel.fbx", "SK_Hero.fbx"),
    ("SM_Rock.obj", "SM_Rock.obj"),
    ("poster.psd", "T_Poster.psd"),
    ("level.blend", "level.blend"),              # scenes have no convention: untouched
])
def test_ue5_preset(name, expected):
    p = Path(name)
    assert rn.apply_rules(p.stem, p, [rn.PresetRule("ue5")]) + p.suffix == expected


@pytest.mark.parametrize("name, expected", [
    ("wood_planks_basecolor.png", "WoodPlanks_Albedo.png"),
    ("crate_arm.png", "Crate_MaskMap.png"),
    ("SM_chair.fbx", "Chair.fbx"),
])
def test_unity_preset(name, expected):
    p = Path(name)
    assert rn.apply_rules(p.stem, p, [rn.PresetRule("unity")]) + p.suffix == expected


def test_rule_pipeline_and_literal_replace():
    rules = [rn.SearchReplaceRule("old", r"new\1"), rn.PrefixRule("X_"), rn.SuffixRule("_v2")]
    assert rn.apply_rules("my_old_file", Path("a.png"), rules) == r"X_my_new\1_file_v2"
    regex = rn.SearchReplaceRule(r"(\d+)", r"<\1>", regex=True)
    assert regex.apply("lod12", Path("a")) == "lod<12>"
    insensitive = rn.SearchReplaceRule("TEX", "T", case_sensitive=False)
    assert insensitive.apply("tex_wood", Path("a")) == "T_wood"


def test_plan_statuses(tmp_path):
    a, b, c, d = touch(tmp_path, "a.png", "b.png", "taken.png", "keep.png")
    plan = {e.src.name: e for e in rn.build_plan([a, b, c, d], [
        rn.SearchReplaceRule("^(a|b)$", "same", regex=True),
        rn.SearchReplaceRule("keep", "kee/p"),
    ])}
    assert plan["a.png"].status is rn.Status.COLLISION and plan["b.png"].status is rn.Status.COLLISION
    assert plan["taken.png"].status is rn.Status.UNCHANGED
    assert plan["keep.png"].status is rn.Status.INVALID
    assert plan["keep.png"].new_name == "kee/p.png" and plan["keep.png"].dst == d

    (tmp_path / "x.png").write_text("x")
    plan = rn.build_plan([a], [rn.SearchReplaceRule("a", "x")])
    assert plan[0].status is rn.Status.COLLISION and "exists" in plan[0].message


def test_swap_and_undo(tmp_path):
    a, b = touch(tmp_path, "a.png", "b.png")
    hist = rn.RenameHistory(tmp_path)
    # a -> b and b -> a at the same time: needs the two-phase temp rename
    plan = [rn.RenameEntry(a, b), rn.RenameEntry(b, a)]
    rn.execute_plan(plan, hist)
    assert (tmp_path / "a.png").read_text() == "b.png"
    assert (tmp_path / "b.png").read_text() == "a.png"
    rn.undo_last(hist)
    assert (tmp_path / "a.png").read_text() == "a.png"
    assert hist.load() == []


def test_case_only_rename(tmp_path):
    (a,) = touch(tmp_path, "wood.png")
    plan = rn.build_plan([a], [rn.CaseRule("upper")])
    assert plan[0].status is rn.Status.OK
    rn.execute_plan(plan)
    assert [p.name for p in tmp_path.iterdir()] == ["WOOD.png"]


def test_execute_rolls_back_on_failure(tmp_path, monkeypatch):
    a, b = touch(tmp_path, "a.png", "b.png")
    real_rename = rn.os.rename
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] == 3:  # fail in phase two
            raise OSError("disk on fire")
        real_rename(src, dst)

    monkeypatch.setattr(rn.os, "rename", flaky)
    with pytest.raises(OSError):
        rn.execute_plan([rn.RenameEntry(a, tmp_path / "c.png"), rn.RenameEntry(b, tmp_path / "d.png")])
    monkeypatch.setattr(rn.os, "rename", real_rename)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a.png", "b.png"]


def test_undo_refuses_when_target_occupied(tmp_path):
    (a,) = touch(tmp_path, "a.png")
    hist = rn.RenameHistory(tmp_path)
    rn.execute_plan(rn.build_plan([a], [rn.PrefixRule("T_")]), hist)
    (tmp_path / "a.png").write_text("new file")
    with pytest.raises(FileExistsError):
        rn.undo_last(hist)
    assert len(hist.load()) == 1  # history kept so the user can resolve and retry
