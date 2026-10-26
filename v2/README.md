# Project P V2 — Tauri 2 + Rust + React

V2 rewrite of the 3D Asset Toolkit, following [ARCHITECTURE_V2_TAURI_RUST.md](../docs/ARCHITECTURE_V2_TAURI_RUST.md).
It lives in `v2/` so the Python prototype in `../src/` stays runnable as the reference for porting.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Tauri scaffold, Studio Dark UI, navigation rail, header, `Ctrl+K` palette, log drawer, drag & drop | Done |
| 2 | Rust scanner, renamer, FBX doctor, Blender runner + IPC commands, Renamer / FBX Doctor / Blender Packer tabs | Done |
| 3 | Three.js viewport, texture inspector, ORM packer, duplicate finder | Not started |
| 4 | Tests and release build | Not started |

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
npm run tauri build    # release installer (NSIS / MSI)
cargo test --manifest-path src-tauri/Cargo.toml
```

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
| `fix_fbx_paths(plan)` | `relative` / `strip` / `collect` fixes with `.fbx.bak` backup and dry run |
| `restore_fbx_backup(path)` | Restore from `.fbx.bak` |
| `discover_blender()` / `run_blender_pack(config)` / `cancel_blender_pack()` | Headless Blender 5.x; progress on `blender://progress` |

Types for all of them are in `src/types/pipeline.ts`, wrappers in `src/lib/ipc.ts`.

## Layout

```
v2/
├── src/                     React 19 + Tailwind v4 frontend
│   ├── components/layout/   NavigationRail, HeaderDashboard, CommandPalette, LogDrawer
│   ├── components/ui/       PillBadge, GlassCard, DropZone
│   ├── components/tabs/     one component per module
│   ├── hooks/               backend log bridge, global hotkeys, window drag & drop
│   ├── lib/                 IPC wrappers, palette commands, module registry
│   ├── stores/              zustand app store
│   └── types/pipeline.ts    IPC contracts shared with Rust
├── src-tauri/               Rust backend
│   ├── src/commands/        thin #[tauri::command] handlers
│   ├── src/core/            scanner, renamer, fbx/ (reader, writer, node, doctor), blender_runner
│   └── src/utils/           logbus (UI log stream), history (undo file), paths
└── dcc_scripts/blender/     headless_pack.py, bundled as a resource
```

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `Ctrl+P` | Command palette |
| `Ctrl+1` … `Ctrl+5` | Switch module |
| ``Ctrl+` `` | Toggle log drawer |
