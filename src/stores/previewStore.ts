import { create } from "zustand";
import { DEFAULT_LIGHTING, type EnvSource, type LightingParams } from "../components/previewer/lighting";
import { bumpAssetRevision } from "../lib/assetUrl";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { scanDirectory } from "../lib/ipc";
import { basename, dirname } from "../lib/pathUtil";
import { clearThumbCache } from "../lib/thumbCache";
import type { AssetFile } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

/** Kept free of three.js so it can load eagerly; the viewers themselves are lazy. */
export const PREVIEW_EXTS = ["fbx", "obj", "gltf", "glb", "png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds", "hdr", "exr", "psd", "tif", "tiff"];

interface PreviewState {
  folder: string | null;
  assets: AssetFile[];
  selected: string | null;
  /** Model to go back to after opening one of its textures from the material inspector. */
  returnTo: string | null;
  scanning: boolean;
  filter: string;
  listView: "grid" | "list";
  /** Reload the open file when it changes on disk. */
  autoReload: boolean;
  /** Bumped to make the open viewer reload its file (keeping the camera). */
  reloadToken: number;
  lighting: LightingParams;
  environment: EnvSource;
  load: (paths: string[]) => Promise<void>;
  select: (path: string) => void;
  /** Open a texture of the current model, remembering the model for "Back". */
  openTexture: (path: string) => void;
  setFilter: (q: string) => void;
  setListView: (v: "grid" | "list") => void;
  setAutoReload: (on: boolean) => void;
  /** A watched file changed: refetch it and refresh its entry (and thumbnail key). */
  reload: (changed: string[], stats?: Map<string, { size: number; modifiedMs: number }>) => void;
  setLighting: (p: Partial<LightingParams>) => void;
  setEnvironment: (env: EnvSource) => void;
  /** Drop the list and selection (unloading the viewer) and invalidate cached file data and thumbnails. */
  clear: () => void;
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  folder: null,
  assets: [],
  selected: null,
  returnTo: null,
  scanning: false,
  filter: "",
  listView: "grid",
  autoReload: true,
  reloadToken: 0,
  lighting: { ...DEFAULT_LIGHTING },
  environment: { kind: "studio" },

  load: async (paths) => {
    const { folders, files } = await classifyPaths(paths);
    const file = files.find((f) => PREVIEW_EXTS.includes(f.split(".").pop()!.toLowerCase()));
    const folder = folders[0] ?? (file ? dirname(file) : null);
    if (!folder) {
      uiLog("warn", "Nothing previewable in the dropped items");
      return;
    }
    set({ folder, scanning: true, selected: file ?? null, returnTo: null });
    try {
      const summary = await scanDirectory(folder, !!folders[0], PREVIEW_EXTS);
      set((s) => ({ assets: summary.files, selected: s.selected ?? summary.files[0]?.path ?? null }));
    } catch (err) {
      uiLog("error", `Preview scan failed: ${err}`);
    } finally {
      set({ scanning: false });
    }
  },
  select: (selected) => set({ selected, returnTo: null }),
  openTexture: (path) => set((s) => ({ selected: path, returnTo: s.returnTo ?? s.selected })),
  setFilter: (filter) => set({ filter }),
  setListView: (listView) => set({ listView }),
  setAutoReload: (autoReload) => set({ autoReload }),
  reload: (changed, stats) => {
    bumpAssetRevision();
    set((s) => {
      if (!stats) return { reloadToken: s.reloadToken + 1 };
      // A changed texture also changes how its model looks: give the open model a new thumbnail key.
      const newest = Math.max(...[...stats.values()].map((v) => v.modifiedMs));
      // Scanned paths can mix separators ("C:/dir\\sub\\x.png"); compare them normalized.
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const byPath = new Map([...stats].map(([p, v]) => [norm(p), v]));
      const assets = s.assets.map((a) => {
        const stamp = byPath.get(norm(a.path));
        if (stamp) return { ...a, ...stamp };
        if (a.path === s.selected && newest > a.modifiedMs) return { ...a, modifiedMs: newest };
        return a;
      });
      return { reloadToken: s.reloadToken + 1, assets };
    });
    uiLog("info", `Reloaded after a change on disk: ${changed.map((p) => basename(p)).join(", ")}`);
  },
  setLighting: (p) => set((s) => ({ lighting: { ...s.lighting, ...p } })),
  setEnvironment: (environment) => set({ environment }),
  clear: () => {
    bumpAssetRevision();
    set({ folder: null, assets: [], selected: null, returnTo: null, filter: "" });
    void clearThumbCache();
    void import("../components/previewer/thumbnailRenderer").then((m) => m.resetThumbnails());
    uiLog("info", "Preview cleared (list, cached files and thumbnails)");
  },
}));

registerDropHandler("preview", (paths) => {
  useAppStore.getState().setActiveTab("preview");
  void usePreviewStore.getState().load(paths);
});
