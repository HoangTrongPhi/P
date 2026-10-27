# Project P V2 — Collecting an artist delivery

From "the artist sent a Google Drive folder" to "clean meshes and textures in the engine project",
in three tabs of the V2 app (`v2/`, Tauri):

1. **Dashboard** (`Ctrl+7`): what is in the delivery.
2. **Asset Matcher** (`Ctrl+8`): which texture set goes with which mesh.
3. **Kit Assembler** (from the Asset Matcher): copy the matches into the project, renamed and relinked.

The delivery folder is only ever read. Nothing in it is renamed, rewritten or deleted.

---

## 0. Opening a folder (local or Google Drive)

Every tab takes a dropped folder, **Choose…**, or the **☁ menu** next to it:

- **Google Drive for desktop**: lists each Drive drive (`G:\`), its **My Drive** and every
  **shared drive**. Click one to open it. Listing folders downloads nothing.
- **Paste a path**: `G:\Shared drives\Artist Repo\Vaultbreaker\3D_Environment\Wall Modular`.
  Explorer's *Copy as path* (with quotes) works too.
- **Paste a Drive link** (`drive.google.com/drive/folders/…`): links cannot be opened directly,
  because the toolkit reads files through Drive for desktop. The menu shows the folder id and
  how to reach the folder: under *Shared drives* if it is on one, or *Add shortcut* to My Drive
  in the browser, then paste its path.

> Shared drives are **stream only** in Drive for desktop: a file is downloaded when its content is
> read. Listing names and sizes is free; reading a mesh downloads it.

## 1. Dashboard: what is in the delivery

Counts and sizes by **asset type** (Mesh / Texture / Scene / Source) and by **package** (sub-folder,
1 to 3 levels deep). Switch between *Files* and *Size*; click a package to open it, ↖ to go up;
*Table* shows the same numbers as a table. Export saves HTML or CSV.

The Dashboard reads names and sizes only, so a whole shared drive can be looked at without
downloading anything.

## 2. Asset Matcher: which texture goes with which mesh

Open a delivery or one package. Every mesh file (FBX, OBJ, glTF, GLB) and each of its material slots
gets a texture set, a **score from 0 to 100** and the reasons for it.

| Status | Meaning |
|---|---|
| **Exact** | The mesh file itself stores a path to one of the set's textures. |
| **Likely** | A clear winner by material name or mesh name. |
| **Review** | Two sets score about the same, or the evidence is weak: you pick. |
| **No match** | Nothing scored high enough. |

Evidence, strongest first:

1. Texture paths stored in the mesh (FBX, OBJ through its MTL, glTF). A path that points at the
   very file scores 100. A path from the artist's machine (`D:\artist\…`) is matched by file name;
   when that name exists in several folders, the folder names in the path decide.
2. Material slot names against texture set names (`M_Brick` ↔ `T_Brick_D`, `T_Brick_N`, …).
   Exporter defaults like `lambert1` or `Material.001` are ignored.
3. The mesh file name (`SM_Wall_Corner_01` ↔ `Wall_Corner`; `SM_`, `SK_`, `_LOD0` are ignored).
4. Folders: the same or a nearby folder adds points, an unrelated one removes some.

Working the list:

- **To decide** filters the slots that still need you; *Accept best for reviews* takes the top
  candidate for every Review slot at once.
- Each slot has a drop-down (candidates first, then every other set, then *No texture*). The
  panel on the right shows the candidates with their reasons, the maps of the chosen set and the
  texture paths inside the mesh (missing ones in amber). ✎ marks a slot you picked by hand.
- With no slot selected, the panel lists **texture sets no mesh uses** and **textures without a
  map suffix**: things to ask the artist about.
- **Refresh** matches again and keeps your picks.
- **Save manifest** writes `asset_manifest.json` (below); **Export** writes an HTML / CSV report.

### On Google Drive

- Before reading, the Matcher estimates the mesh data from names and sizes. Above **64 MB** to
  download it asks first ("about 398.6 MB will download"). Pick a single package to read less.
- What a mesh contains (materials, texture paths) is **cached** by path, size and modification
  time in the app data folder (`%LOCALAPPDATA%\com.phineas.projectp\mesh_cache.json`).
  A rescan reads only new or changed meshes; the summary shows `N read · M cached`, and *clear*
  forgets the cache.
- On Drive at most 4 meshes are read at a time. **Cancel** stops; what was read stays cached.

## 3. Kit Assembler: into the project

**Assemble kit…** in the Asset Matcher (or *Assemble kit from manifest…* in `Ctrl+K` for a saved
manifest) opens the assembler.

| Option | Effect |
|---|---|
| Destination | The project folder, e.g. `<UE project>\Content\Environment`. Must be outside the delivery. |
| Naming | **Unreal**: `SM_Wall_Corner_01.fbx`, `T_Wall_Corner_D/_N/_ORM.png`. **Unity**: `WallCorner01.fbx`, `WallCorner_BaseColor.png`. **Keep names**. |
| Mesh / Texture folder | `Meshes` and `Textures` by default. |
| Pack ORM maps | Roughness (or gloss, inverted) + metallic + AO become one ORM texture (R = AO, G = roughness, B = metallic); the separate maps are not copied. |
| Relink texture paths | The copied FBX, OBJ-MTL and glTF point at the copied textures with relative paths. |
| Keep package folders | `Wall Modular/Meshes/…` instead of one shared `Meshes/` and `Textures/`. A texture shared by two packages is copied once, into the first. |
| Include unconfirmed matches | Review slots nobody picked take the top candidate (off: they are left out and listed). |
| Overwrite | Off: files already in the destination are kept and shown as *Kept*. |

The table shows the plan before anything is written (a dry run that updates as you change options).
**Assemble** writes it, with progress, then shows what was written, kept or failed; **Show kit**
opens the destination. Two different sources never get the same target name (the second gets
`_2`). A `kit_manifest.json` in the destination records every mesh, slot and map.

---

## File formats

### `asset_manifest.json` (Asset Matcher)

```json
{
  "format": "project-p.asset-manifest",
  "version": 1,
  "root": "G:\\Shared drives\\Artist Repo\\Vaultbreaker\\3D_Environment\\Wall Modular",
  "generated": "2026-10-27T16:49:59.000Z",
  "assets": [
    {
      "mesh": "Meshes/SM_Brick_Wall.obj",
      "slots": [
        {
          "slot": "M_Brick",
          "isMaterial": true,
          "textureSet": {
            "name": "Brick_Old",
            "folder": "Textures",
            "maps": { "baseColor": "Textures/T_Brick_Old_BaseColor.png", "normal": "Textures/T_Brick_Old_Normal.png" },
            "missingMaps": ["roughness"]
          },
          "confidence": 72,
          "status": "review",
          "decision": "manual"
        }
      ],
      "missingReferences": [],
      "error": null
    }
  ],
  "unassignedTextureSets": [],
  "looseTextures": ["Reference/moodboard_01.jpg"]
}
```

Paths are relative to `root`. `decision` is `auto` (the matcher's pick), `manual` (yours) or
`open` (a Review slot nobody decided; the Kit Assembler skips it unless told otherwise).

### `kit_manifest.json` (Kit Assembler)

```json
{
  "format": "project-p.kit-manifest",
  "version": 1,
  "source": "G:\\Shared drives\\…\\Wall Modular",
  "naming": "ue5",
  "assets": [
    {
      "mesh": "Meshes/SM_Brick_Wall.obj",
      "source": "Meshes/SM_Brick_Wall.obj",
      "slots": [{ "slot": "M_Brick", "textureSet": "Brick_Old", "maps": { "baseColor": "Textures/T_Brick_Old_D.png" } }]
    }
  ]
}
```

Paths are relative to the destination; `source` is relative to the delivery.

## Limits

- `.blend` files are not matched (the Matcher reads FBX, OBJ, glTF and GLB).
- Textures embedded in a GLB stay inside it; external texture paths in a GLB are reported, not rewritten.
- Drive links need Drive for desktop; reading Drive through its web API is not built in.
