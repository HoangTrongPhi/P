# Claude Opus 5.5 Implementation Directive: Project P (V2 Migration)

> **Role**: Lead Systems Engineer & Performance Optimizer (Claude Opus 5.5)  
> **From**: System Architect (Antigravity)  
> **Project**: Project P (3D Asset Toolkit & Doctor)  
> **Target Spec**: [ARCHITECTURE_V2_TAURI_RUST.md](ARCHITECTURE_V2_TAURI_RUST.md)  
> **Reference Baseline (Python Prototype)**: [ARCHITECTURE_AND_SPECS.md](ARCHITECTURE_AND_SPECS.md) & [USER_GUIDE.md](USER_GUIDE.md)

---

## 🎯 Mission Objective

You are tasked with executing the **full migration** of **Project P** from its Python 3.11 / PySide6 prototype to a high-performance, studio-grade standalone desktop application built on **Tauri 2.0 (Rust backend) + React 19 / TypeScript / Tailwind CSS v4 (Web frontend) + Blender 5.0+ Headless Bridge**.

All business logic, naming presets, FBX byte-patching algorithms, and Blender packing features established in the Python prototype must be preserved with 100% fidelity, while gaining:
- Sub-second cold startup (< 0.5s).
- Standalone installer/executable size < 30MB.
- Idle RAM consumption < 70MB.
- Seamless, beautiful Studio Dark UI with Command Palette (`Ctrl+K`) and floating 3D WebGL viewport.

---

## 📋 Step-by-Step Execution Sequence

### Phase 1: Tauri 2.0 Scaffold & Workspace Setup
1. **Initialize Tauri 2.0 App**:
   - Set up `src-tauri/` (Rust) and root web app (`src/`, `package.json`, `vite.config.ts`).
   - Configure `tauri.conf.json` with permissions for file dialogs, filesystem access, and the custom asset protocol (`asset://`).
   - Add required Rust crates to `src-tauri/Cargo.toml`:
     - `tauri = { version = "2", features = [...] }`
     - `serde = { version = "1.0", features = ["derive"] }`
     - `serde_json = "1.0"`
     - `rayon = "1.10"`
     - `walkdir = "2.5"`
     - `regex = "1.10"`
     - `byteorder = "1.5"`
     - `image = "0.25"`
     - `xxhash-rust = { version = "0.8", features = ["xxh3"] }`
     - `flate2 = "1.0"`
2. **Frontend UI System**:
   - Install `lucide-react`, `three`, `@types/three`, `clsx`, `tailwind-merge`.
   - Configure Tailwind CSS with the Studio Dark Palette defined in Section 2.2 of `ARCHITECTURE_V2_TAURI_RUST.md`.
   - Build core layouts:
     - `NavigationRail.tsx` (Vertical icon navigation for Renamer, FBX Doctor, Blender Packer, Asset Previewer, Pipeline Tools).
     - `HeaderDashboard.tsx` (Asset counter, broken paths counter, quick action search).
     - `CommandPalette.tsx` (Triggered via `Ctrl+K` or `Ctrl+P`).
     - `LogDrawer.tsx` (Collapsible bottom log drawer receiving structured logs from Rust).

---

### Phase 2: Core Rust Engine Implementation
Reference existing Python algorithms in `src/core/`:
1. **Directory Scanner (`src-tauri/src/core/scanner.rs`)**:
   - Mirror `src/core/scanner.py`. Use `walkdir` + `rayon` for concurrent traversal.
   - Filter meshes (`.fbx`, `.obj`, `.gltf`, `.glb`), textures (`.png`, `.tga`, `.exr`, `.dds`, `.hdr`, `.webp`), and scenes (`.blend`, `.psd`).
2. **Batch Renamer Engine (`src-tauri/src/core/renamer.rs`)**:
   - Mirror `src/core/renamer.py`.
   - Implement Unreal Engine 5 presets (`SM_`, `SK_`, `T_*_D`, `_N`, `_R`, `_M`, `_ORM`) and Unity presets.
   - Implement Regex search & replace, Prefix/Suffix, and Case conversions (`snake_case`, `camelCase`, `PascalCase`, `UPPER_CASE`).
   - Implement dry-run preview generation, conflict detection (duplicate names, existing files), and `.rename_history.json` transaction undo engine.
3. **Pure Rust FBX Doctor (`src-tauri/src/core/fbx/`)**:
   - Mirror `src/core/fbx_doctor.py`.
   - Implement Binary FBX 7.x parser and serializer supporting both 32-bit (v < 7500) and 64-bit (v >= 7500) offsets.
   - Implement ASCII FBX parser.
   - Extract and classify paths (`ABSOLUTE_LOCAL`, `UNC_NETWORK`, `RELATIVE_PORTABLE`, `EMPTY`) on `FileName`, `RelativeFilename`, and `P: "Path" / "RelPath"`.
   - Implement fix engines: `relative`, `strip`, `collect & relink`.
   - **Crucial Rule**: Unmodified FBX files passed through reader -> writer must remain **byte-identical**. Always preserve `.fbx.bak` backup before rewriting.
4. **Blender 5.0+ Subprocess Runner (`src-tauri/src/core/blender_runner.rs`)**:
   - Mirror `src/core/blender_packer.py`.
   - Locate Blender 5.0+ via Windows registry or default Program Files paths.
   - Spawn `blender.exe -b <blend_file> -P dcc_scripts/blender/headless_pack.py -- --report <json_path> [options]`.
   - Parse `PP_PROGRESS <done>/<total> <msg>` from stdout and emit Tauri IPC progress events.

---

### Phase 3: Modern UI & WebGL Viewport
1. **Three.js Asset Viewport (`src/components/previewer/Viewport3D.tsx`)**:
   - Instantiate Three.js canvas directly in the DOM.
   - Use `OrbitControls`, directional studio lighting, and ground grid.
   - Load `.gltf`, `.glb`, `.obj`, `.fbx` using Three.js standard loaders through the `asset://` protocol.
   - Implement Floating HUD: Wireframe switch, UV checker pattern shader, Reset camera, Poly/Vertex count HUD.
2. **2D Texture & HDR Inspector (`src/components/previewer/TextureViewer.tsx`)**:
   - GPU-accelerated pan and zoom.
   - Exposure and gamma controls for float maps.
   - Channel isolation switches (RGBA, RGB, Alpha, R, G, B).
3. **Pipeline Tools & ORM Channel Packer**:
   - Implement Channel Packer tab: inputs for Roughness, Metallic, AO -> output single merged ORM texture via Rust `image` crate.
   - Implement Duplicate Asset Finder: scan files using `xxhash-rust` (XXH3) to group identical files.

---

### Phase 4: Verification & Hand-off
1. **Automated Testing**:
   - Write Rust unit tests in `src-tauri/src/core/` mirroring `tests/test_renamer.py` and `tests/test_fbx_doctor.py`.
   - Verify that all sample FBX files in `tests/fixtures/` parse and re-serialize with exact byte parity.
2. **Release Build**:
   - Run `npm run tauri build`.
   - Confirm binary size < 30MB and launch latency < 0.5s.
