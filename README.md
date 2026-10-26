# Project P: 3D Asset Toolkit & Doctor

A modern, lightweight desktop utility for 3D Artists, TDs, and Game Developers.

## Key Features
- **Batch Asset Renamer**: Rename meshes and textures using Regex or Industry Presets (UE5 / Unity) with instant dry-run and 1-click Undo.
- **FBX Absolute Path Doctor**: Deep scan `.fbx` files (Binary & ASCII) to detect hardcoded machine paths (`C:\...`) and safely convert them to relative paths.
- **Blender 5.0+ Asset Consolidator**: Headless integration to pack external textures, remap relative paths, and bundle assets.
- **Universal Multi-format Previewer**:
  - 3D: `.fbx`, `.obj`, `.glb`, `.gltf` with OrbitControls, Wireframe and UV checker.
  - 2D: `.png`, `.jpg`, `.tga`, `.dds`, `.exr`, `.hdr` with exposure, gamma and channel views.
  - PSD: `.psd` Photoshop composite & layer inspection.
- **Pipeline Tools**: duplicate asset finder and unused texture detector.

## Quickstart

```bash
run.bat
```

The first run creates `.venv` and installs the dependencies. You can also pass a file or folder:
`run.bat D:\Assets\Props`. Requires Python 3.11+; the Blender tab needs Blender 5.0+.

Run the self-tests:

```bash
.venv\Scripts\python.exe -m pytest
```

## Documentation
- [User Guide](docs/USER_GUIDE.md)
- [Architecture & Technical Specifications](docs/ARCHITECTURE_AND_SPECS.md)
- [Changelog](docs/CHANGELOG.md)
