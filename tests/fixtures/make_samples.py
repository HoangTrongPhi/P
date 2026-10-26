"""Generate 2D sample assets (textures of every supported format + a layered PSD).

    python tests/fixtures/make_samples.py <out_dir>
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")

import numpy as np
from PIL import Image


def gradient(w: int = 256, h: int = 256) -> np.ndarray:
    x = np.linspace(0, 1, w, dtype=np.float32)
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    r = np.broadcast_to(x, (h, w))
    g = np.broadcast_to(y, (h, w))
    b = 0.5 + 0.5 * np.sin(r * 12) * np.cos(g * 12)
    return np.stack([r, g, b], axis=2)


def make_textures(out: Path) -> list[Path]:
    import cv2

    out.mkdir(parents=True, exist_ok=True)
    rgb = gradient()
    alpha = (np.hypot(*np.meshgrid(np.linspace(-1, 1, 256), np.linspace(-1, 1, 256))) < 0.9).astype(np.float32)
    rgba8 = (np.dstack([rgb, alpha]) * 255).astype(np.uint8)
    files = []

    for name in ("wood_planks_basecolor.png", "wood_planks_normal.png", "rock01_Roughness.png"):
        Image.fromarray(rgba8 if "basecolor" in name else rgba8[:, :, :3]).save(out / name)
        files.append(out / name)
    Image.fromarray(rgba8[:, :, :3]).save(out / "metal_plate_diff.jpg", quality=90)
    Image.fromarray(rgba8).save(out / "decal_alpha.tga")
    Image.fromarray(rgba8).save(out / "ui_icon.dds")
    files += [out / "metal_plate_diff.jpg", out / "decal_alpha.tga", out / "ui_icon.dds"]

    hdr = (rgb * 8.0).astype(np.float32)  # values well above 1.0
    cv2.imwrite(str(out / "sky_studio.hdr"), cv2.cvtColor(hdr, cv2.COLOR_RGB2BGR))
    import OpenEXR

    exr_header = {"compression": OpenEXR.ZIP_COMPRESSION, "type": OpenEXR.scanlineimage}
    OpenEXR.File(exr_header, {"RGBA": np.dstack([hdr, alpha]).astype(np.float32)}).write(str(out / "sky_studio.exr"))
    png16 = (rgb * 65535).astype(np.uint16)
    cv2.imwrite(str(out / "height_16bit.png"), cv2.cvtColor(png16, cv2.COLOR_RGB2BGR))
    files += [out / "sky_studio.hdr", out / "sky_studio.exr", out / "height_16bit.png"]
    return files


def make_psd(path: Path) -> Path:
    from psd_tools import PSDImage
    from psd_tools.api.layers import PixelLayer

    psd = PSDImage.new("RGBA", (256, 256), color=(40, 44, 52, 255))
    bg = Image.new("RGBA", (256, 256), (40, 44, 52, 255))
    red = Image.new("RGBA", (128, 128), (220, 60, 60, 255))
    blue = Image.new("RGBA", (128, 128), (60, 120, 230, 200))
    psd.append(PixelLayer.frompil(bg, psd, "Background"))
    psd.append(PixelLayer.frompil(red, psd, "Red Square", top=32, left=32))
    psd.append(PixelLayer.frompil(blue, psd, "Blue Square", top=96, left=96))
    psd.save(path)
    return path


if __name__ == "__main__":
    target = Path(sys.argv[1])
    for f in make_textures(target / "textures"):
        print(f)
    (target / "source").mkdir(parents=True, exist_ok=True)
    print(make_psd(target / "source" / "poster.psd"))
