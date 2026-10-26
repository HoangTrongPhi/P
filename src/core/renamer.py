"""Batch renaming rules, engine presets, dry-run planning and a persistent undo stack."""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from abc import ABC, abstractmethod
from collections import Counter
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Iterable, Sequence

from utils.file_helpers import category_for, validate_filename
from utils.logger import get_logger

log = get_logger("renamer")

HISTORY_FILENAME = ".rename_history.json"
MAX_HISTORY = 50


# --------------------------------------------------------------------------- words & case

_WORD_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")


def split_words(text: str) -> list[str]:
    """Split ``"brickWall_01-Normal"`` -> ``["brick", "Wall", "01", "Normal"]``."""
    return _WORD_RE.findall(text)


def _cap(word: str) -> str:
    if word.isupper() and len(word) <= 3:  # keep short acronyms like UV, PBR, ORM
        return word
    return word[:1].upper() + word[1:].lower()


def _pascal_join(words: Sequence[str]) -> str:
    """PascalCase, but keep digit groups separated (``Rock_01``) as UE/Unity projects usually do."""
    out = ""
    for w in words:
        if w.isdigit() and out:
            out += "_" + w
        else:
            out += _cap(w)
    return out


def convert_case(text: str, style: str) -> str:
    words = split_words(text)
    if not words:
        return text
    if style == "snake":
        return "_".join(w.lower() for w in words)
    if style == "kebab":
        return "-".join(w.lower() for w in words)
    if style == "upper":
        return "_".join(w.upper() for w in words)
    if style == "lower":
        return "".join(w.lower() for w in words)
    if style == "pascal":
        return "".join(_cap(w) for w in words)
    if style == "camel":
        return words[0].lower() + "".join(_cap(w) for w in words[1:])
    raise ValueError(f"Unknown case style: {style}")


CASE_STYLES = ("camel", "snake", "pascal", "upper", "lower", "kebab")


# --------------------------------------------------------------------------- rules


class Rule(ABC):
    """Transforms a file stem. Extensions are never touched."""

    @abstractmethod
    def apply(self, stem: str, path: Path) -> str: ...

    @abstractmethod
    def describe(self) -> str: ...


@dataclass
class SearchReplaceRule(Rule):
    find: str
    replace: str = ""
    regex: bool = False
    case_sensitive: bool = True

    def __post_init__(self):
        flags = 0 if self.case_sensitive else re.IGNORECASE
        self._pattern = re.compile(self.find if self.regex else re.escape(self.find), flags)

    def apply(self, stem, path):
        if not self.find:
            return stem
        # Literal mode must not interpret backslashes in the replacement.
        repl = self.replace if self.regex else (lambda _m: self.replace)
        return self._pattern.sub(repl, stem)

    def describe(self):
        kind = "Regex" if self.regex else "Replace"
        return f"{kind} '{self.find}' -> '{self.replace}'"


@dataclass
class PrefixRule(Rule):
    prefix: str
    skip_if_present: bool = True

    def apply(self, stem, path):
        if self.skip_if_present and stem.startswith(self.prefix):
            return stem
        return self.prefix + stem

    def describe(self):
        return f"Prefix '{self.prefix}'"


@dataclass
class SuffixRule(Rule):
    suffix: str
    skip_if_present: bool = True

    def apply(self, stem, path):
        if self.skip_if_present and stem.endswith(self.suffix):
            return stem
        return stem + self.suffix

    def describe(self):
        return f"Suffix '{self.suffix}'"


@dataclass
class CaseRule(Rule):
    style: str

    def apply(self, stem, path):
        return convert_case(stem, self.style)

    def describe(self):
        return f"Case: {self.style}"


# Texture map aliases -> (Unreal suffix, Unity suffix). Order matters for multi-word aliases.
TEXTURE_MAPS: dict[str, tuple[str, str]] = {
    "basecolor": ("D", "Albedo"), "base color": ("D", "Albedo"), "albedo": ("D", "Albedo"),
    "diffuse": ("D", "Albedo"), "diff": ("D", "Albedo"), "color": ("D", "Albedo"),
    "col": ("D", "Albedo"), "d": ("D", "Albedo"), "bc": ("D", "Albedo"),
    "normal": ("N", "Normal"), "normalgl": ("N", "Normal"), "normaldx": ("N", "Normal"),
    "nrm": ("N", "Normal"), "nor": ("N", "Normal"), "norm": ("N", "Normal"), "n": ("N", "Normal"),
    "roughness": ("R", "Roughness"), "rough": ("R", "Roughness"), "rgh": ("R", "Roughness"), "r": ("R", "Roughness"),
    "metallic": ("M", "Metallic"), "metalness": ("M", "Metallic"), "metal": ("M", "Metallic"),
    "mtl": ("M", "Metallic"), "m": ("M", "Metallic"),
    "orm": ("ORM", "MaskMap"), "arm": ("ORM", "MaskMap"), "mask map": ("ORM", "MaskMap"), "maskmap": ("ORM", "MaskMap"),
    "ao": ("AO", "Occlusion"), "occlusion": ("AO", "Occlusion"), "ambient occlusion": ("AO", "Occlusion"),
    "emissive": ("E", "Emission"), "emission": ("E", "Emission"), "emit": ("E", "Emission"),
    "height": ("H", "Height"), "displacement": ("H", "Height"), "disp": ("H", "Height"), "bump": ("H", "Height"),
    "opacity": ("A", "Opacity"), "alpha": ("A", "Opacity"),
    "mask": ("Mask", "Mask"),
    "specular": ("S", "Specular"), "spec": ("S", "Specular"),
}
_MAX_MAP_WORDS = max(len(k.split()) for k in TEXTURE_MAPS)
_KNOWN_PREFIXES = {"sm", "sk", "t", "tx", "tex"}
_SKELETAL_HINTS = {"skel", "skeletal", "skinned", "sk"}


def _strip_texture_map(words: list[str]) -> tuple[list[str], tuple[str, str] | None]:
    """Detect a trailing map-type alias (``..._Normal``) and remove it from ``words``."""
    for n in range(min(_MAX_MAP_WORDS, len(words) - 1), 0, -1):
        key = " ".join(w.lower() for w in words[-n:])
        if key in TEXTURE_MAPS:
            return words[:-n], TEXTURE_MAPS[key]
    return words, None


@dataclass
class PresetRule(Rule):
    """Industry naming conventions.

    * ``ue5``  : ``SM_Name`` / ``SK_Name`` meshes, ``T_Name_D|N|R|M|ORM`` textures.
    * ``unity``: ``Name`` meshes, ``Name_Albedo|Normal|...`` textures (PascalCase).
    """

    preset: str = "ue5"

    def apply(self, stem, path):
        category = category_for(path)
        if category not in {"mesh", "texture", "source"}:
            return stem
        words = split_words(stem)
        if not words:
            return stem

        skeletal = False
        if len(words) > 1 and words[0].lower() in _KNOWN_PREFIXES:
            skeletal = words[0].lower() == "sk"
            words = words[1:]

        if category == "mesh":
            if any(w.lower() in _SKELETAL_HINTS for w in words):
                skeletal = True
                words = [w for w in words if w.lower() not in _SKELETAL_HINTS] or words
            name = _pascal_join(words)
            if self.preset == "unity":
                return name
            return f"{'SK' if skeletal else 'SM'}_{name}"

        words, map_kind = _strip_texture_map(words)
        name = _pascal_join(words)
        if self.preset == "unity":
            return f"{name}_{map_kind[1]}" if map_kind else name
        return f"T_{name}_{map_kind[0]}" if map_kind else f"T_{name}"

    def describe(self):
        return {"ue5": "Preset: Unreal Engine 5", "unity": "Preset: Unity"}.get(self.preset, self.preset)


PRESETS = ("ue5", "unity")


def apply_rules(stem: str, path: Path, rules: Iterable[Rule]) -> str:
    for rule in rules:
        stem = rule.apply(stem, path)
    return stem


# --------------------------------------------------------------------------- planning


class Status(str, Enum):
    OK = "OK"
    UNCHANGED = "Skipped"
    COLLISION = "Warning: Collision"
    INVALID = "Error: Invalid name"


@dataclass
class RenameEntry:
    src: Path
    dst: Path
    status: Status = Status.OK
    message: str = ""
    new_name: str = ""  # proposed name; differs from dst.name only for INVALID entries (dst stays = src)

    def __post_init__(self):
        self.new_name = self.new_name or self.dst.name


def _key(p: Path) -> str:
    return os.path.normcase(os.path.abspath(p))


def build_plan(paths: Iterable[str | os.PathLike], rules: Sequence[Rule]) -> list[RenameEntry]:
    """Dry-run: compute every new name and flag collisions without touching the disk."""
    entries: list[RenameEntry] = []
    for p in map(Path, paths):
        new_name = apply_rules(p.stem, p, rules) + p.suffix
        if new_name == p.name:
            entries.append(RenameEntry(p, p, Status.UNCHANGED, "Name unchanged"))
        elif err := validate_filename(new_name):
            entries.append(RenameEntry(p, p, Status.INVALID, err, new_name))
        else:
            entries.append(RenameEntry(p, p.with_name(new_name)))

    active = [e for e in entries if e.status is Status.OK]
    target_counts = Counter(_key(e.dst) for e in active)
    leaving = {_key(e.src) for e in active}
    for e in active:
        dst_key = _key(e.dst)
        if target_counts[dst_key] > 1:
            e.status, e.message = Status.COLLISION, "Several files map to this name"
        elif dst_key == _key(e.src):
            e.message = "Case-only change"
        elif e.dst.exists() and dst_key not in leaving:
            e.status, e.message = Status.COLLISION, "Target already exists"
    return entries


# --------------------------------------------------------------------------- execution & undo


def _apply_moves(pairs: Sequence[tuple[Path, Path]]) -> None:
    """Rename ``src -> dst`` for every pair, safely handling swaps and chains.

    Phase 1 moves every source to a unique temp name, phase 2 moves temps to targets.
    Any failure rolls back everything already done.
    """
    token = uuid.uuid4().hex[:8]
    temps = [(src, src.with_name(f".__pp_{token}_{i}{src.suffix}"), dst) for i, (src, dst) in enumerate(pairs)]
    staged: list[tuple[Path, Path]] = []
    placed: list[tuple[Path, Path]] = []
    try:
        for src, tmp, _ in temps:
            os.rename(src, tmp)
            staged.append((src, tmp))
        for _, tmp, dst in temps:
            if dst.exists():
                raise FileExistsError(f"Target appeared during rename: {dst}")
            os.rename(tmp, dst)
            placed.append((tmp, dst))
    except Exception:
        for tmp, dst in reversed(placed):
            os.rename(dst, tmp)
        for src, tmp in reversed(staged):
            os.rename(tmp, src)
        raise


@dataclass
class Transaction:
    id: str
    timestamp: float
    ops: list[dict[str, str]] = field(default_factory=list)  # [{"src": ..., "dst": ...}]

    @property
    def label(self) -> str:
        return f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self.timestamp))} - {len(self.ops)} file(s)"


class RenameHistory:
    """JSON-backed undo stack (``.rename_history.json`` in the working folder)."""

    def __init__(self, path: str | os.PathLike):
        self.path = Path(path)
        if self.path.is_dir():
            self.path = self.path / HISTORY_FILENAME

    def load(self) -> list[Transaction]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return [Transaction(**t) for t in raw.get("transactions", [])]
        except (json.JSONDecodeError, TypeError) as exc:
            log.error("Corrupt rename history %s: %s", self.path, exc)
            return []

    def _save(self, txs: list[Transaction]) -> None:
        data = {"version": 1, "transactions": [asdict(t) for t in txs[-MAX_HISTORY:]]}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)

    def push(self, tx: Transaction) -> None:
        txs = self.load()
        txs.append(tx)
        self._save(txs)

    def pop(self) -> Transaction | None:
        txs = self.load()
        if not txs:
            return None
        tx = txs.pop()
        self._save(txs)
        return tx

    def peek(self) -> Transaction | None:
        txs = self.load()
        return txs[-1] if txs else None


def execute_plan(entries: Sequence[RenameEntry], history: RenameHistory | None = None) -> Transaction | None:
    """Apply the OK entries of a plan. Returns the recorded transaction (or None if nothing to do)."""
    todo = [e for e in entries if e.status is Status.OK]
    if not todo:
        return None
    _apply_moves([(e.src, e.dst) for e in todo])
    tx = Transaction(uuid.uuid4().hex, time.time(), [{"src": str(e.src), "dst": str(e.dst)} for e in todo])
    if history:
        history.push(tx)
    log.info("Renamed %d file(s)", len(todo))
    return tx


def undo_last(history: RenameHistory) -> Transaction | None:
    """Reverse the most recent transaction. Raises if files were moved/created since."""
    tx = history.peek()
    if tx is None:
        return None
    pairs = [(Path(op["dst"]), Path(op["src"])) for op in tx.ops]
    leaving = {_key(src) for src, _ in pairs}
    for cur, orig in pairs:
        if not cur.exists():
            raise FileNotFoundError(f"Cannot undo: {cur} no longer exists")
        if orig.exists() and _key(orig) not in leaving:
            raise FileExistsError(f"Cannot undo: {orig} is occupied")
    _apply_moves(pairs)
    history.pop()
    log.info("Undid rename of %d file(s)", len(pairs))
    return tx
