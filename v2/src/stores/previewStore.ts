import { create } from "zustand";
import { bumpAssetRevision } from "../lib/assetUrl";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { scanDirectory } from "../lib/ipc";
import { dirname } from "../lib/pathUtil";
import type { AssetFile } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

/** Kept free of three.js so it can load eagerly; the viewers themselves are lazy. */
export const PREVIEW_EXTS = ["fbx", "obj", "gltf", "glb", "png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds", "hdr", "exr", "psd", "tif", "tiff"];

interface PreviewState {
  folder: string | null;
  assets: AssetFile[];
  selected: string | null;
  scanning: boolean;
  filter: string;
  load: (paths: string[]) => Promise<void>;
  select: (path: string) => void;
  setFilter: (q: string) => void;
  /** Drop the list and selection (unloading the viewer) and invalidate cached file data. */
  clear: () => void;
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  folder: null,
  assets: [],
  selected: null,
  scanning: false,
  filter: "",

  load: async (paths) => {
    const { folders, files } = await classifyPaths(paths);
    const file = files.find((f) => PREVIEW_EXTS.includes(f.split(".").pop()!.toLowerCase()));
    const folder = folders[0] ?? (file ? dirname(file) : null);
    if (!folder) {
      uiLog("warn", "Nothing previewable in the dropped items");
      return;
    }
    set({ folder, scanning: true, selected: file ?? null });
    try {
      const summary = await scanDirectory(folder, !!folders[0], PREVIEW_EXTS);
      set((s) => ({ assets: summary.files, selected: s.selected ?? summary.files[0]?.path ?? null }));
    } catch (err) {
      uiLog("error", `Preview scan failed: ${err}`);
    } finally {
      set({ scanning: false });
    }
  },
  select: (selected) => set({ selected }),
  setFilter: (filter) => set({ filter }),
  clear: () => {
    bumpAssetRevision();
    set({ folder: null, assets: [], selected: null, filter: "" });
    uiLog("info", "Preview cleared");
  },
}));

registerDropHandler("preview", (paths) => {
  useAppStore.getState().setActiveTab("preview");
  void usePreviewStore.getState().load(paths);
});
