import { create } from "zustand";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { findDuplicateAssets, findUnusedTextures, packOrmTexture } from "../lib/ipc";
import { dirname, joinPath, stem } from "../lib/pathUtil";
import type { DuplicateReport, UnusedReport } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export type OrmSlot = "ao" | "roughness" | "metallic";
export type ToolsView = "duplicates" | "unused";

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

  folder: string | null;
  view: ToolsView;
  running: boolean;
  duplicates: DuplicateReport | null;
  unused: UnusedReport | null;

  setSlot: (slot: OrmSlot, path: string | null) => void;
  setGloss: (v: boolean) => void;
  setFormat: (f: "png" | "tga") => void;
  setOutputPath: (p: string) => void;
  pack: () => Promise<void>;
  setFolder: (f: string) => void;
  setView: (v: ToolsView) => void;
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
    folder: null,
    view: "duplicates",
    running: false,
    duplicates: null,
    unused: null,

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

    setFolder: (folder) => set({ folder, duplicates: null, unused: null }),
    setView: (view) => set({ view }),

    runAnalysis: async (view) => {
      const v = view ?? get().view;
      const { folder } = get();
      if (!folder) return;
      set({ running: true, view: v });
      try {
        if (v === "duplicates") set({ duplicates: await findDuplicateAssets(folder) });
        else set({ unused: await findUnusedTextures(folder) });
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
  // Image files fill the ORM slots by their name (…_roughness, …_metallic, …_ao).
  const unmatched: string[] = [];
  for (const f of files) {
    const slot = guessSlot(f);
    if (slot) s.setSlot(slot, f);
    else unmatched.push(f);
  }
  if (unmatched.length) uiLog("info", `Could not tell the map type of ${unmatched.length} file(s); assign them with the slot buttons`);
});
