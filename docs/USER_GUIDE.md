# Project P — User Guide

Project P is a desktop toolkit for cleaning up 3D asset folders before they go to another
workstation, a render farm or a game engine. It has five tabs; every tab accepts **drag & drop**
of files or folders anywhere on the window, and every long operation runs in the background
with a progress bar and a **Cancel** button in the status bar. All activity is written to the
**Log** panel at the bottom.

## Installation

Requirements: Windows 10/11, Python 3.11+ and (for the Blender tab) Blender 5.0 or newer.

```bash
run.bat
```

The first run creates `.venv` and installs `requirements.txt`; later runs start immediately.
Manual start: `.venv\Scripts\python.exe src\app.py [file-or-folder]`.

---

## 1. Batch Renamer

1. Pick a folder (or drop a folder / a set of files). Choose a file filter and whether to recurse.
2. Build the rules. They are applied in this order, and the extension is never touched:
   * **Preset** — industry naming conventions:

     | Asset | Unreal Engine 5 | Unity |
     | --- | --- | --- |
     | Static mesh `chair.fbx` | `SM_Chair.fbx` | `Chair.fbx` |
     | Skeletal mesh `hero_skel.fbx` | `SK_Hero.fbx` | `Hero.fbx` |
     | `wood_planks_basecolor.png` | `T_WoodPlanks_D.png` | `WoodPlanks_Albedo.png` |
     | `metal_nrm.png` | `T_Metal_N.png` | `Metal_Normal.png` |
     | `rock01_Roughness.tga` | `T_Rock_01_R.tga` | `Rock_01_Roughness.tga` |
     | `crate_ORM.png` / `crate_arm.png` | `T_Crate_ORM.png` | `Crate_MaskMap.png` |

     Recognised map suffixes: base color / albedo / diffuse / color (`_D`), normal / nrm / nor (`_N`),
     roughness (`_R`), metallic / metalness (`_M`), ORM / ARM, AO / occlusion, emissive, height /
     displacement / bump, opacity / alpha, mask, specular. Existing `SM_`, `SK_`, `T_`, `TX_` prefixes
     are recognised, so already-compliant names stay unchanged. `.blend` files are never renamed by presets.
   * **Search / Replace** — literal text or a regular expression (`\1` back-references in regex mode).
   * **Case** — camelCase, snake_case, PascalCase, UPPER_CASE, lowercase, kebab-case.
   * **Prefix / Suffix** — skipped when the name already has it.
3. The table is a live **dry run**:
   * `OK` — will be renamed.
   * `Skipped` — name unchanged.
   * `Warning: Collision` — two files would get the same name, or the target already exists. These files are skipped.
   * `Error: Invalid name` — characters Windows does not allow, reserved names, etc.
4. **Apply Rename** renames every `OK` row. If anything fails part-way, everything already renamed
   is rolled back. Swaps (`a→b` and `b→a`) and case-only changes are handled safely.
5. **Undo Last** reverses the most recent rename in that folder. History (last 50 operations) is stored in
   `.rename_history.json` inside the folder, so undo also works after restarting the app.

## 2. FBX Path Doctor

FBX files exported from 3ds Max / Maya / Blender often store machine-specific texture paths
(`C:\Users\John\Desktop\wood.png`). On another machine every material link breaks.

1. Pick a folder of `.fbx` files (or drop files) and **Scan**. Both Binary 7.x (including the 64-bit 7.5+
   layout) and ASCII FBX are supported. No Autodesk SDK is needed.
2. Each file lists every path field (`FileName`, `RelativeFilename`, `Properties70 Path/RelPath`) of every
   Video / Texture object:
   * **Type** — `ABSOLUTE_LOCAL` (red), `UNC_NETWORK` (amber), `RELATIVE_PORTABLE` (green).
   * **On disk** — `Found`, `Found by name` (the path is wrong but a file with that name exists next to
     the FBX, in its sub-folders, or where a sibling field points), `Missing`, or `Embedded` (the media is
     packed inside the FBX).
3. Choose a fix mode:
   * **Convert to relative** — point at the actual texture location relative to the FBX
     (`../textures/wood.png`). With *Rebase folder* every texture is pointed at that folder instead.
   * **Strip to file name** — `C:\path\to\wood.png` → `wood.png`.
   * **Collect & relink** — copy every found texture into `<fbx folder>/<subfolder>/` (default `textures`)
     and point the FBX there. This is the best choice before sending a model to someone else.
4. **Dry Run** writes what would change to the log without touching files. **Fix Paths** applies it to
   the selected files (or all scanned files). By default only problematic paths are rewritten; tick
   *Rewrite all paths* to normalise every path (useful with Collect).
5. A backup `<name>.fbx.bak` of the original is created the first time a file is fixed (an existing
   backup is never overwritten, so it always holds the true original). **Restore Backup** puts it back.

Rewritten paths always use forward slashes, which every DCC and engine accepts on every OS.

## 3. Blender Packer (Blender 5.0+)

1. Installed Blender versions are detected automatically (`BLENDER_PATH` environment variable, `PATH`,
   the Windows registry, `C:\Program Files\Blender Foundation\Blender *`, Steam). Use **Browse…** for a
   portable install.
2. Add `.blend` files (or drop files / folders).
3. Choose operations (run in this order):
   * **Consolidate external files into //textures** — copy every referenced image next to the `.blend`
     (`//textures/`, other media into `//assets/`) and repoint the data-blocks. Same-named files from
     different folders are disambiguated (`wood_1.png`) instead of overwritten.
   * **Unpack embedded files** — Blender's *Unpack All → Write files to current directory*.
   * **Make all paths relative**.
   * **Pack all resources into the .blend** — single self-contained file.
   * **Analyse only** — report dependencies without modifying anything.
4. Output: overwrite in place (Blender keeps the previous version as `.blend1`) or save copies into an
   output folder (`<output>/<name>/<name>.blend` + its `textures/`). Optionally bundle each result into
   a `.zip`.
5. The **Dependency report** lists every image / sound / font / library / cache file after processing:
   `Relative`, `Absolute`, `Packed` or `Missing`.

Blender runs headless (`blender -b --factory-startup <file> -P headless_pack.py`), so your open Blender
session and add-ons are not affected.

## 4. Asset Previewer

Browse a folder on the left or drop a file.

* **3D** (`.fbx .obj .glb .gltf`) — Three.js WebGL viewport. Left-drag orbit, right-drag pan, wheel zoom.
  Toolbar: Wireframe, UV Checker (replaces materials with a coloured checker to inspect UV layout),
  Grid, Frame. Statistics: meshes, vertices, triangles, materials, UV sets, skinned meshes, animations
  and bounding-box size. OBJ files load their `.mtl`; glTF / FBX textures are loaded even when the FBX
  contains absolute paths from another machine (they are looked up by name next to the model and in
  the folders FBX Doctor resolves). TGA textures are supported; animations play automatically.
* **Textures** (`.png .jpg .tga .dds .bmp .tif .exr .hdr`, 8/16/32-bit) — pan (drag) / zoom (wheel),
  Fit and 1:1. Channel view RGBA / RGB / Alpha / R / G / B; transparency on a checkerboard.
  Exposure (±8 EV) and Gamma; HDR / EXR open with gamma 2.2 automatically. Hovering shows the pixel
  coordinates and the raw value (floating point for HDR data).
* **Photoshop** (`.psd`) — full composite rendered without Photoshop, plus the layer tree. Untick a
  layer to hide it and re-composite (turn off *Live update* for large files and press *Re-composite*).

## 5. Pipeline Tools

* **Find Duplicates** — byte-identical assets (size first, then SHA-1) with the reclaimable size.
* **Find Unused Textures** — textures that no FBX, OBJ `.mtl` or glTF in the folder references.
  `.blend` files are not inspected, so textures used only by Blender scenes are listed too.

Double-click a result to reveal it in Explorer.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| 3D view stays empty | Check the Log for `3D viewer:` errors. The viewer needs GPU / WebGL support from QtWebEngine. |
| No Blender found | Install Blender 5.0+ or press *Browse…* and select `blender.exe`. Setting the `BLENDER_PATH` environment variable also works. |
| `.dds` fails to open | Only formats Pillow decodes are supported (DXT1/3/5, BC4/5/7, uncompressed). |
| Undo refuses to run | A file was renamed / created after the rename. Resolve the conflict shown in the message and try again. |

## Running the self-tests

```bash
.venv\Scripts\python.exe -m pytest
```

Tests that need Blender are skipped automatically when no Blender 5.0+ is installed.
