# Poseidon — 3D Asset Toolkit & Doctor

Desktop toolkit for 3D artists, TDs and game developers (Tauri 2 + Rust + React), built to
[ARCHITECTURE.md](docs/ARCHITECTURE.md). Download the Windows installer from
[Releases](https://github.com/HoangTrongPhi/P/releases/latest); installed copies update themselves.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Tauri scaffold, Studio Dark UI, navigation rail, header, `Ctrl+K` palette, log drawer, drag & drop | Done |
| 2 | Rust scanner, renamer, FBX doctor, Blender runner + IPC commands, Renamer / FBX Doctor / Blender Packer tabs | Done |
| 3 | Three.js viewport, texture inspector, ORM packer, duplicate finder, unused textures | Done (asset:// loading not yet confirmed in the desktop app) |
| 4 | Tests and release build | Rust + IPC tests; signed NSIS installer and Check for updates from GitHub Releases ([RELEASING.md](docs/RELEASING.md)) |
| 5 | Asset Matcher (mesh ↔ texture set with confidence, review, `asset_manifest.json`), Kit Assembler (manifest → clean UE5 / Unity layout, ORM packing, relinked meshes), Dashboard (assets by type and package), About & contact dialog (`src/lib/author.ts`), texture sets + batch ORM, texture converter, mesh inspector, `.blend`-aware unused textures, HTML / CSV reports, Recipes tab + CLI | Done |

## Prerequisites (Windows)

- Node.js 20+ and npm
- Rust (stable, MSVC toolchain) via [rustup](https://rustup.rs)
- Visual Studio Build Tools with the C++ workload and a Windows 10/11 SDK
- WebView2 runtime (built into Windows 11)

## Commands

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # UI only in a browser (backend calls disabled)
                       # open http://localhost:1420/?mock for a fake backend with sample data
npm run build          # typecheck and bundle the frontend
npm run tauri build    # release installer (NSIS); signed releases: ./scripts/release.ps1, see docs/RELEASING.md
cargo test --manifest-path src-tauri/Cargo.toml
```

### Command line (recipes)

A recipe saved from the Recipes tab runs without opening a window, e.g. in a build script:

```bash
poseidon.exe --recipe ue5-prep.json D:/Assets/Props --dry-run --report report.json
```

`--dry-run` changes nothing; `--report` writes the full run as JSON; `--blender <exe>` picks the
Blender used by `findUnused { includeBlend }`. Exit code: 0 when every step completed, 1 when a
step failed, 2 for bad arguments or an invalid recipe. Release builds are GUI-subsystem binaries,
so in `cmd` use `start /wait poseidon.exe …` to wait for the exit code.

The Rust tests include a Blender integration test that runs only when Blender 5.0+ is installed.
To check byte parity on your own FBX files, point `PP_FBX_FIXTURES` at a folder:

```bash
PP_FBX_FIXTURES=D:/Assets cargo test --manifest-path src-tauri/Cargo.toml external_fixture_parity -- --nocapture
```

## IPC commands

| Command | Purpose |
|---|---|
| `scan_directory(path, recursive, filters)` | Parallel asset scan → `ScanSummary` |
| `dry_run_rename(folder, rules)` | Rename plan with `OK` / `Skipped` / `Collision` / `Invalid` rows |
| `apply_rename(folder, items)` | Re-checks, renames two-phase, records `.rename_history.json` |
| `undo_last_rename(folder)` / `rename_history(folder)` | Undo stack |
| `scan_fbx_files(paths, searchDirs?)` | Texture paths in FBX files / folders, classified and resolved |
| `fix_fbx_paths(plan)` | `relative` / `strip` / `collect` fixes with `.fbx.bak` backup and dry run; searches the parent folder, leaves unfound textures unchanged unless `guessMissing` |
| `restore_fbx_backup(path)` | Restore from `.fbx.bak` |
| `discover_blender()` / `run_blender_pack(config)` / `cancel_blender_pack()` | Headless Blender 5.x; progress on `blender://progress` |
| `decode_image(path)` | PSD composite / TIFF → raw `width, height, RGBA8` bytes for the texture inspector |
| `pack_orm_texture(config)` | R = AO, G = Roughness, B = Metallic → PNG / TGA (missing inputs: AO 1.0, roughness 0.5, metallic 0) |
| `find_duplicate_assets(folder)` | Size pre-filter, then parallel XXH3-128 |
| `find_unused_textures(folder, includeBlend?, blenderPath?)` | Textures no FBX / MTL / glTF / GLB references; `includeBlend` also reads every `.blend` through headless Blender |
| `match_assets(folder)` | Every mesh / material slot matched to a texture set: score 0-100, reasons, exact / likely / review / none, unused sets. Mesh facts are cached by path + size + time; 4 parallel reads on Google Drive; emits `matcher://progress` |
| `matcher_estimate(folder)` | Mesh files and bytes a match would read, how much is cached, whether the folder is on Google Drive (names and sizes only) |
| `cancel_matching()` / `clear_mesh_cache()` | Stop a match (what was read stays cached) / forget cached meshes |
| `drive_mounts()` | Google Drive for desktop mounts with My Drive and the shared drives |
| `load_asset_manifest(path)` | Read an `asset_manifest.json` saved by the Asset Matcher |
| `assemble_kit(manifest, options)` | Copy a manifest into `Meshes/` + `Textures/` with UE5 / Unity names, ORM packing and relinked FBX / MTL / glTF paths; dry run plans only; emits `kit://progress` |
| `find_texture_sets(folder)` | Textures grouped into material sets by map suffix, missing maps, ORM-ready sets |
| `pack_orm_batch(configs)` | Several ORM textures in parallel, one result per output |
| `convert_textures(paths, options)` | Resize / power of two / normal green flip / PNG, TGA, JPG, uncompressed DDS with mips; dry run |
| `inspect_meshes(paths, triBudget?)` | Triangles, vertices, UV sets, materials, normals, bounds, units, up axis of FBX / OBJ / glTF / GLB |
| `save_text_file(path, contents)` | Write an exported report or recipe (`.csv` / `.html` / `.json` only) |
| `load_recipe(path)` / `run_recipe(recipe, folder, dryRun, blenderPath?)` | Recipes; progress on `recipe://progress` |
| `reveal_in_explorer(path)` / `ui_log(level, message)` | Show a file in Explorer; mirror UI log lines to stderr |
| `open_url(url)` | Open an `https://` or `mailto:` link (About & contact dialog) |

Types for all of them are in `src/types/pipeline.ts`, wrappers in `src/lib/ipc.ts`.

## Guides

- [Collecting an artist delivery](docs/ASSET_COLLECTION_GUIDE.md): Dashboard → Asset Matcher → Kit Assembler, Google Drive, manifest formats.
- [Releasing and updates](docs/RELEASING.md): signed installer, `latest.json`, GitHub Releases.
- [Changelog](docs/CHANGELOG.md)

## Layout

```
./
├── src/                     React 19 + Tailwind v4 frontend
│   ├── components/layout/   NavigationRail, HeaderDashboard, CommandPalette, LogDrawer, AboutDialog,
│   │                        UpdateDialog, SettingsDialog (theme, font)
│   ├── components/ui/       PillBadge, GlassCard, DropZone, Controls, LocationPicker (Drive menu)
│   ├── components/tabs/     one component per module (… DashboardTab, MatcherTab)
│   ├── components/tools/    KitAssemblerDialog
│   ├── hooks/               backend log bridge, global hotkeys, window drag & drop
│   ├── lib/                 IPC wrappers, palette commands, module registry, reports, author, driveLink
│   ├── stores/              zustand stores (app, per tab, kit)
│   ├── dev/mockBackend.ts   fake backend for `?mock` in a plain browser
│   └── types/pipeline.ts    IPC contracts shared with Rust
├── src-tauri/               Rust backend
│   ├── src/commands/        thin #[tauri::command] handlers
│   ├── src/core/            scanner, renamer, fbx/ (reader, writer, node, doctor), blender_runner,
│   │                        texture_sets, texture_convert, mesh_stats, recipe, usage, duplicate_finder,
│   │                        asset_matcher, kit_assembler, mesh_cache, drive
│   ├── src/cli.rs           headless `--recipe` runner
│   └── src/utils/           logbus (UI log stream), history (undo file), paths
└── dcc_scripts/blender/     headless_pack.py, bundled as a resource
```

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `Ctrl+P` | Command palette |
| `Ctrl+1` … `Ctrl+8` | Switch module |
| ``Ctrl+` `` | Toggle log drawer |
| `Ctrl+,` | Appearance: light / dark / system theme, interface and code fonts, interface size |
