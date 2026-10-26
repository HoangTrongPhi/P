"""Recursive asset scanning, filtering, duplicate and unused-texture detection."""
from __future__ import annotations

import json
import os
import re
import threading
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from utils.file_helpers import ALL_ASSET_EXTS, TEXTURE_EXTS, category_for, file_checksum
from utils.logger import get_logger

log = get_logger("scanner")

ProgressFn = Callable[[int, int], None]

# Folders that never contain user assets and are expensive to walk.
_SKIP_DIRS = {".git", ".svn", "__pycache__", ".venv", "node_modules", "Intermediate", "DerivedDataCache"}


@dataclass(frozen=True)
class AssetFile:
    path: Path
    size: int
    category: str

    @property
    def ext(self) -> str:
        return self.path.suffix.lower()


def scan(
    root: str | os.PathLike,
    extensions: Iterable[str] | None = None,
    recursive: bool = True,
    cancel: threading.Event | None = None,
) -> list[AssetFile]:
    """Collect asset files under ``root`` matching ``extensions`` (defaults to all asset types)."""
    root = Path(root)
    exts = {e.lower() if e.startswith(".") else f".{e.lower()}" for e in (extensions or ALL_ASSET_EXTS)}
    if root.is_file():
        return [AssetFile(root, root.stat().st_size, category_for(root))] if root.suffix.lower() in exts else []

    results: list[AssetFile] = []
    for dirpath, dirnames, filenames in os.walk(root):
        if cancel and cancel.is_set():
            break
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIRS) if recursive else []
        for name in sorted(filenames):
            p = Path(dirpath, name)
            if p.suffix.lower() in exts:
                try:
                    results.append(AssetFile(p, p.stat().st_size, category_for(p)))
                except OSError as exc:
                    log.warning("Cannot stat %s: %s", p, exc)
    log.info("Scanned %s: %d matching files", root, len(results))
    return results


def find_duplicates(
    files: Iterable[AssetFile],
    progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
) -> list[list[AssetFile]]:
    """Group byte-identical files. Size is compared first so only candidates are hashed."""
    by_size: dict[int, list[AssetFile]] = defaultdict(list)
    for f in files:
        by_size[f.size].append(f)
    candidates = [f for group in by_size.values() if len(group) > 1 for f in group if f.size > 0]

    by_hash: dict[str, list[AssetFile]] = defaultdict(list)
    for i, f in enumerate(candidates):
        if cancel and cancel.is_set():
            break
        try:
            by_hash[file_checksum(f.path)].append(f)
        except OSError as exc:
            log.warning("Cannot hash %s: %s", f.path, exc)
        if progress:
            progress(i + 1, len(candidates))
    return [g for g in by_hash.values() if len(g) > 1]


_MTL_MAP_RE = re.compile(r"^\s*(?:map_\w+|bump|disp|decal|refl|norm)\s+(.+)$", re.I)


def _mtl_references(mtl: Path) -> set[str]:
    refs = set()
    for line in mtl.read_text(errors="replace").splitlines():
        m = _MTL_MAP_RE.match(line)
        if m:
            # Options like "-bm 1.0" precede the file; the file is the last token.
            refs.add(Path(m.group(1).split()[-1].replace("\\", "/")).name.lower())
    return refs


def _gltf_references(gltf: Path) -> set[str]:
    data = json.loads(gltf.read_text(encoding="utf-8"))
    return {
        Path(img["uri"].replace("\\", "/")).name.lower()
        for img in data.get("images", [])
        if "uri" in img and not img["uri"].startswith("data:")
    }


def referenced_texture_names(root: str | os.PathLike, cancel: threading.Event | None = None) -> set[str]:
    """Lower-cased basenames of every texture referenced by FBX / MTL / glTF files under ``root``."""
    from core import fbx_doctor  # local import keeps scanner usable without the FBX module

    refs: set[str] = set()
    for f in scan(root, {".fbx", ".mtl", ".gltf"}, cancel=cancel):
        try:
            if f.ext == ".fbx":
                refs |= {r.basename.lower() for r in fbx_doctor.scan_fbx(f.path).references}
            elif f.ext == ".mtl":
                refs |= _mtl_references(f.path)
            else:
                refs |= _gltf_references(f.path)
        except Exception as exc:  # a single broken file must not abort the whole report
            log.warning("Skipping %s: %s", f.path, exc)
    return refs


def find_unused_textures(root: str | os.PathLike, cancel: threading.Event | None = None) -> list[AssetFile]:
    """Textures under ``root`` that no FBX / OBJ-MTL / glTF file references.

    .blend files are not inspected (that needs Blender), so textures only used by
    .blend scenes will be listed as unused.
    """
    refs = referenced_texture_names(root, cancel)
    textures = scan(root, TEXTURE_EXTS, cancel=cancel)
    return [t for t in textures if t.path.name.lower() not in refs]
