"""Injected into Blender 5.x:  blender -b <file.blend> -P headless_pack.py -- [options]

Runs inside Blender's own Python, so it may only use the stdlib and ``bpy``.
Writes a JSON report to ``--report`` and prints ``PP_PROGRESS``/``PP_DONE`` markers
that the host process parses.

Operations (applied in this order, any combination):
  --consolidate   copy every external file into //textures (images) / //assets (others)
                  and repoint the data-blocks there
  --unpack        unpack packed files to //textures etc. (Blender's WRITE_LOCAL layout)
  --relative      make all paths relative (bpy.ops.file.make_paths_relative)
  --pack          pack every external file into the .blend (bpy.ops.file.pack_all)
"""
import argparse
import json
import os
import shutil
import sys
import traceback

import bpy

IMAGE_DIR = "textures"
OTHER_DIR = "assets"


def progress(step, total, msg):
    print(f"PP_PROGRESS {step}/{total} {msg}", flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="headless_pack")
    p.add_argument("--report", required=True)
    p.add_argument("--output", help="save the result as a new .blend instead of overwriting")
    p.add_argument("--consolidate", action="store_true")
    p.add_argument("--unpack", action="store_true")
    p.add_argument("--relative", action="store_true")
    p.add_argument("--pack", action="store_true")
    p.add_argument("--no-save", action="store_true", help="analyse only")
    return p.parse_args(argv)


def external_blocks():
    """(collection name, data-block) for every ID that references a file on disk."""
    for coll in ("images", "sounds", "fonts", "movieclips", "volumes", "cache_files", "libraries"):
        for block in getattr(bpy.data, coll, []):
            path = getattr(block, "filepath", "")
            if not path or path == "<builtin>":
                continue
            if coll == "images" and block.source not in {"FILE", "SEQUENCE", "MOVIE", "TILED"}:
                continue
            yield coll, block


def dependency_report():
    deps = []
    for coll, block in external_blocks():
        packed = bool(getattr(block, "packed_file", None)) or bool(getattr(block, "packed_files", None) and len(block.packed_files))
        abspath = bpy.path.abspath(block.filepath, library=getattr(block, "library", None))
        deps.append({
            "type": coll,
            "name": block.name,
            "filepath": block.filepath,
            "abspath": os.path.normpath(abspath),
            "relative": block.filepath.startswith("//"),
            "packed": packed,
            "exists": os.path.exists(abspath),
            "linked_from": block.library.filepath if getattr(block, "library", None) else None,
        })
    return deps


def consolidate(log):
    """Copy external (non-packed, existing) files next to the .blend and remap them."""
    blend_dir = bpy.path.abspath("//")
    copied = {}
    for coll, block in external_blocks():
        if coll == "libraries" or getattr(block, "library", None):
            continue  # linked data is owned by the library file
        if getattr(block, "packed_file", None):
            continue
        src = os.path.normpath(bpy.path.abspath(block.filepath))
        if not os.path.isfile(src):
            log.append(f"missing, not consolidated: {block.name} ({block.filepath})")
            continue
        key = os.path.normcase(src)
        if key not in copied:
            dest_dir = os.path.join(blend_dir, IMAGE_DIR if coll == "images" else OTHER_DIR)
            os.makedirs(dest_dir, exist_ok=True)
            dest = _unique_dest(src, dest_dir)
            if not os.path.exists(dest):
                shutil.copy2(src, dest)
            copied[key] = dest
        block.filepath = bpy.path.relpath(copied[key])
        log.append(f"{block.name}: {src} -> {block.filepath}")
    return len(copied)


def _unique_dest(src, dest_dir):
    """Target path in ``dest_dir``; reuses an identical file, never overwrites a different one."""
    stem, ext = os.path.splitext(os.path.basename(src))
    dest, i = os.path.join(dest_dir, stem + ext), 1
    while os.path.exists(dest) and not _same_file(src, dest):
        dest, i = os.path.join(dest_dir, f"{stem}_{i}{ext}"), i + 1
    return dest


def _same_file(a, b):
    try:
        if os.path.getsize(a) != os.path.getsize(b):
            return False
        with open(a, "rb") as fa, open(b, "rb") as fb:
            while True:
                ca, cb = fa.read(1 << 20), fb.read(1 << 20)
                if ca != cb:
                    return False
                if not ca:
                    return True
    except OSError:
        return False


def main():
    args = parse_args()
    report = {"ok": False, "blend": bpy.data.filepath, "blender_version": bpy.app.version_string,
              "steps": [], "log": []}
    try:
        steps = ["analyse"]
        if args.output:
            steps.append("save_as")
        steps += [s for s, on in (("consolidate", args.consolidate), ("unpack", args.unpack),
                                  ("relative", args.relative), ("pack", args.pack)) if on]
        if not args.no_save:
            steps.append("save")
        total = len(steps)

        progress(1, total, "analysing dependencies")
        report["before"] = dependency_report()
        n = 1

        if args.output:
            n += 1
            progress(n, total, "saving copy")
            os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
            # the source file stays untouched, so the new copy needs no .blend1 backup
            bpy.context.preferences.filepaths.save_version = 0
            # relative_remap keeps // paths pointing at the same files from the new location
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.output), relative_remap=True, copy=False)
            report["blend"] = bpy.data.filepath

        if args.consolidate:
            n += 1
            progress(n, total, "consolidating external files")
            report["consolidated"] = consolidate(report["log"])
        if args.unpack:
            n += 1
            progress(n, total, "unpacking packed files")
            bpy.ops.file.unpack_all(method="WRITE_LOCAL")
        if args.relative:
            n += 1
            progress(n, total, "making paths relative")
            bpy.ops.file.make_paths_relative()
        if args.pack:
            n += 1
            progress(n, total, "packing resources")
            bpy.ops.file.pack_all()

        if not args.no_save:
            n += 1
            progress(n, total, "saving")
            bpy.ops.wm.save_mainfile()

        report["after"] = dependency_report()
        report["missing"] = [d for d in report["after"] if not d["exists"] and not d["packed"]]
        report["steps"] = steps
        report["ok"] = True
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("PP_DONE", "OK" if report["ok"] else "ERROR", flush=True)


main()
