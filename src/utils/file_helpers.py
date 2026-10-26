"""Path sanitization, asset classification and checksums."""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

MESH_EXTS = {".fbx", ".obj", ".glb", ".gltf"}
SCENE_EXTS = {".blend"}
TEXTURE_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".dds", ".exr", ".hdr", ".tif", ".tiff", ".bmp"}
SOURCE_EXTS = {".psd"}

ALL_ASSET_EXTS = MESH_EXTS | SCENE_EXTS | TEXTURE_EXTS | SOURCE_EXTS

# Characters Windows refuses in file names (also covers control chars).
_INVALID_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def category_for(path: str | os.PathLike) -> str:
    """Return 'mesh', 'scene', 'texture', 'source' or 'other'."""
    ext = Path(path).suffix.lower()
    if ext in MESH_EXTS:
        return "mesh"
    if ext in SCENE_EXTS:
        return "scene"
    if ext in TEXTURE_EXTS:
        return "texture"
    if ext in SOURCE_EXTS:
        return "source"
    return "other"


def validate_filename(name: str) -> str | None:
    """Return an error message if ``name`` is not a valid file name, else None."""
    if not name or name in {".", ".."}:
        return "Empty name"
    if _INVALID_NAME_RE.search(name):
        return "Contains invalid characters"
    if name.endswith((" ", ".")):
        return "Ends with space or dot"
    if Path(name).stem.upper() in _RESERVED_NAMES:
        return "Reserved Windows name"
    if len(name) > 255:
        return "Name too long"
    return None


def same_path(a: str | os.PathLike, b: str | os.PathLike) -> bool:
    """Compare two paths the way the OS does (case-insensitive on Windows)."""
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def file_checksum(path: str | os.PathLike, algo: str = "sha1", chunk: int = 1 << 20) -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num) < 1024 or unit == "GB":
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.1f} {unit}"
        num /= 1024
    return f"{num:.1f} GB"


def is_within(path: str | os.PathLike, root: str | os.PathLike) -> bool:
    """True if ``path`` resolves inside ``root`` (guards against traversal)."""
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False
