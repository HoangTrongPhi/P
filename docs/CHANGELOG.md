# Changelog - 3D Asset Toolkit (Project P)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### V2 pipeline features
- **Texture sets** (Pipeline Tools): textures are grouped into material sets by their map suffix
  (`_BaseColor`, `_N`, `_Roughness`, `_Gloss`, `_ORM`, …), with the maps each set lacks; tick the
  ORM-ready sets and pack all of them at once (gloss maps are inverted into roughness).
- **Texture converter**: downscale to a maximum size, snap to powers of two, flip the normal map
  green channel (DirectX <-> OpenGL) and convert to PNG / TGA / JPG / uncompressed DDS with a full
  mip chain. Output goes to a `converted/` folder by default; existing files are never replaced
  unless asked; dry run available. HDR sources are skipped instead of clipped.
- **Mesh inspector**: triangles, vertices, UV sets, materials, normals, local bounds, units and up
  axis of FBX (binary incl. zlib arrays, and ASCII), OBJ, glTF and GLB, read in Rust without the
  viewport; warnings for missing UVs / normals, unusual units, odd sizes and a triangle budget.
- **Unused textures read `.blend` files** through headless Blender (opt-in, one file at a time);
  the report counts the `.blend` files read and skipped.
- **Reports**: duplicates, unused textures, texture sets, meshes, conversions, FBX scans and recipe
  runs export to a standalone HTML page or a CSV table (UTF-8 with BOM for Excel).
- **Recipes tab + command line**: chain rename, FBX fix, ORM packing, conversion, mesh inspection
  and the finders into a saved JSON recipe; dry run first, then run for real. The same file runs
  headless with `project-p.exe --recipe <file> <folder> [--dry-run] [--report out.json]`.
- **Fix**: images are opened by their content, not only their extension, so a PNG saved as `.tga`
  decodes in the previewer, the ORM packer and the converter.

### Asset Previewer — inspection features
- **Material inspector** (palette button): every material with its texture slots (base color,
  normal, roughness, metalness, AO, emissive, …), embedded / missing marked; a found texture opens
  in the texture inspector with a "Back" button to the model. Works for FBX, OBJ + MTL and glTF.
- **Lighting panel**: environment Studio / None / any HDR or EXR (from the folder or browsed), env
  strength, exposure (±3 stops), key light direction / height / intensity, follow-camera, and
  environment as background. FBX / OBJ Phong materials only react to the lights.
- **Pivot / axes and skeleton** toggles (skeleton only when the model has bones); stats gain bones
  and the FBX file unit. Warnings for an odd scale (largest side > 200 m or < 2 cm, using the FBX
  `UnitScaleFactor`) and for a pivot far from the geometry.
- **Thumbnail grid** (default; list view one click away). Thumbnails render off-screen when they
  scroll into view and are cached in IndexedDB by path + size + modification time. Clear now also
  empties this cache.
- **Auto-reload**: the open file (and a model's textures) is polled; once a change has settled it
  reloads keeping the camera / zoom. Manual reload button next to the path.
- **Fix: app closed on dropping a big model** (found with a 132 × 4K-texture hotel pack). The
  WebView's GPU process ran out of memory (5.1 GB) and took the app down without a log line.
  Textures are now capped before upload (2048 px in the viewport, 128 px for thumbnails; the
  texture inspector still opens the full file), resized on a CPU canvas, StrictMode's throw-away
  mount no longer loads the model a second time, superseded loads are disposed, and viewers
  release their WebGL context on unmount. Same file now peaks at about 1 GB.
- **Save view as PNG** (camera button): 2× resolution, transparent background, no grid. Needs the
  new `fs:allow-write-file` permission, scoped to `*.png`.

### V2 migration — Phase 3: previewer and pipeline tools
- **Asset Previewer**: Three.js viewport for FBX, OBJ (+MTL), glTF and GLB loaded through `asset://`
  (absolute and relative texture paths resolved, TGA / DDS textures), studio lighting, scaled ground
  grid, shaded / wireframe / UV checker / normals modes, reset camera, stats HUD (triangles,
  vertices, meshes, materials, UV sets, skinning, animations, size) and a missing-texture warning.
- **Texture inspector**: GPU pan / zoom-to-cursor, exposure (−5…+5 stops) and gamma (0.2…3.0) in
  linear light, channel isolation (RGBA, RGB, A, R, G, B) over a checkerboard; PNG, JPG, WebP, BMP,
  TGA, DDS, HDR, EXR in the webview, PSD composite and TIFF decoded in Rust.
- **PSD composite reader** in Rust (RGB, grayscale, indexed, CMYK; 8 / 16 / 32-bit; raw and RLE;
  PSD and PSB): pixel-identical to psd-tools on the prototype's sample PSD.
- **Pipeline Tools**: ORM channel packer (R = AO, G = Roughness, B = Metallic; resampling, gloss
  inversion, PNG / TGA, name-based slot assignment on drop), duplicate finder (size pre-filter +
  parallel XXH3-128), unused-texture detector (FBX, MTL, glTF, GLB references), reveal in Explorer.
- The previewer is code-split: three.js (774 KB) loads only when the tab is first opened.
- Fix (found with a real project): three.js' FBXLoader drops texture directories and only looks
  next to the FBX, so `FBX/` + `Textures/` layouts showed no textures. The viewer now resolves FBX
  textures through the Rust doctor (also searching the parent folder). FBX Doctor gained an
  "Extra texture folders" option for scan and fix. Missing-texture warnings show plain file names.
- **FBX Doctor defaults changed (differs from the prototype)** after a Relative fix wrote guessed
  `textures/x.png` paths into a real file whose textures were in `../Textures`:
  - `searchParent` (on): textures are also looked up by name in the FBX folder's parent and its
    direct subfolders (never a drive root, never deeper), so `FBX/` + `Textures/` resolves.
  - `guessMissing` (off): in Relative and Collect mode a texture that cannot be found keeps its
    current path and is reported, instead of being rewritten to `<subfolder>/<name>`.
  - Both are checkboxes in the Fix panel; the prototype's behaviour is one click away.
- 51 Rust tests, including IPC tests for every new command.

### V2 migration — module UIs and IPC tests
- Renamer, FBX Doctor and Blender Packer tabs wired to the Phase 2 commands (live dry-run table,
  rule builder, preview-then-fix, Blender progress and report). Drops and dialogs route to the tab.
- `npm run dev` + `?mock` serves a fake backend for UI work in a plain browser (dev builds only).
- `src-tauri/src/ipc_tests.rs`: the real command set on Tauri's mock runtime, invoked with the same
  JSON the frontend stores send — renamer (scan, dry run, apply, history, undo, stale-plan refusal),
  FBX doctor (scan, preview, fix with backup and collect, restore) and Blender (discover, pack with
  progress events and zip, analyse-only, errors). 40 Rust tests in total.
- Commands are generic over the Tauri runtime; `build.rs` embeds the Common-Controls manifest via the
  linker so Windows test binaries start (tauri-build alone only covers the app binary).

### V2 migration (Tauri 2 + Rust) — Phase 2: core Rust engines
- `core::scanner`: walkdir traversal with parallel metadata reads (rayon), extension filters, skips
  VCS / cache folders.
- `core::renamer`: search/replace (literal or regex with `$1` references), prefix, suffix, 6 case styles,
  UE5 and Unity presets with the prototype's ~40 map aliases; dry-run plan with collision and
  invalid-name detection; two-phase swap-safe renames with rollback; undo stack in
  `.rename_history.json` (same file format as the prototype).
- `core::fbx`: binary FBX 7.x reader/writer (32-bit and 7.5+ 64-bit records, footer realignment),
  ASCII reader preserving formatting and line endings, path classification, disk resolution
  (name index up to 4 levels deep), `relative` / `strip` / `collect` fixes, `.fbx.bak` backups.
  Path strings are kept as raw bytes so non-UTF-8 values survive a rewrite.
- `core::blender_runner`: finds Blender via `BLENDER_PATH`, `PATH`, registry and Program Files;
  runs `headless_pack.py` with live `PP_PROGRESS` events, cancellation, timeout and zip bundling.
- IPC commands for all of the above, typed in `src/types/pipeline.ts` / `src/lib/ipc.ts`; the header
  asset counter now comes from a real scan when folders are dropped or opened.
- 35 Rust tests: ports of `test_renamer.py` / `test_fbx_doctor.py`, JSON contract tests, and a Blender
  5.2 integration test (pack, zip, and import of a Rust-rewritten FBX). Three real Blender FBX exports
  (up to 1.5 MB) round-trip byte-identical.

### V2 migration (Tauri 2 + Rust) — Phase 1: scaffold & UI system
- New `v2/` app (the Python prototype in `src/` is untouched and stays the porting reference).
- Tauri 2 backend (`v2/src-tauri`): dialog and fs plugins, `asset://` protocol enabled, CSP, capabilities,
  size-tuned release profile, all crates from the spec (`rayon`, `walkdir`, `regex`, `byteorder`, `image`,
  `xxhash-rust`, `flate2`). Commands: `app_info`, `log_history`. A log bus streams structured entries to the
  UI as `log://entry` events and buffers the last 1000 for late subscribers.
- React 19 + TypeScript + Tailwind v4 frontend with the Studio Dark palette: navigation rail, header
  dashboard (asset and broken-path counters), `Ctrl+K` / `Ctrl+P` command palette with fuzzy search,
  resizable log drawer with level filters, window-wide drag & drop with the prototype's tab routing.
- Module tabs are placeholders until their engines land in Phases 2–3.
- `headless_pack.py` copied to `v2/dcc_scripts/blender/` and bundled as a resource.

### Planned
- Standalone Windows build (PyInstaller / Nuitka) — not built yet; the app runs from source via `run.bat`.
- Texture usage inside `.blend` files for the unused-texture report (needs a headless Blender pass).
- DDS textures inside the 3D viewer (Three.js `DDSLoader`).

---

## [1.0.0] - 2026-10-26

All five implementation phases of the architecture blueprint are complete.
Self-tests: **65 automated tests pass** (`pytest`, Python 3.13, Blender 5.2.2), plus a 13-step
end-to-end GUI run covering every tab.

### Phase 1 — Core Engine
- **Asset scanner** (`core/scanner.py`): recursive, extension-filtered, cancellable scanning.
- **Batch renamer** (`core/renamer.py`):
  - Rules: search/replace (literal or regex), prefix, suffix, 6 case styles, and **Unreal Engine 5** /
    **Unity** presets (`SM_` / `SK_` meshes, `T_Name_D|N|R|M|ORM|AO|E|H|A|S` textures; Unity `_Albedo`,
    `_Normal`, `_MaskMap`, …) with alias detection for ~40 map-type spellings.
  - Dry-run planner with `OK` / `Skipped` / `Warning: Collision` / `Error: Invalid name` statuses
    (duplicate targets, existing files, Windows-invalid characters and reserved names).
  - Two-phase rename engine: safe swaps/chains and case-only renames, full rollback on failure.
  - Persistent undo stack in `.rename_history.json` (50 transactions), refuses to undo over new files.
- **FBX Path Doctor** (`core/fbx_doctor.py`):
  - Pure-Python Binary FBX 7.x parser/serializer (32-bit and 7.5+ 64-bit offsets) — untouched
    properties are kept verbatim, an unmodified round-trip is byte-identical, node offsets and the
    footer alignment are recomputed after edits.
  - ASCII FBX support preserving formatting and line endings.
  - Extracts `FileName` / `Filename` / `RelativeFilename` and `Properties70` `Path` / `RelPath` from
    Video and Texture objects; classifies `ABSOLUTE_LOCAL` / `UNC_NETWORK` / `RELATIVE_PORTABLE`;
    resolves each path on disk (exact, by name nearby, shared across an object's fields) and detects
    embedded media.
  - Fix modes: Convert to relative (optional rebase folder), Strip to basename, Collect & relink
    (copies textures into a subfolder). Dry run, `.fbx.bak` backup, restore.
  - Verified against real Blender 5.2 exports: fixed files re-import in Blender with the texture found
    through the new relative path.

### Phase 2 — Blender 5.0+ Integration
- **Blender discovery** (`core/blender_packer.py`): `BLENDER_PATH`, `PATH`, Windows registry,
  Program Files and Steam; version probing; 5.0+ check.
- **Headless runner**: `blender -b --factory-startup <file> -P headless_pack.py`, streamed output,
  progress markers, cancellation and timeout, JSON report.
- **`blender_scripts/headless_pack.py`**: consolidate external files into `//textures` / `//assets`
  (collision-safe), unpack all (`WRITE_LOCAL`), make paths relative, pack all, analyse-only mode,
  save-as-copy (no stray `.blend1`), dependency report for images, sounds, fonts, movie clips,
  volumes, cache files and libraries.
- Zip bundling of the result with its `textures/` / `assets/` folders.

### Phase 3 — Universal Previewer Engine
- **Texture decoding** (`core/preview_service.py`): PNG, JPG, TGA, DDS, BMP, TIFF (Pillow), 16-bit
  PNG/TIFF and Radiance HDR (OpenCV), OpenEXR (official `OpenEXR` bindings — the OpenCV wheels have
  no EXR codec). Exposure / gamma tone mapping and RGBA / RGB / Alpha / R / G / B channel views.
- **PSD**: `psd-tools` composite, layer tree, per-layer visibility with re-compositing, fallback to the
  embedded merged image.
- **3D viewer** (`ui/web/viewer3d.html`): bundled Three.js r170 (offline) with GLTF/GLB, OBJ+MTL,
  FBX and TGA loaders, OrbitControls, room-environment PBR lighting, auto framing, adaptive grid,
  wireframe, UV checker, animation playback and mesh statistics.
- **Local asset server**: localhost-only HTTP server with per-folder random tokens and path-traversal
  protection; textures referenced with broken or foreign absolute paths are found by name.

### Phase 4 — PySide6 UI
- Main window with five tabs (Batch Renamer, FBX Path Doctor, Blender Packer, Asset Previewer,
  Pipeline Tools), dark DCC studio theme, colour-coded log dock, status-bar progress and Cancel.
- Global drag & drop routed to the active tab (single previewable files jump to the previewer,
  `.blend` files to the Blender tab).
- All heavy work on `QThreadPool` workers; window layout and last tab are remembered.

### Bonus pipeline features
- **Duplicate asset finder** (size pre-filter + SHA-1).
- **Unused texture detector** (references from FBX, OBJ `.mtl`, glTF).
- **UV inspection**: UV-set count in the stats and a UV checker material in the 3D viewer.

### Phase 5 — Validation & Docs
- `tests/`: unit tests for renamer, FBX doctor (synthetic 7.4 / 7.5 binaries, ASCII, real Blender
  exports, Blender re-import), previewer formats, PSD, asset-server security, duplicate/unused
  detection and every Blender packer mode against a real Blender install.
- `tests/fixtures/`: generators for sample textures/PSD and Blender-exported FBX/GLB/OBJ/.blend.
- `docs/USER_GUIDE.md`, `run.bat` launcher.

### Changed vs. the v0.1.0 design
- Three.js ships as ES modules (`three.module.min.js` + `jsm/` add-ons via an import map) because
  upstream no longer publishes `three.min.js`; the viewer is served by the local asset server
  instead of `file://` so module imports and texture requests work.
- `requirements.txt`: removed unused `trimesh`, `imageio`, `imageio-ffmpeg`; added
  `opencv-python-headless`, `OpenEXR`, `pytest`.
- No `pyfbx` dependency: the custom FBX parser covers both formats.

### Fixed during self-testing
- A `/` or `\` typed into the replace field crashed the dry run; such names are now reported as invalid.
- Pillow silently reduced 16-bit RGB PNGs to 8 bit; 16-bit files are now detected and decoded at full depth.
- PSD layers with duplicate `layer_id`s toggled the wrong layer; layers are now keyed by position.
- FBX textures that failed to load rendered black in the 3D viewer; broken maps are now dropped.

---

## [0.1.0-design] - 2026-10-26
### Added
- **Architecture Blueprint**: Created [ARCHITECTURE_AND_SPECS.md](file:///p:/Phineas_LIB/Gogo_Gadgets/Project_P/docs/ARCHITECTURE_AND_SPECS.md) defining core system design, data flow diagrams, module breakdown, and technical stack.
- **Specification for Claude Opus 5.5**: Clear requirements for autonomous implementation, self-testing, and optimization.
- **Project Structure**: Established directory standards for `core/`, `ui/`, `blender_scripts/`, and `docs/`.
