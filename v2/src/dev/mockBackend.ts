/**
 * Dev-only fake backend so the UI can be exercised in a plain browser: open
 * `http://localhost:1420/?mock`. Never active in production builds or inside Tauri.
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { useAppStore } from "../stores/appStore";
import type { FbxFileInfo, RenameRow, RenameRuleSpec } from "../types/pipeline";

const ROOT = "D:\\Assets\\Props";
const FILES = [
  "chair.fbx", "hero_skel.fbx", "SM_Rock.obj", "wood_planks_basecolor.png", "wood_planks_normal.png",
  "rock01_Roughness.tga", "crate_ORM.png", "T_Crate_D.png", "metal-plate_nrm.png", "poster.psd", "a.png", "b.png",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real sample files under `sample-assets/` (generated locally), served by Vite as-is. */
const PREVIEW_ROOT = "/sample-assets/previewer";
const PREVIEW_FILES = [
  "anim_cube.gltf", "crate.glb", "crate.obj", "crate_abs.fbx", "crate_diffuse.png", "textures/decal_alpha.tga", "textures/height_16bit.png",
  "textures/metal_plate_diff.jpg", "textures/poster.psd", "textures/rock01_Roughness.png", "textures/sky_studio.exr",
  "textures/sky_studio.hdr", "textures/ui_icon.dds", "textures/wood_planks_basecolor.png", "textures/wood_planks_normal.png",
];

/** Stand-in for the Rust PSD decoder: the psd-tools composite saved next to the PSD. */
async function fakeDecode(path: string): Promise<ArrayBuffer> {
  const img = new Image();
  img.src = path.replace(/\.(psd|tiff?)$/i, "_ref.png");
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint8Array(8 + px.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, img.width, true);
  view.setUint32(4, img.height, true);
  out.set(px, 8);
  return out.buffer;
}

/** Rough stand-in for the Rust rules, good enough to see the table react. */
function fakeRename(name: string, rules: RenameRuleSpec[]): string {
  const dot = name.lastIndexOf(".");
  let stem = name.slice(0, dot);
  const ext = name.slice(dot);
  for (const r of rules) {
    if (r.kind === "prefix" && !stem.startsWith(r.prefix)) stem = r.prefix + stem;
    if (r.kind === "suffix" && !stem.endsWith(r.suffix)) stem += r.suffix;
    if (r.kind === "searchReplace" && r.find) stem = stem.split(r.find).join(r.replace ?? "");
    if (r.kind === "case" && r.style === "upper") stem = stem.toUpperCase();
    if (r.kind === "preset" && r.preset === "ue5") {
      const map: Record<string, string> = {
        chair: "SM_Chair", hero_skel: "SK_Hero", wood_planks_basecolor: "T_WoodPlanks_D", wood_planks_normal: "T_WoodPlanks_N",
        rock01_Roughness: "T_Rock_01_R", "metal-plate_nrm": "T_MetalPlate_N", poster: "T_Poster", a: "T_Same", b: "T_Same",
      };
      stem = map[stem] ?? stem;
    }
  }
  return stem + ext;
}

function dryRun(rules: RenameRuleSpec[]): RenameRow[] {
  const rows = FILES.map((f) => {
    const newName = fakeRename(f, rules);
    return { originalPath: `${ROOT}\\${f}`, originalName: f, newName, targetPath: `${ROOT}\\${newName}`, status: newName === f ? "Skipped" : "OK" } as RenameRow;
  });
  for (const r of rows) {
    if (r.status === "OK" && rows.filter((o) => o.newName === r.newName).length > 1) Object.assign(r, { status: "Collision", reason: "Several files map to this name" });
    if (r.newName.includes("/")) Object.assign(r, { status: "Invalid", reason: "Contains invalid characters" });
  }
  rows.filter((r) => r.status === "Skipped").forEach((r) => (r.reason = "Name unchanged"));
  return rows;
}

let fixed = false;
function fbxFiles(): FbxFileInfo[] {
  const abs = (n: string) => `C:\\Users\\John\\Textures\\${n}`;
  const entry = (owner: string, field: string, path: string, ok: boolean) => ({
    nodeName: owner,
    propertyName: field,
    originalPath: ok ? `textures/${path.split("\\").pop()}` : path,
    resolvedPath: `${ROOT}\\textures\\${path.split("\\").pop()}`,
    kind: ok ? "RELATIVE_PORTABLE" : "ABSOLUTE_LOCAL",
    existsOnDisk: true,
    resolution: ok ? "found" : "found_by_name",
    embedded: false,
    isProblem: !ok,
  }) as FbxFileInfo["entries"][number];
  const crate = ["P:Path", "Filename", "RelativeFilename"].map((f) => entry("Video::crate_diffuse", f, abs("crate_diffuse.png"), fixed));
  crate.push(entry("Texture::crate_diffuse", "FileName", abs("crate_diffuse.png"), fixed));
  return [
    { path: `${ROOT}\\crate.fbx`, version: 7400, isBinary: true, entries: crate, hasIssues: !fixed, problemCount: fixed ? 0 : 4 },
    {
      path: `${ROOT}\\hero.fbx`,
      version: 7700,
      isBinary: true,
      entries: [
        { ...entry("Video::hero_N", "RelativeFilename", "\\\\nas\\share\\hero_N.png", false), kind: "UNC_NETWORK", resolution: "missing", resolvedPath: null, existsOnDisk: false },
      ],
      hasIssues: true,
      problemCount: 1,
    },
    { path: `${ROOT}\\rock.fbx`, version: 7400, isBinary: false, entries: [entry("Texture::rock", "RelativeFilename", "rock.png", true)], hasIssues: false, problemCount: 0 },
    { path: `${ROOT}\\broken.fbx`, version: 0, isBinary: false, entries: [], hasIssues: true, problemCount: 0, error: "Node end offset beyond file size (truncated file?)" },
  ];
}

if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
  (globalThis as { isTauri?: boolean; __PP_MOCK__?: boolean }).isTauri = true;
  (globalThis as { __PP_MOCK__?: boolean }).__PP_MOCK__ = true;
  mockWindows("main");
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (cmd) {
        case "app_info":
          return { name: "project-p", version: "2.0.0-mock", tauriVersion: "2.x", os: "windows", arch: "x86_64", debug: true };
        case "log_history":
          return [{ tsMs: Date.now(), level: "info", source: "app", message: "Mock backend active (?mock)" }];
        case "plugin:fs|stat":
          return { isDirectory: !/\.\w+$/.test(a.path), isFile: /\.\w+$/.test(a.path), size: 0 };
        case "plugin:dialog|open": {
          const o = a.options ?? {};
          const tab = useAppStore.getState().activeTab;
          if (o.directory) return tab === "preview" || tab === "tools" ? PREVIEW_ROOT : ROOT;
          const ext = o.filters?.[0]?.extensions?.[0];
          if (o.filters?.[0]?.name === "Assets") return [`${PREVIEW_ROOT}/crate.glb`];
          if (o.filters?.[0]?.name === "Textures") return `${PREVIEW_ROOT}/textures/rock01_Roughness.png`;
          if (o.filters?.[0]?.name === "HDRI") return `${PREVIEW_ROOT}/textures/sky_studio.hdr`;
          if (ext === "blend") return [`${ROOT}\\scene\\crate.blend`];
          if (ext === "json") return `${ROOT}\\recipes\\audit.json`;
          if (ext === "exe") return "C:\\Tools\\blender\\blender.exe";
          return [`${ROOT}\\crate.fbx`, `${ROOT}\\hero.fbx`];
        }
        case "plugin:fs|write_file":
          return null;
        case "plugin:dialog|save": {
          const d = a.options?.defaultPath ?? "out.zip";
          return /^[A-Za-z]:|^\//.test(d) ? d : `${ROOT}\\${d}`;
        }
        case "scan_directory":
          if (String(a.path).startsWith(PREVIEW_ROOT))
            return { root: a.path, files: PREVIEW_FILES.map((f) => ({ path: `${PREVIEW_ROOT}/${f}`, name: f.split("/").pop(), size: 4096, modifiedMs: 0, category: "texture" })), counts: {}, totalSize: 0, elapsedMs: 2, errors: [] };
          return { root: a.path, files: FILES.map((f) => ({ path: `${ROOT}\\${f}`, name: f, size: 1024, modifiedMs: 0, category: "texture" })), counts: {}, totalSize: 0, elapsedMs: 3, errors: [] };
        case "dry_run_rename":
          await sleep(120);
          return dryRun(a.rules.rules);
        case "apply_rename":
          return { transactionId: "mock", renamed: a.items.length, rejected: [] };
        case "rename_history":
          return [{ id: "mock", timestamp: Date.now() / 1000 - 60, count: 3 }];
        case "undo_last_rename":
          return { transactionId: "mock", restored: 3 };
        case "scan_fbx_files":
          await sleep(200);
          return fbxFiles();
        case "fix_fbx_paths": {
          const plan = a.plan;
          const reports = plan.paths.map((p: string) => ({
            path: p,
            changes: p.endsWith("crate.fbx")
              ? ["P:Path", "Filename", "RelativeFilename", "FileName"].map((f) => ({ field: f, owner: "Video::crate_diffuse", old: "C:\\Users\\John\\Textures\\crate_diffuse.png", new: plan.mode === "strip" ? "crate_diffuse.png" : `${plan.subfolder ?? "textures"}/crate_diffuse.png` }))
              : [{ field: "RelativeFilename", owner: "Video::hero_N", old: "\\\\nas\\share\\hero_N.png", new: "textures/hero_N.png" }],
            copied: plan.mode === "collect" ? [{ from: "C:\\x", to: "y" }] : [],
            warnings: p.endsWith("hero.fbx") ? ["hero_N.png: texture missing, guessed 'textures/hero_N.png'"] : [],
            backup: plan.dryRun ? null : `${p}.bak`,
            written: !plan.dryRun,
            dryRun: !!plan.dryRun,
          }));
          if (!plan.dryRun) fixed = true;
          return { reports, errors: [] };
        }
        case "restore_fbx_backup":
          fixed = false;
          return true;
        case "discover_blender":
          await sleep(300);
          return [
            { executable: "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", version: [5, 2, 2], versionString: "5.2.2", supported: true },
            { executable: "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe", version: [5, 1, 0], versionString: "5.1.0", supported: true },
          ];
        case "run_blender_pack": {
          const steps = ["Analysing dependencies", "Consolidating 1 file", "Making paths relative", "Saving"];
          for (let i = 0; i < steps.length; i++) {
            await emit("blender://progress", { done: i + 1, total: steps.length, message: steps[i] });
            await sleep(450);
          }
          const dep = { name: "crate_diffuse", type: "images", filepath: "//textures/crate_diffuse.png", abspath: "D:\\Assets\\Props\\scene_packed\\textures\\crate_diffuse.png", exists: true, packed: false, relative: true };
          const missing = { name: "decal_mask", type: "images", filepath: "C:\\old\\decal_mask.png", abspath: "C:\\old\\decal_mask.png", exists: false, packed: false, relative: false };
          return {
            ok: true,
            report: { ok: true, blend: a.config.options?.output ?? a.config.blendFile, blender_version: "5.2.2", after: [dep, missing], missing: [missing], steps },
            returncode: 0,
            outputLines: [],
            archive: a.config.options?.zipArchive ?? null,
            cancelled: false,
            error: null,
          };
        }
        case "cancel_blender_pack":
          return true;
        case "ui_log":
          return null;
        case "decode_image":
          return fakeDecode(a.path);
        case "reveal_in_explorer":
          return null;
        case "pack_orm_texture":
          await sleep(300);
          return a.config.outputPath;
        case "find_duplicate_assets":
          await sleep(400);
          return {
            groups: [
              { hash: "9f2c1e7a4b3d5e6f00112233445566778", size: 1_572_864, files: [`${PREVIEW_ROOT}/crate_diffuse.png`, `${PREVIEW_ROOT}/tex_external/crate_diffuse.png`, `${PREVIEW_ROOT}/backup/crate_diffuse.png`] },
              { hash: "11aa22bb33cc44dd55ee66ff77889900", size: 262_144, files: [`${PREVIEW_ROOT}/textures/wood_planks_normal.png`, `${PREVIEW_ROOT}/old/wood_N.png`] },
            ],
            wastedBytes: 1_572_864 * 2 + 262_144,
            scannedFiles: 128,
            hashedFiles: 9,
            elapsedMs: 41,
            errors: [],
          };
        case "find_unused_textures":
          await sleep(400);
          return {
            textures: ["textures/decal_alpha.tga", "textures/ui_icon.dds", "textures/sky_studio.exr"].map((f) => ({ path: `${PREVIEW_ROOT}/${f}`, name: f.split("/").pop(), size: 350_000, modifiedMs: 0, category: "texture" })),
            reclaimableBytes: 1_050_000,
            totalTextures: 11,
            referenceFiles: 3,
            blendFiles: 1,
            blendInspected: a.includeBlend ? 1 : 0,
            warnings: [],
          };
        case "find_texture_sets": {
          await sleep(250);
          const T = `${PREVIEW_ROOT}/textures`;
          return {
            sets: [
              { dir: T, name: "wood_planks", maps: { baseColor: `${T}/wood_planks_basecolor.png`, normal: `${T}/wood_planks_normal.png`, roughness: `${T}/wood_planks_roughness.png`, ao: `${T}/wood_planks_ao.png` }, extra: [], missing: [], canPackOrm: true, suggestedOrm: `${T}/T_WoodPlanks_ORM.png` },
              { dir: T, name: "rock01", maps: { roughness: `${T}/rock01_Roughness.png` }, extra: [], missing: ["baseColor", "normal"], canPackOrm: true, suggestedOrm: `${T}/T_Rock01_ORM.png` },
              { dir: T, name: "metal_plate", maps: { baseColor: `${T}/metal_plate_diff.jpg`, normal: `${T}/metal_plate_nrm.png`, orm: `${T}/T_MetalPlate_ORM.png` }, extra: [], missing: [], canPackOrm: false, suggestedOrm: `${T}/T_MetalPlate_ORM.png` },
              { dir: PREVIEW_ROOT, name: "crate", maps: { baseColor: `${PREVIEW_ROOT}/crate_diffuse.png`, gloss: `${PREVIEW_ROOT}/crate_gloss.png` }, extra: [], missing: ["normal"], canPackOrm: true, suggestedOrm: `${PREVIEW_ROOT}/T_Crate_ORM.png` },
            ],
            totalTextures: 14,
            unmatched: [`${T}/sky_studio.hdr`, `${T}/ui_icon.dds`, `${T}/poster.psd`],
          };
        }
        case "pack_orm_batch":
          await sleep(400);
          return a.configs.map((c: { outputPath: string }) => ({ outputPath: c.outputPath, ok: true, error: null }));
        case "convert_textures": {
          await sleep(350);
          const o = a.options ?? {};
          const files = (a.paths as string[]).flatMap((p) => (/\.\w+$/.test(p) ? [p] : [`${p}/wood_planks_normal.png`, `${p}/rock01_Roughness.png`, `${p}/sky_studio.hdr`]));
          return files.map((src) => {
            const hdr = /\.(hdr|exr)$/i.test(src);
            const ext = o.format && o.format !== "keep" ? o.format : "png";
            const name = src.split(/[\\/]/).pop()!.replace(/\.\w+$/, "");
            const to = o.maxSize ? Math.min(o.maxSize, 1024) : 1024;
            return {
              source: src,
              output: hdr ? null : `${src.replace(/[\\/][^\\/]+$/, "")}/${o.outputDir ?? "converted"}/${name}${o.suffix ?? ""}.${ext}`,
              fromSize: hdr ? null : [1024, 1024],
              toSize: hdr ? null : [to, to],
              bytesBefore: 1_048_576,
              bytesAfter: hdr || o.dryRun ? null : 400_000,
              written: !hdr && !o.dryRun,
              skipped: hdr ? "HDR source: 8-bit output would clip it" : null,
              error: null,
            };
          });
        }
        case "inspect_meshes": {
          await sleep(300);
          const budget = a.triBudget as number | null;
          const base = { meshes: 1, polygons: 0, hasNormals: true, unitScaleCm: 1, upAxis: "+Y", error: null };
          const rows = [
            { ...base, path: `${PREVIEW_ROOT}/crate.glb`, format: "glb", vertices: 24, triangles: 12, materials: 1, uvSets: 1, bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, unitScaleCm: 100, warnings: [] as string[] },
            { ...base, path: `${PREVIEW_ROOT}/crate_abs.fbx`, format: "fbx-binary", vertices: 8, triangles: 12, materials: 1, uvSets: 1, bounds: { min: [-50, 0, -50], max: [50, 100, 50] }, warnings: [] as string[] },
            { ...base, path: `${PREVIEW_ROOT}/crate.obj`, format: "obj", vertices: 8, triangles: 12, materials: 1, uvSets: 0, hasNormals: false, unitScaleCm: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, warnings: ["No UV set: textures and lightmaps cannot be mapped", "Missing normals on some meshes: the engine will compute them"] },
            { ...base, path: `${PREVIEW_ROOT}/hero.fbx`, format: "fbx-binary", meshes: 3, vertices: 48_210, triangles: 91_544, materials: 4, uvSets: 2, unitScaleCm: 2.54, upAxis: "+Z", bounds: { min: [-40, -20, 0], max: [40, 20, 180] }, warnings: ["Unusual unit scale: 1 unit = 2.54 cm"] },
          ];
          for (const r of rows) if (budget && r.triangles > budget) r.warnings = [...r.warnings, `${r.triangles} triangles, over the ${budget} budget`];
          return rows.map((r) => ({ ...r, polygons: r.triangles }));
        }
        case "save_text_file":
          console.info("mockBackend: save_text_file", a.path, `${String(a.contents).length} chars`);
          return null;
        case "load_recipe":
          return { name: "Loaded recipe", steps: [{ kind: "inspectMeshes", triBudget: 20000 }, { kind: "findDuplicates" }] };
        case "run_recipe": {
          const steps = a.recipe.steps as { kind: string }[];
          const titles: Record<string, string> = { rename: "Rename assets", fbxFix: "Fix FBX texture paths", packOrm: "Pack ORM textures", convertTextures: "Convert textures", inspectMeshes: "Inspect meshes", findUnused: "Find unused textures", findDuplicates: "Find duplicates" };
          const summaries: Record<string, [string, string[]]> = {
            rename: [`${a.dryRun ? "Would rename" : "Renamed"} 6 of 12 file(s), 1 conflict(s) left as they are`, ["chair.fbx -> SM_Chair.fbx", "wood_planks_basecolor.png -> T_WoodPlanks_D.png", "a.png: Collision Several files map to this name"]],
            fbxFix: [`${a.dryRun ? "Would rewrite" : "Rewrote"} 4 path(s) in 1 of 3 FBX file(s), 0 unreadable`, ["crate.fbx: 4 path(s)", "hero.fbx: hero_N.png: texture not found, left unchanged"]],
            packOrm: [`${a.dryRun ? "Would pack" : "Packed"} 2 ORM texture(s) from 4 texture set(s)`, ["textures/T_WoodPlanks_ORM.tga: would pack", "T_Crate_ORM.tga: would pack"]],
            convertTextures: [`${a.dryRun ? "Would convert" : "Converted"} 3 texture(s), skipped 1`, ["textures/wood_planks_normal.png -> textures/converted/wood_planks_normal.png (1024x1024)", "textures/sky_studio.hdr: skipped, HDR source: 8-bit output would clip it"]],
            inspectMeshes: ["4 mesh file(s), 91580 triangles, 2 with warnings", ["hero.fbx: 91544 tris, 48210 verts, 2 UV set(s), 4 material(s)", "  ! Unusual unit scale: 1 unit = 2.54 cm"]],
            findUnused: ["3 of 11 texture(s) unreferenced (1.0 MB)", ["textures/decal_alpha.tga", "textures/ui_icon.dds"]],
            findDuplicates: ["2 duplicate group(s), 3.3 MB reclaimable", ["3 copies: crate_diffuse.png, tex_external/crate_diffuse.png, backup/crate_diffuse.png"]],
          };
          const out = [];
          for (let i = 0; i < steps.length; i++) {
            await emit("recipe://progress", { done: i, total: steps.length, message: titles[steps[i].kind] });
            await sleep(350);
            const [summary, details] = summaries[steps[i].kind];
            out.push({ kind: steps[i].kind, title: titles[steps[i].kind], ok: true, skipped: false, summary, details, elapsedMs: 120 + i * 40 });
          }
          return { name: a.recipe.name, folder: a.folder, dryRun: a.dryRun, ok: true, steps: out, elapsedMs: out.length * 350 };
        }
        default:
          if (cmd.startsWith("plugin:event|")) return 0;
          console.warn("mockBackend: unhandled", cmd, args);
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
