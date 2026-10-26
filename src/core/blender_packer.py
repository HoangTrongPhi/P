"""Blender 5.0+ discovery and headless pack / consolidate runner."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Callable

from utils.logger import get_logger

log = get_logger("blender")

MIN_VERSION = (5, 0)
SCRIPT_PATH = Path(__file__).resolve().parent.parent / "blender_scripts" / "headless_pack.py"
_VERSION_RE = re.compile(r"Blender\s+(\d+)\.(\d+)(?:\.(\d+))?")
_PROGRESS_RE = re.compile(r"^PP_PROGRESS (\d+)/(\d+) (.*)$")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@dataclass(frozen=True)
class BlenderInstall:
    executable: Path
    version: tuple[int, int, int]

    @property
    def version_string(self) -> str:
        return ".".join(map(str, self.version))

    @property
    def supported(self) -> bool:
        return self.version[:2] >= MIN_VERSION

    def __str__(self) -> str:
        return f"Blender {self.version_string}  ({self.executable})"


@lru_cache(maxsize=32)
def probe_version(executable: str) -> tuple[int, int, int] | None:
    """Run ``blender --version`` (cached). Returns None if it is not a working Blender."""
    try:
        out = subprocess.run(
            [executable, "--version"], capture_output=True, text=True, timeout=60, creationflags=_NO_WINDOW
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = _VERSION_RE.search(out)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)) if m else None


def _registry_candidates() -> list[Path]:
    if sys.platform != "win32":
        return []
    import winreg

    found = []
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\BlenderFoundation", "Install_Dir"),
        (winreg.HKEY_CLASSES_ROOT, r"blendfile\shell\open\command", ""),
    ]
    for hive, sub, value in keys:
        try:
            with winreg.OpenKey(hive, sub) as k:
                raw, _ = winreg.QueryValueEx(k, value)
        except OSError:
            continue
        raw = raw.strip()
        if raw.startswith('"'):
            raw = raw[1:raw.index('"', 1)]
        p = Path(raw)
        found.append(p / "blender.exe" if p.is_dir() else p)
    return found


def _candidate_paths() -> list[Path]:
    exe = "blender.exe" if sys.platform == "win32" else "blender"
    cands: list[Path] = []
    if env := os.environ.get("BLENDER_PATH"):
        cands.append(Path(env))
    if which := shutil.which("blender"):
        cands.append(Path(which))
    cands += _registry_candidates()
    if sys.platform == "win32":
        for base in {os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramW6432", "")}:
            if base:
                cands += sorted(Path(base, "Blender Foundation").glob(f"Blender*/{exe}"))
        steam = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Steam/steamapps/common/Blender", exe)
        cands.append(steam)
    elif sys.platform == "darwin":
        cands.append(Path("/Applications/Blender.app/Contents/MacOS/Blender"))
    else:
        cands += [Path("/usr/bin/blender"), Path("/snap/bin/blender")]
    return cands


def discover_blenders() -> list[BlenderInstall]:
    """All working Blender installs found on this machine, newest first."""
    seen, installs = set(), []
    for c in _candidate_paths():
        try:
            if not c.is_file():
                continue
            key = os.path.normcase(str(c.resolve()))
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        if (ver := probe_version(str(c))) is not None:
            installs.append(BlenderInstall(c, ver))
    installs.sort(key=lambda b: b.version, reverse=True)
    log.info("Found %d Blender install(s): %s", len(installs), ", ".join(b.version_string for b in installs))
    return installs


def best_blender() -> BlenderInstall | None:
    return next((b for b in discover_blenders() if b.supported), None)


@dataclass
class PackOptions:
    consolidate: bool = True     # copy external files into //textures and remap
    unpack: bool = False         # unpack embedded files into //textures
    make_relative: bool = True
    pack_all: bool = False
    output: Path | None = None   # save as a new .blend (otherwise overwrite; Blender keeps .blend1)
    analyse_only: bool = False
    zip_archive: Path | None = None  # bundle the result (+ textures/assets folders) into a zip

    def to_args(self) -> list[str]:
        args = []
        if self.consolidate:
            args.append("--consolidate")
        if self.unpack:
            args.append("--unpack")
        if self.make_relative:
            args.append("--relative")
        if self.pack_all:
            args.append("--pack")
        if self.analyse_only:
            args.append("--no-save")
        if self.output:
            args += ["--output", str(self.output)]
        return args


@dataclass
class PackResult:
    ok: bool
    report: dict = field(default_factory=dict)
    returncode: int | None = None
    output_lines: list[str] = field(default_factory=list)
    archive: Path | None = None
    cancelled: bool = False

    @property
    def missing(self) -> list[dict]:
        return self.report.get("missing", [])

    @property
    def error(self) -> str | None:
        if self.cancelled:
            return "Cancelled"
        return self.report.get("error") or (None if self.ok else f"Blender exited with code {self.returncode}")


def run_pack(
    blender: str | os.PathLike | BlenderInstall,
    blend_file: str | os.PathLike,
    options: PackOptions,
    on_output: Callable[[str], None] | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
    cancel: threading.Event | None = None,
    timeout: float = 1800,
) -> PackResult:
    """Run ``headless_pack.py`` in Blender's background mode (blocking; call from a worker thread)."""
    exe = blender.executable if isinstance(blender, BlenderInstall) else Path(blender)
    blend_file = Path(blend_file)
    if not blend_file.is_file():
        raise FileNotFoundError(blend_file)

    with tempfile.TemporaryDirectory(prefix="pp_blender_") as tmp:
        report_path = Path(tmp, "report.json")
        cmd = [str(exe), "-b", "--factory-startup", str(blend_file), "-P", str(SCRIPT_PATH),
               "--", "--report", str(report_path), *options.to_args()]
        log.info("Running: %s", subprocess.list2cmdline(cmd))
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace", creationflags=_NO_WINDOW,
        )
        lines: list[str] = []
        cancelled = False

        stop = cancel or threading.Event()

        def watchdog():
            nonlocal cancelled
            waited = 0.0
            while proc.poll() is None:
                if stop.wait(0.2) or waited > timeout:
                    cancelled = True
                    proc.kill()
                    return
                waited += 0.2

        threading.Thread(target=watchdog, daemon=True).start()
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip()
            lines.append(line)
            if m := _PROGRESS_RE.match(line):
                if on_progress:
                    on_progress(int(m.group(1)), int(m.group(2)), m.group(3))
            if on_output:
                on_output(line)
        proc.wait()

        report = {}
        if report_path.exists():
            report = json.loads(report_path.read_text(encoding="utf-8"))
        result = PackResult(bool(report.get("ok")) and not cancelled, report, proc.returncode, lines, cancelled=cancelled)

    if result.ok and options.zip_archive and not options.analyse_only:
        result.archive = bundle_archive(Path(result.report.get("blend") or blend_file), options.zip_archive)
    return result


def bundle_archive(blend_file: Path, archive: Path) -> Path:
    """Zip the .blend plus its sibling ``textures/`` and ``assets/`` folders."""
    archive = Path(archive)
    archive.parent.mkdir(parents=True, exist_ok=True)
    root = blend_file.parent
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(blend_file, blend_file.name)
        for sub in ("textures", "assets", "sounds", "fonts"):
            folder = root / sub
            if folder.is_dir():
                for f in sorted(folder.rglob("*")):
                    if f.is_file():
                        zf.write(f, f.relative_to(root).as_posix())
    log.info("Archive written: %s", archive)
    return archive
