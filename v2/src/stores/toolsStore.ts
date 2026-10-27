import { create } from "zustand";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { convertTextures, findDuplicateAssets, findTextureSets, findUnusedTextures, inspectMeshes, packOrmBatch, packOrmTexture } from "../lib/ipc";
import { dirname, joinPath, stem } from "../lib/pathUtil";
import type { ConvertItem, ConvertOptions, DuplicateReport, MeshStats, OrmPackConfig, TextureSet, TextureSetReport, UnusedReport } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export type OrmSlot = "ao" | "roughness" | "metallic";
export type ToolsView = "duplicates" | "unused" | "sets" | "meshes";
export type LeftView = "orm" | "convert";

const MESH_RE = /\.(fbx|obj|gltf|glb)$/i;
const IMAGE_RE = /\.(png|jpe?g|tga|tiff?|bmp|webp|psd)$/i;

/** Batch-pack config for a texture set (gloss maps are inverted into roughness). */
export function ormConfigFor(set: TextureSet, format: "png" | "tga"): OrmPackConfig {
  const gloss = !set.maps.roughness && !!set.maps.gloss;
  return {
    roughnessPath: set.maps.roughness ?? set.maps.gloss ?? null,
    roughnessFromGloss: gloss,
    metallicPath: set.maps.metallic ?? null,
    aoPath: set.maps.ao ?? null,
    outputPath: set.suggestedOrm.replace(/\.png$/i, `.${format}`),
    format,
  };
}

const SLOT_PATTERNS: [OrmSlot, RegExp][] = [
  ["ao", /(^|[_\-. ])(ao|occlusion|ambient[_\- ]?occlusion)$/i],
  ["roughness", /(^|[_\-. ])(roughness|rough|rgh|gloss|glossiness|smoothness)$/i],
  ["metallic", /(^|[_\-. ])(metallic|metalness|metal|mtl)$/i],
];
const MAP_SUFFIX = /[_\-. ]?(roughness|rough|rgh|gloss|glossiness|smoothness|metallic|metalness|metal|mtl|ao|occlusion|ambient[_\- ]?occlusion)$/i;

/** Which ORM slot a texture file name belongs to, if any. */
export function guessSlot(path: string): OrmSlot | null {
  const s = stem(path);
  return SLOT_PATTERNS.find(([, re]) => re.test(s))?.[0] ?? null;
}

/** `wood_planks_roughness.png` -> `<dir>/T_WoodPlanks_ORM.png`. */
export function defaultOrmPath(input: string, format: "png" | "tga"): string {
  const base = stem(input).replace(MAP_SUFFIX, "").replace(/^(T|TX|TEX)[_\-]/i, "");
  const pascal = base
    .split(/[_\-. ]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return joinPath(dirname(input), `T_${pascal || "Texture"}_ORM.${format}`);
}

interface ToolsState {
  slots: Record<OrmSlot, string | null>;
  gloss: boolean;
  format: "png" | "tga";
  outputPath: string;
  /** User edited the output path; stop auto-deriving it. */
  outputTouched: boolean;
  packing: boolean;
  packed: string | null;

  leftView: LeftView;
  convertInputs: string[];
  convertOptions: ConvertOptions;
  converting: boolean;
  converted: ConvertItem[] | null;

  folder: string | null;
  view: ToolsView;
  running: boolean;
  duplicates: DuplicateReport | null;
  unused: UnusedReport | null;
  /** Read `.blend` files through Blender when finding unused textures. */
  includeBlend: boolean;
  sets: TextureSetReport | null;
  /** `suggestedOrm` of the sets ticked for batch packing. */
  selectedSets: string[];
  packingSets: boolean;
  meshes: MeshStats[] | null;
  /** Mesh files inspected directly (dropped), instead of the folder. */
  meshFiles: string[] | null;
  triBudget: number | null;

  setSlot: (slot: OrmSlot, path: string | null) => void;
  setGloss: (v: boolean) => void;
  setFormat: (f: "png" | "tga") => void;
  setOutputPath: (p: string) => void;
  pack: () => Promise<void>;
  setLeftView: (v: LeftView) => void;
  addConvertInputs: (paths: string[]) => void;
  removeConvertInput: (path: string) => void;
  setConvertOptions: (patch: Partial<ConvertOptions>) => void;
  convert: (dryRun: boolean) => Promise<void>;

  setFolder: (f: string) => void;
  setView: (v: ToolsView) => void;
  setIncludeBlend: (v: boolean) => void;
  setTriBudget: (v: number | null) => void;
  toggleSet: (key: string) => void;
  selectPackable: (all: boolean) => void;
  packSelectedSets: () => Promise<void>;
  inspectMeshFiles: (files: string[]) => Promise<void>;
  runAnalysis: (view?: ToolsView) => Promise<void>;
}

export const useToolsStore = create<ToolsState>()((set, get) => {
  const refreshOutput = () => {
    const { slots, format, outputTouched } = get();
    const first = slots.roughness ?? slots.metallic ?? slots.ao;
    if (!outputTouched && first) set({ outputPath: defaultOrmPath(first, format) });
  };
  return {
    slots: { ao: null, roughness: null, metallic: null },
    gloss: false,
    format: "png",
    outputPath: "",
    outputTouched: false,
    packing: false,
    packed: null,
    leftView: "orm",
    convertInputs: [],
    convertOptions: { maxSize: 2048, powerOfTwo: false, format: "keep", flipGreen: false, outputDir: "converted", suffix: "", overwrite: false, ddsMipmaps: true, jpegQuality: 90 },
    converting: false,
    converted: null,
    folder: null,
    view: "duplicates",
    running: false,
    duplicates: null,
    unused: null,
    includeBlend: false,
    sets: null,
    selectedSets: [],
    packingSets: false,
    meshes: null,
    meshFiles: null,
    triBudget: null,

    setSlot: (slot, path) => {
      set((s) => ({ slots: { ...s.slots, [slot]: path }, packed: null }));
      if (path && slot === "roughness") set({ gloss: /gloss|smooth/i.test(stem(path)) });
      refreshOutput();
    },
    setGloss: (gloss) => set({ gloss }),
    setFormat: (format) => {
      set((s) => ({ format, outputPath: s.outputPath.replace(/\.(png|tga)$/i, `.${format}`) }));
      refreshOutput();
    },
    setOutputPath: (outputPath) => set({ outputPath, outputTouched: true }),

    pack: async () => {
      const { slots, gloss, format, outputPath } = get();
      if (!outputPath) return;
      set({ packing: true });
      try {
        const packed = await packOrmTexture({
          aoPath: slots.ao,
          roughnessPath: slots.roughness,
          metallicPath: slots.metallic,
          outputPath,
          format,
          roughnessFromGloss: gloss,
        });
        set({ packed });
      } catch (err) {
        uiLog("error", `ORM pack failed: ${err}`);
      } finally {
        set({ packing: false });
      }
    },

    setLeftView: (leftView) => set({ leftView }),
    addConvertInputs: (paths) => set((s) => ({ convertInputs: [...new Set([...s.convertInputs, ...paths])], converted: null })),
    removeConvertInput: (path) => set((s) => ({ convertInputs: s.convertInputs.filter((p) => p !== path), converted: null })),
    setConvertOptions: (patch) => set((s) => ({ convertOptions: { ...s.convertOptions, ...patch }, converted: null })),
    convert: async (dryRun) => {
      const { convertInputs, convertOptions } = get();
      if (!convertInputs.length) return;
      set({ converting: true });
      try {
        set({ converted: await convertTextures(convertInputs, { ...convertOptions, dryRun }) });
      } catch (err) {
        uiLog("error", `Texture conversion failed: ${err}`);
      } finally {
        set({ converting: false });
      }
    },

    setFolder: (folder) => set({ folder, duplicates: null, unused: null, sets: null, selectedSets: [], meshes: null, meshFiles: null }),
    setView: (view) => set({ view }),
    setIncludeBlend: (includeBlend) => set({ includeBlend }),
    setTriBudget: (triBudget) => set({ triBudget }),
    toggleSet: (key) => set((s) => ({ selectedSets: s.selectedSets.includes(key) ? s.selectedSets.filter((k) => k !== key) : [...s.selectedSets, key] })),
    selectPackable: (all) => set((s) => ({ selectedSets: all ? (s.sets?.sets.filter((x) => x.canPackOrm).map((x) => x.suggestedOrm) ?? []) : [] })),
    packSelectedSets: async () => {
      const { sets, selectedSets, format } = get();
      const chosen = sets?.sets.filter((x) => selectedSets.includes(x.suggestedOrm)) ?? [];
      if (!chosen.length) return;
      set({ packingSets: true });
      try {
        const results = await packOrmBatch(chosen.map((x) => ormConfigFor(x, format)));
        const failed = results.filter((r) => !r.ok).length;
        uiLog(failed ? "warn" : "info", `Packed ${results.length - failed} of ${results.length} ORM texture(s)`);
        // Re-scan: packed sets now have an ORM map.
        set({ selectedSets: [] });
        await get().runAnalysis("sets");
      } catch (err) {
        uiLog("error", `Batch ORM pack failed: ${err}`);
      } finally {
        set({ packingSets: false });
      }
    },
    inspectMeshFiles: async (files) => {
      set({ running: true, view: "meshes", meshFiles: files });
      try {
        set({ meshes: await inspectMeshes(files, get().triBudget) });
      } catch (err) {
        uiLog("error", String(err));
      } finally {
        set({ running: false });
      }
    },

    runAnalysis: async (view) => {
      const v = view ?? get().view;
      const { folder, includeBlend, triBudget, meshFiles } = get();
      if (v === "meshes" && meshFiles) return get().inspectMeshFiles(meshFiles);
      if (!folder) return;
      set({ running: true, view: v });
      try {
        if (v === "duplicates") set({ duplicates: await findDuplicateAssets(folder) });
        else if (v === "unused") set({ unused: await findUnusedTextures(folder, includeBlend) });
        else if (v === "sets") set({ sets: await findTextureSets(folder) });
        else set({ meshes: await inspectMeshes([folder], triBudget) });
      } catch (err) {
        uiLog("error", String(err));
      } finally {
        set({ running: false });
      }
    },
  };
});

registerDropHandler("tools", async (paths) => {
  useAppStore.getState().setActiveTab("tools");
  const { folders, files } = await classifyPaths(paths);
  const s = useToolsStore.getState();
  if (folders.length) {
    s.setFolder(folders[0]);
    void s.runAnalysis();
  }
  const meshes = files.filter((f) => MESH_RE.test(f));
  if (meshes.length) void s.inspectMeshFiles(meshes);
  const images = files.filter((f) => IMAGE_RE.test(f));
  // The converter takes any image; the ORM packer fills its slots by name (…_roughness, …_metallic, …_ao).
  if (s.leftView === "convert") {
    if (images.length) s.addConvertInputs(images);
    return;
  }
  const unmatched: string[] = [];
  for (const f of images) {
    const slot = guessSlot(f);
    if (slot) s.setSlot(slot, f);
    else unmatched.push(f);
  }
  if (unmatched.length) uiLog("info", `Could not tell the map type of ${unmatched.length} file(s); assign them with the slot buttons`);
});
