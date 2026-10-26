"""Preview backend: texture / HDR / PSD decoding and the local asset server for the 3D viewer.

Everything returns numpy RGBA arrays so the UI layer only has to wrap them in a QImage.
"""
from __future__ import annotations

import mimetypes
import os
import secrets
import threading
from dataclasses import dataclass, field
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import numpy as np

from utils.file_helpers import is_within
from utils.logger import get_logger

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")  # must be set before cv2 is imported

log = get_logger("preview")

HDR_EXTS = {".exr", ".hdr"}
CHANNEL_MODES = ("rgba", "rgb", "alpha", "r", "g", "b")


class PreviewError(Exception):
    pass


@dataclass
class TextureData:
    pixels: np.ndarray        # H x W x 4, uint8 (LDR) or float32 (HDR / 16-bit)
    source_channels: int
    info: dict = field(default_factory=dict)

    @property
    def is_float(self) -> bool:
        return self.pixels.dtype == np.float32

    @property
    def width(self) -> int:
        return self.pixels.shape[1]

    @property
    def height(self) -> int:
        return self.pixels.shape[0]


def _to_rgba(arr: np.ndarray) -> tuple[np.ndarray, int]:
    if arr.ndim == 2:
        arr = arr[:, :, None]
    c = arr.shape[2]
    if c == 1:
        rgb = np.repeat(arr, 3, axis=2)
        alpha = None
    elif c == 2:  # luminance + alpha
        rgb, alpha = np.repeat(arr[:, :, :1], 3, axis=2), arr[:, :, 1:2]
    else:
        rgb, alpha = arr[:, :, :3], (arr[:, :, 3:4] if c >= 4 else None)
    if alpha is None:
        full = 1.0 if arr.dtype.kind == "f" else np.iinfo(arr.dtype).max
        alpha = np.full(rgb.shape[:2] + (1,), full, dtype=arr.dtype)
    return np.ascontiguousarray(np.concatenate([rgb, alpha], axis=2)), c


def _read_cv2(path: Path) -> np.ndarray:
    import cv2

    # imdecode instead of imread: cv2.imread cannot open non-ASCII paths on Windows
    buf = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise PreviewError(f"OpenCV could not decode {path.name}")
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA if img.shape[2] == 4 else cv2.COLOR_BGR2RGB)
    return img


def _read_exr(path: Path) -> tuple[np.ndarray, dict]:
    """Read the main RGB(A) layer of an OpenEXR file (OpenCV wheels ship without the EXR codec)."""
    import OpenEXR

    with OpenEXR.File(str(path)) as f:
        channels = f.channels()  # interleaves R,G,B(,A) of each layer into "RGB" / "RGBA" / "layer.RGBA"
        if not channels:
            raise PreviewError(f"{path.name} has no readable channels")
        key = next((k for k in ("RGBA", "RGB", "Y") if k in channels), None) or sorted(channels)[0]
        arr = np.array(channels[key].pixels, dtype=np.float32)  # copy while the file is open
        meta = {"exr_channels": ", ".join(sorted(channels)), "exr_layer": key,
                "compression": str(f.header().get("compression", "")).split(".")[-1]}
    return arr, meta


def _is_high_bit_depth(im, path: Path) -> bool:
    """Pillow silently reduces 16-bit RGB(A) PNG / TIFF to 8 bit, so check the file itself."""
    if im.mode in {"I;16", "I;16B", "I;16L", "I", "F"}:
        return True
    if im.format == "PNG":
        with open(path, "rb") as f:
            header = f.read(25)
        return len(header) == 25 and header[24] == 16  # IHDR bit depth
    if im.format == "TIFF":
        bits = im.tag_v2.get(258, (8,))
        return max(bits if isinstance(bits, tuple) else (bits,)) > 8
    return False


def load_texture(path: str | os.PathLike) -> TextureData:
    path = Path(path)
    ext = path.suffix.lower()
    info = {"file": path.name, "format": ext.lstrip(".").upper(), "file_size": path.stat().st_size}

    if ext in HDR_EXTS:
        if ext == ".exr":
            arr, meta = _read_exr(path)
            info.update(meta)
        else:
            arr = _read_cv2(path).astype(np.float32)
        rgba, c = _to_rgba(arr)
        info.update(mode="float32 HDR", bit_depth=32)
        return TextureData(rgba, c, info)

    from PIL import Image

    try:
        with Image.open(path) as im:
            info.update(mode=im.mode, pil_format=im.format)
            if _is_high_bit_depth(im, path):
                raise ValueError("high bit depth")  # decode with OpenCV instead
            rgba = np.asarray(im.convert("RGBA"))
            channels = len(im.getbands())
            info["bit_depth"] = 8
            return TextureData(np.ascontiguousarray(rgba), channels, info)
    except ValueError:
        pass
    except Exception as exc:
        if ext in {".dds", ".tga"}:
            raise PreviewError(f"Unsupported {ext} variant: {exc}") from exc
        log.debug("Pillow failed on %s (%s), trying OpenCV", path, exc)

    arr = _read_cv2(path)
    if arr.dtype == np.uint8:
        rgba, c = _to_rgba(arr)
        info["bit_depth"] = 8
        return TextureData(rgba, c, info)
    scale = np.iinfo(arr.dtype).max if arr.dtype.kind in "ui" else 1.0
    rgba, c = _to_rgba(arr.astype(np.float32) / scale)
    info["bit_depth"] = arr.dtype.itemsize * 8
    return TextureData(rgba, c, info)


def render_texture(tex: TextureData, exposure: float = 0.0, gamma: float = 1.0, channel: str = "rgba") -> np.ndarray:
    """Map texture data to a displayable H x W x 4 uint8 array.

    ``exposure`` is in stops, ``gamma`` is the display gamma (2.2 for linear HDR data, 1.0 for sRGB textures).
    """
    if channel not in CHANNEL_MODES:
        raise ValueError(channel)
    px = tex.pixels
    if tex.is_float or exposure != 0.0 or gamma != 1.0:
        f = px.astype(np.float32) if not tex.is_float else px.copy()
        if not tex.is_float:
            f /= 255.0
        rgb = f[:, :, :3]
        if exposure:
            rgb *= 2.0 ** exposure
        np.clip(rgb, 0.0, 1.0, out=rgb)
        if gamma != 1.0:
            np.power(rgb, 1.0 / gamma, out=rgb)
        np.clip(f[:, :, 3], 0.0, 1.0, out=f[:, :, 3])
        px = (f * 255.0 + 0.5).astype(np.uint8)

    if channel == "rgba":
        return np.ascontiguousarray(px)
    out = np.empty_like(px)
    if channel == "rgb":
        out[:, :, :3] = px[:, :, :3]
    else:
        idx = {"r": 0, "g": 1, "b": 2, "alpha": 3}[channel]
        out[:, :, :3] = px[:, :, idx:idx + 1]
    out[:, :, 3] = 255
    return out


# --------------------------------------------------------------------------- PSD


@dataclass
class PsdLayer:
    layer_id: int
    name: str
    kind: str
    visible: bool
    bbox: tuple[int, int, int, int]
    depth: int
    children: list["PsdLayer"] = field(default_factory=list)


class PsdDocument:
    """Photoshop file wrapper with per-layer visibility and re-compositing."""

    def __init__(self, path: str | os.PathLike):
        from psd_tools import PSDImage

        self.path = Path(path)
        self.psd = PSDImage.open(self.path)
        # layer_id is not guaranteed unique (e.g. files written by scripts), so key layers by position
        self._layers = list(self.psd.descendants())
        self._index = {id(layer): i for i, layer in enumerate(self._layers)}

    @property
    def info(self) -> dict:
        mode = self.psd.color_mode
        return {
            "file": self.path.name, "format": "PSD", "width": self.psd.width, "height": self.psd.height,
            "color_mode": getattr(mode, "name", str(mode)), "bit_depth": self.psd.depth,
            "layers": len(self._layers), "file_size": self.path.stat().st_size,
        }

    def layer_tree(self) -> list[PsdLayer]:
        def build(group, depth):
            out = []
            for layer in reversed(list(group)):  # top-most first, like Photoshop's panel
                node = PsdLayer(self._index[id(layer)], layer.name, layer.kind, layer.visible, tuple(layer.bbox), depth)
                if layer.is_group():
                    node.children = build(layer, depth + 1)
                out.append(node)
            return out

        return build(self.psd, 0)

    def set_visible(self, layer_id: int, visible: bool) -> None:
        self._layers[layer_id].visible = visible

    def composite(self) -> np.ndarray:
        try:
            img = self.psd.composite(force=bool(self._layers)) if self._layers else self.psd.composite()
        except Exception as exc:  # unsupported effects etc.: fall back to the embedded merged image
            log.warning("PSD composite failed (%s), using embedded preview", exc)
            img = self.psd.topil()
        if img is None:
            raise PreviewError("PSD has no composite image")
        return np.ascontiguousarray(np.asarray(img.convert("RGBA")))


# --------------------------------------------------------------------------- local asset server

WEB_ROOT = Path(__file__).resolve().parent.parent / "ui" / "web"

for _ext, _type in {
    ".js": "text/javascript", ".mjs": "text/javascript", ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json", ".fbx": "application/octet-stream", ".obj": "text/plain",
    ".mtl": "text/plain", ".tga": "image/x-tga", ".dds": "image/vnd-ms.dds",
}.items():
    mimetypes.add_type(_type, _ext)


class _Handler(SimpleHTTPRequestHandler):
    server: "AssetServer"

    def log_message(self, fmt, *args):  # keep the console quiet
        log.debug("http: " + fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        parts = unquote(urlsplit(path).path).lstrip("/").split("/", 2)
        if parts[0] == "web" and len(parts) > 1:
            target = WEB_ROOT.joinpath(*"/".join(parts[1:]).split("/"))
            return str(target) if is_within(target, WEB_ROOT) else ""
        if parts[0] == "fs" and len(parts) == 3:
            root = self.server.roots.get(parts[1])
            if root is None:
                return ""
            target = root.joinpath(*parts[2].replace("\\", "/").split("/"))
            if not is_within(target, root):
                target = root / target.name
            if target.is_file():
                return str(target)
            # broken relative path: look the file up by name (may live in a registered extra dir)
            found = self.server.find_by_name(parts[1], target.name)
            return str(found) if found else ""
        return ""

    def send_head(self):
        if not self.translate_path(self.path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()


class AssetServer(ThreadingHTTPServer):
    """Serves the viewer and the files of registered asset folders on 127.0.0.1 only."""

    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), partial(_Handler, directory=str(WEB_ROOT)))
        self.roots: dict[str, Path] = {}
        self.extra_dirs: dict[str, list[Path]] = {}
        self._name_index: dict[str, dict[str, Path]] = {}
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"

    def start(self) -> "AssetServer":
        if self._thread is None:
            self._thread = threading.Thread(target=self.serve_forever, name="AssetServer", daemon=True)
            self._thread.start()
            log.info("Asset server on %s", self.base_url)
        return self

    def stop(self) -> None:
        if self._thread is not None:
            self.shutdown()
            self.server_close()
            self._thread = None

    def register_root(self, folder: str | os.PathLike) -> str:
        folder = Path(folder).resolve()
        for token, root in self.roots.items():
            if root == folder:
                return token
        token = secrets.token_hex(8)
        self.roots[token] = folder
        return token

    def url_for(self, file: str | os.PathLike, extra_dirs: list[str | os.PathLike] | None = None) -> str:
        """URL of ``file``. ``extra_dirs`` are folders where textures with broken paths may be found
        by name (e.g. folders FBX Doctor resolved absolute paths to)."""
        file = Path(file).resolve()
        token = self.register_root(file.parent)
        if extra_dirs:
            dirs = self.extra_dirs.setdefault(token, [])
            for d in map(Path, extra_dirs):
                if d.is_dir() and d not in dirs:
                    dirs.append(d)
                    self._name_index.pop(token, None)
        return f"{self.base_url}/fs/{token}/{quote(file.name)}"

    def find_by_name(self, token: str, name: str, max_depth: int = 3) -> Path | None:
        if token not in self._name_index:
            index: dict[str, Path] = {}
            for root, depth in [(self.roots[token], max_depth)] + [(d, 1) for d in self.extra_dirs.get(token, [])]:
                base = len(root.parts)
                for dirpath, dirnames, filenames in os.walk(root):
                    if len(Path(dirpath).parts) - base >= depth - 1:
                        dirnames[:] = []
                    for f in filenames:
                        index.setdefault(f.lower(), Path(dirpath, f))
            self._name_index[token] = index
        return self._name_index[token].get(name.lower())

    @property
    def viewer_url(self) -> str:
        return f"{self.base_url}/web/viewer3d.html"
