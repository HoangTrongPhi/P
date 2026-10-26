"""FBX Absolute Path Doctor.

Finds texture/media paths in ASCII and Binary (7.x) FBX files, classifies them
(absolute / UNC / relative), checks whether they resolve on disk, and rewrites
them to portable relative paths.

Binary FBX layout (no Autodesk SDK needed):
    header (27 bytes: magic + u32 version)
    node records: EndOffset, NumProperties, PropertyListLen (u32, or u64 when
                  version >= 7500), NameLen u8, Name, properties, nested nodes,
                  null record
    footer
Rewriting a string changes byte lengths, so the file is fully parsed into a
node tree (keeping untouched property bytes verbatim) and re-serialized with
recomputed offsets. An unmodified parse/serialize round-trip is byte-identical.
"""
from __future__ import annotations

import os
import re
import shutil
import struct
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Iterator

from utils.file_helpers import same_path
from utils.logger import get_logger

log = get_logger("fbx_doctor")

BINARY_MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
HEADER_SIZE = 27
_FOOTER_TAIL_SIZE = 4 + 120 + 16  # version + zero block + footer magic

PATH_FIELD_NAMES = {"FileName", "Filename", "RelativeFilename"}
PATH_P_NAMES = {"Path", "RelPath", "FileName"}
OWNER_NODE_NAMES = {"Video", "Texture"}

_PRIMITIVE_SIZES = {"Y": 2, "C": 1, "I": 4, "F": 4, "D": 8, "L": 8}
_ARRAY_TYPES = set("fdlibc")


class FbxError(Exception):
    pass


class PathKind(str, Enum):
    ABSOLUTE_LOCAL = "ABSOLUTE_LOCAL"
    UNC_NETWORK = "UNC_NETWORK"
    RELATIVE_PORTABLE = "RELATIVE_PORTABLE"
    EMPTY = "EMPTY"


class FixMode(str, Enum):
    RELATIVE = "relative"  # rebase to the real location / a target folder, relative to the FBX
    STRIP = "strip"        # keep only the file name
    COLLECT = "collect"    # copy textures into <fbx_dir>/<subfolder>/ and point there


_DRIVE_RE = re.compile(r"^[A-Za-z]:")  # "C:\x", "C:/x" and drive-relative "C:x"


def classify_path(value: str) -> PathKind:
    v = value.strip()
    if not v:
        return PathKind.EMPTY
    if v.startswith(("\\\\", "//")):
        return PathKind.UNC_NETWORK
    if _DRIVE_RE.match(v) or v.startswith("/"):
        return PathKind.ABSOLUTE_LOCAL
    return PathKind.RELATIVE_PORTABLE


def path_basename(value: str) -> str:
    return re.split(r"[\\/]", value.strip())[-1]


# =========================================================================== binary model


@dataclass
class FbxProperty:
    type: str
    raw: bytes            # full encoded bytes including the type code
    value: bytes | None = None  # decoded payload for S / R properties

    @classmethod
    def string(cls, value: bytes, type_code: str = "S") -> "FbxProperty":
        return cls(type_code, type_code.encode() + struct.pack("<I", len(value)) + value, value)


@dataclass
class FbxNode:
    name: str
    props: list[FbxProperty] = field(default_factory=list)
    children: list["FbxNode"] = field(default_factory=list)
    has_nested: bool = False  # whether a nested list (+ null record) followed the properties

    def child(self, name: str) -> "FbxNode | None":
        return next((c for c in self.children if c.name == name), None)

    def walk(self, parents: tuple["FbxNode", ...] = ()) -> Iterator[tuple["FbxNode", tuple["FbxNode", ...]]]:
        yield self, parents
        for c in self.children:
            yield from c.walk(parents + (self,))


@dataclass
class FbxBinaryDocument:
    version: int
    nodes: list[FbxNode]
    footer: bytes

    @property
    def wide(self) -> bool:
        return self.version >= 7500


def _parse_props(buf: bytes, off: int, end: int) -> list[FbxProperty]:
    props = []
    while off < end:
        t = chr(buf[off])
        if t in _PRIMITIVE_SIZES:
            size = 1 + _PRIMITIVE_SIZES[t]
            props.append(FbxProperty(t, buf[off:off + size]))
        elif t in "SR":
            (n,) = struct.unpack_from("<I", buf, off + 1)
            size = 5 + n
            props.append(FbxProperty(t, buf[off:off + size], buf[off + 5:off + size]))
        elif t in _ARRAY_TYPES:
            _arr_len, _enc, comp_len = struct.unpack_from("<III", buf, off + 1)
            size = 13 + comp_len
            props.append(FbxProperty(t, buf[off:off + size]))
        else:
            raise FbxError(f"Unknown property type {t!r} at offset {off}")
        off += size
    if off != end:
        raise FbxError("Property list length mismatch")
    return props


def _parse_node(buf: bytes, off: int, wide: bool) -> tuple[FbxNode | None, int]:
    if wide:
        end, _nprops, plen = struct.unpack_from("<QQQ", buf, off)
        off += 24
    else:
        end, _nprops, plen = struct.unpack_from("<III", buf, off)
        off += 12
    name_len = buf[off]
    off += 1
    if end == 0:
        return None, off  # null record
    if end > len(buf):
        raise FbxError("Node end offset beyond file size (truncated file?)")
    name = buf[off:off + name_len].decode("ascii", "replace")
    off += name_len
    props = _parse_props(buf, off, off + plen)
    off += plen
    node = FbxNode(name, props, has_nested=off < end)
    while off < end:
        child, off = _parse_node(buf, off, wide)
        if child is None:
            break
        node.children.append(child)
    return node, end


def parse_binary(buf: bytes) -> FbxBinaryDocument:
    if not buf.startswith(BINARY_MAGIC):
        raise FbxError("Not a binary FBX file")
    (version,) = struct.unpack_from("<I", buf, 23)
    wide = version >= 7500
    off, nodes = HEADER_SIZE, []
    while off < len(buf):
        node, off = _parse_node(buf, off, wide)
        if node is None:
            break
        nodes.append(node)
    return FbxBinaryDocument(version, nodes, buf[off:])


def _null_record(wide: bool) -> bytes:
    return b"\x00" * (25 if wide else 13)


def _write_node(node: FbxNode, out: bytearray, wide: bool) -> None:
    start = len(out)
    props = b"".join(p.raw for p in node.props)
    name = node.name.encode("ascii")
    hdr = "<QQQ" if wide else "<III"
    out += struct.pack(hdr, 0, len(node.props), len(props)) + bytes([len(name)]) + name + props
    if node.has_nested or node.children:
        for c in node.children:
            _write_node(c, out, wide)
        out += _null_record(wide)
    struct.pack_into(hdr[:2], out, start, len(out))


def _rebuild_footer(footer: bytes, footer_start_old: int, footer_start_new: int) -> bytes:
    """Recompute the alignment padding inside the footer when the body length changed.

    Footer = 16-byte id + 4 zero bytes + padding (aligns to 16, 1..16 bytes) + version + 120 zeros + magic.
    """
    if footer_start_old == footer_start_new or len(footer) < 20 + 1 + _FOOTER_TAIL_SIZE:
        return footer
    head, tail = footer[:20], footer[-_FOOTER_TAIL_SIZE:]
    old_pad = len(footer) - 20 - _FOOTER_TAIL_SIZE

    def pad_for(start: int) -> int:
        ofs = start + 20
        pad = ((ofs + 15) & ~15) - ofs
        return pad or 16

    if footer[20:20 + old_pad].strip(b"\x00") or pad_for(footer_start_old) != old_pad:
        return footer  # unknown footer flavour: keep it verbatim
    return head + b"\x00" * pad_for(footer_start_new) + tail


def serialize_binary(doc: FbxBinaryDocument, original_body_end: int | None = None) -> bytes:
    out = bytearray(BINARY_MAGIC + struct.pack("<I", doc.version))
    for n in doc.nodes:
        _write_node(n, out, doc.wide)
    out += _null_record(doc.wide)
    footer = doc.footer
    if original_body_end is not None:
        footer = _rebuild_footer(footer, original_body_end, len(out))
    return bytes(out + footer)


# =========================================================================== path records


@dataclass
class TextureRef:
    field: str            # FileName / RelativeFilename / P:Path / ...
    owner: str            # e.g. "Video::wood"
    value: str
    kind: PathKind
    owner_key: object = None
    resolved: Path | None = None
    resolution: str = "missing"  # found | found_by_name | missing | embedded
    embedded: bool = False
    locator: object = field(default=None, repr=False)

    @property
    def basename(self) -> str:
        return path_basename(self.value)

    @property
    def is_problem(self) -> bool:
        if self.kind is PathKind.EMPTY:
            return False
        return self.kind is not PathKind.RELATIVE_PORTABLE or self.resolution not in ("found", "embedded")


@dataclass
class FbxScanResult:
    path: Path
    format: str  # "binary" | "ascii"
    version: int
    references: list[TextureRef]
    error: str | None = None

    @property
    def problems(self) -> list[TextureRef]:
        return [r for r in self.references if r.is_problem]


def _decode(b: bytes) -> str:
    return b.decode("utf-8", "surrogateescape")


def _encode(s: str) -> bytes:
    return s.encode("utf-8", "surrogateescape")


def _owner_label(node: FbxNode) -> str:
    strings = [p.value for p in node.props if p.type == "S" and p.value is not None]
    if not strings:
        return node.name
    # FBX 7 stores "name\x00\x01Class", FBX 6 stores "Class::name"
    raw = next((s for s in strings if b"\x00\x01" in s or b"::" in s), strings[0])
    if b"\x00\x01" in raw:
        name, cls = raw.split(b"\x00\x01", 1)
        return f"{_decode(cls)}::{_decode(name)}"
    return _decode(raw)


def _binary_refs(doc: FbxBinaryDocument) -> list[TextureRef]:
    refs = []
    for top in doc.nodes:
        for node, parents in top.walk():
            owner = next((p for p in reversed(parents) if p.name in OWNER_NODE_NAMES), None)
            if node.name in PATH_FIELD_NAMES and parents and parents[-1].name in OWNER_NODE_NAMES:
                if node.props and node.props[0].type == "S":
                    refs.append((node.name, owner, node, 0))
            elif node.name == "P" and owner is not None and len(node.props) >= 5:
                p0 = node.props[0].value
                if p0 is not None and _decode(p0) in PATH_P_NAMES and node.props[4].type == "S":
                    refs.append((f"P:{_decode(p0)}", owner, node, 4))
    result = []
    for fld, owner, node, idx in refs:
        content = owner.child("Content") if owner is not None else None
        embedded = bool(content and content.props and content.props[0].value)
        value = _decode(node.props[idx].value)
        result.append(TextureRef(
            fld, _owner_label(owner) if owner else "?", value, classify_path(value),
            owner_key=id(owner), embedded=embedded, locator=(node, idx),
        ))
    return result


# ---- ASCII

_ASCII_FIELD_RE = re.compile(r'^(\s*(FileName|Filename|RelativeFilename)\s*:\s*")(.*)("[ \t]*\r?\n?)$')
_ASCII_P_RE = re.compile(
    r'^(\s*P\s*:\s*"(Path|RelPath|FileName)"\s*,\s*"KString"\s*,\s*"XRefUrl"\s*,\s*"[^"]*"\s*,\s*")(.*)("[ \t]*\r?\n?)$'
)
_ASCII_OWNER_RE = re.compile(r'^\s*(Video|Texture)\s*:\s*(?:-?\d+\s*,\s*)?"([^"]*)"')
_ASCII_VERSION_RE = re.compile(r"FBXVersion\s*:\s*(\d+)")
_QUOTED_RE = re.compile(r'"[^"]*"')


@dataclass
class FbxAsciiDocument:
    lines: list[str]
    version: int


def parse_ascii(text: str) -> FbxAsciiDocument:
    m = _ASCII_VERSION_RE.search(text[:20000])
    return FbxAsciiDocument(text.splitlines(keepends=True), int(m.group(1)) if m else 0)


def _ascii_refs(doc: FbxAsciiDocument) -> list[TextureRef]:
    refs = []
    depth = 0
    owner: tuple[str, int, int] | None = None  # (label, depth at open, line no)
    for i, line in enumerate(doc.lines):
        om = _ASCII_OWNER_RE.match(line)
        if om:
            label = om.group(2) if "::" in om.group(2) else f"{om.group(1)}::{om.group(2)}"
            owner = (label, depth, i)
        if owner is not None:
            m = _ASCII_FIELD_RE.match(line) or _ASCII_P_RE.match(line)
            if m:
                fld = m.group(2) if m.re is _ASCII_FIELD_RE else f"P:{m.group(2)}"
                value = m.group(3).replace("&quot;", '"')
                refs.append(TextureRef(fld, owner[0], value, classify_path(value), owner_key=owner[2], locator=i))
        stripped = _QUOTED_RE.sub("", line.split(";", 1)[0])
        depth += stripped.count("{") - stripped.count("}")
        if owner is not None and depth <= owner[1] and "}" in stripped:
            owner = None
    return refs


def _ascii_set(doc: FbxAsciiDocument, line_no: int, new_value: str) -> None:
    line = doc.lines[line_no]
    m = _ASCII_FIELD_RE.match(line) or _ASCII_P_RE.match(line)
    if not m:
        raise FbxError(f"Line {line_no + 1} no longer matches a path field")
    doc.lines[line_no] = m.group(1) + new_value.replace('"', "&quot;") + m.group(4)


# =========================================================================== resolution


class _NameIndex:
    """Lazy case-insensitive basename -> path index of files near the FBX."""

    def __init__(self, roots: list[Path], max_depth: int = 4):
        self._roots, self._max_depth = roots, max_depth
        self._index: dict[str, Path] | None = None

    def find(self, name: str) -> Path | None:
        if self._index is None:
            self._index = {}
            for root in self._roots:
                if not root.is_dir():
                    continue
                base_depth = len(root.parts)
                for dirpath, dirnames, filenames in os.walk(root):
                    if len(Path(dirpath).parts) - base_depth >= self._max_depth:
                        dirnames[:] = []
                    for f in filenames:
                        self._index.setdefault(f.lower(), Path(dirpath, f))
        return self._index.get(name.lower())


def _resolve(ref: TextureRef, fbx_dir: Path, index: _NameIndex) -> None:
    if ref.kind is PathKind.EMPTY:
        return
    value = ref.value.strip()
    candidates = []
    if ref.kind is PathKind.RELATIVE_PORTABLE:
        candidates.append(fbx_dir / value.replace("\\", "/"))
    else:
        candidates.append(Path(value))
    for c in candidates:
        try:
            if c.is_file():
                ref.resolved, ref.resolution = c.resolve(), "found"
                return
        except OSError:
            pass
    hit = index.find(ref.basename)
    if hit:
        ref.resolved, ref.resolution = hit.resolve(), "found_by_name"
    elif ref.embedded:
        ref.resolution = "embedded"


def _load(path: Path):
    data = path.read_bytes()
    if data.startswith(BINARY_MAGIC):
        doc = parse_binary(data)
        return "binary", doc, _binary_refs(doc), len(data) - len(doc.footer)
    doc = parse_ascii(data.decode("utf-8", "surrogateescape"))
    if not doc.lines or not any(l.lstrip().startswith(("FBXHeaderExtension", "; FBX")) for l in doc.lines[:50]):
        raise FbxError("Not an FBX file (no binary magic or ASCII header)")
    return "ascii", doc, _ascii_refs(doc), None


def scan_fbx(path: str | os.PathLike, search_dirs: list[str | os.PathLike] | None = None) -> FbxScanResult:
    """Report every texture/media path referenced by ``path``."""
    path = Path(path)
    fmt, doc, refs, _ = _load(path)
    fbx_dir = path.parent
    roots = [fbx_dir] + [Path(d) for d in (search_dirs or [])]
    index = _NameIndex(roots)
    for r in refs:
        _resolve(r, fbx_dir, index)
    # Share the best resolution between the FileName/RelativeFilename pair of one owner.
    best: dict[object, TextureRef] = {}
    for r in refs:
        cur = best.get(r.owner_key)
        if r.resolved is not None and (cur is None or (cur.resolution != "found" and r.resolution == "found")):
            best[r.owner_key] = r
    for r in refs:
        b = best.get(r.owner_key)
        if r.resolved is None and b is not None and b.basename.lower() == r.basename.lower():
            r.resolved, r.resolution = b.resolved, "found_by_name"
    return FbxScanResult(path, fmt, doc.version, refs)


# =========================================================================== fixing


@dataclass
class PathChange:
    field: str
    owner: str
    old: str
    new: str


@dataclass
class FixReport:
    path: Path
    changes: list[PathChange] = field(default_factory=list)
    copied: list[tuple[Path, Path]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    backup: Path | None = None
    written: bool = False


def _relpath_portable(target: Path, start: Path) -> str | None:
    try:
        return Path(os.path.relpath(target, start)).as_posix()
    except ValueError:  # different drives on Windows
        return None


def compute_new_path(
    ref: TextureRef, fbx_dir: Path, mode: FixMode, rebase_dir: Path | None, subfolder: str
) -> tuple[str, str | None]:
    """Return ``(new_value, warning)`` for one reference."""
    name = ref.basename
    if mode is FixMode.STRIP:
        return name, None
    if mode is FixMode.COLLECT:
        warn = None if ref.resolved else f"{name}: source texture not found, path set but nothing copied"
        return f"{subfolder.strip('/')}/{name}" if subfolder else name, warn
    # RELATIVE
    if rebase_dir is not None:
        rel = _relpath_portable(rebase_dir / name, fbx_dir)
        if rel is not None:
            return rel, None if (rebase_dir / name).exists() else f"{name}: not present in {rebase_dir}"
        return name, f"{name}: rebase folder is on another drive, stripped to file name"
    if ref.resolved is not None:
        rel = _relpath_portable(ref.resolved, fbx_dir)
        if rel is not None:
            return rel, None
        return name, f"{name}: texture is on another drive, stripped to file name (use Collect mode)"
    fallback = f"{subfolder.strip('/')}/{name}" if subfolder else name
    return fallback, f"{name}: texture missing, guessed '{fallback}'"


def fix_fbx(
    path: str | os.PathLike,
    mode: FixMode | str = FixMode.RELATIVE,
    rebase_dir: str | os.PathLike | None = None,
    subfolder: str = "textures",
    fix_all: bool = False,
    backup: bool = True,
    dry_run: bool = False,
    search_dirs: list[str | os.PathLike] | None = None,
) -> FixReport:
    """Rewrite texture paths in ``path``.

    By default only problematic references (absolute, UNC or unresolvable) are rewritten;
    ``fix_all`` rewrites every non-empty reference (useful for Collect mode).
    A ``<file>.fbx.bak`` copy of the original is kept unless one already exists.
    """
    path = Path(path)
    mode = FixMode(mode)
    rebase = Path(rebase_dir) if rebase_dir else None
    fbx_dir = path.parent
    report = FixReport(path)

    scan = scan_fbx(path, search_dirs)
    # Fresh document whose locators we edit; both passes yield references in file order.
    fmt, doc, refs, body_end = _load(path)
    if len(refs) != len(scan.references):
        raise FbxError("Internal mismatch between scan and edit passes")

    for live, info in zip(refs, scan.references):
        if info.kind is PathKind.EMPTY or not (fix_all or info.is_problem):
            continue
        new_value, warn = compute_new_path(info, fbx_dir, mode, rebase, subfolder)
        if warn and warn not in report.warnings:
            report.warnings.append(warn)
        if mode is FixMode.COLLECT and info.resolved is not None:
            dest = fbx_dir / new_value
            if not same_path(dest, info.resolved) and (info.resolved, dest) not in report.copied:
                if dest.exists():
                    if dest.stat().st_size != info.resolved.stat().st_size:
                        report.warnings.append(f"{dest.name}: a different file already exists in {dest.parent}, kept it")
                else:
                    report.copied.append((info.resolved, dest))
        if new_value == info.value:
            continue
        report.changes.append(PathChange(info.field, info.owner, info.value, new_value))
        if fmt == "binary":
            node, idx = live.locator
            node.props[idx] = FbxProperty.string(_encode(new_value))
        else:
            _ascii_set(doc, live.locator, new_value)

    if dry_run or not (report.changes or report.copied):
        return report

    for src, dest in report.copied:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)

    if report.changes:
        if backup:
            bak = path.with_name(path.name + ".bak")
            if bak.exists():
                log.info("Backup %s already exists, keeping the original backup", bak)
            else:
                shutil.copy2(path, bak)
            report.backup = bak
        data = serialize_binary(doc, body_end) if fmt == "binary" else _encode("".join(doc.lines))
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        report.written = True
    log.info("%s: %d path(s) rewritten, %d texture(s) copied", path.name, len(report.changes), len(report.copied))
    return report


def restore_backup(path: str | os.PathLike) -> bool:
    """Restore ``<file>.fbx`` from ``<file>.fbx.bak``. Returns False if there is no backup."""
    path = Path(path)
    bak = path.with_name(path.name + ".bak")
    if not bak.exists():
        return False
    shutil.copy2(bak, path)
    return True
