import { create } from "zustand";
import { registerDropHandler } from "../lib/dropRouter";
import { fixFbxPaths, restoreFbxBackup, scanFbxFiles } from "../lib/ipc";
import type { FbxFileInfo, FbxFixMode, FbxFixPlan, FbxFixResult } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export type FixScope = "issues" | "selected";

interface FbxState {
  /** Dropped FBX files and folders (folders are searched recursively). */
  sources: string[];
  /** Extra folders searched by file name for textures (e.g. a sibling `Textures/`). */
  searchDirs: string[];
  files: FbxFileInfo[];
  selected: string | null;
  scanning: boolean;
  fixing: boolean;

  mode: FbxFixMode;
  subfolder: string;
  rebaseDir: string | null;
  fixAll: boolean;
  backup: boolean;
  scope: FixScope;
  searchParent: boolean;
  guessMissing: boolean;
  /** Last dry run, shown until the options change. */
  preview: FbxFixResult | null;
  lastResult: FbxFixResult | null;

  load: (paths: string[]) => Promise<void>;
  rescan: () => Promise<void>;
  select: (path: string) => void;
  setOptions: (p: Partial<Pick<FbxState, "mode" | "subfolder" | "rebaseDir" | "fixAll" | "backup" | "scope" | "searchParent" | "guessMissing">>) => void;
  runFix: (dryRun: boolean) => Promise<void>;
  restore: (path: string) => Promise<void>;
  clear: () => void;
  addSearchDir: (dir: string) => Promise<void>;
  removeSearchDir: (dir: string) => Promise<void>;
}

function syncHeader(files: FbxFileInfo[]) {
  useAppStore.getState().setCounters({ brokenPathCount: files.reduce((n, f) => n + f.problemCount, 0) });
}

export const useFbxStore = create<FbxState>()((set, get) => ({
  sources: [],
  searchDirs: [],
  files: [],
  selected: null,
  scanning: false,
  fixing: false,
  mode: "relative",
  subfolder: "textures",
  rebaseDir: null,
  fixAll: false,
  backup: true,
  scope: "issues",
  searchParent: true,
  guessMissing: false,
  preview: null,
  lastResult: null,

  load: async (paths) => {
    set({ sources: paths, preview: null, lastResult: null });
    await get().rescan();
  },

  rescan: async () => {
    const { sources, selected, searchDirs, searchParent } = get();
    if (!sources.length) return;
    set({ scanning: true });
    try {
      const files = await scanFbxFiles(sources, searchDirs, searchParent);
      const keep = files.some((f) => f.path === selected) ? selected : (files.find((f) => f.hasIssues) ?? files[0])?.path ?? null;
      set({ files, selected: keep });
      syncHeader(files);
      if (!files.length) uiLog("warn", "No .fbx files found in the dropped items");
    } catch (err) {
      uiLog("error", `FBX scan failed: ${err}`);
    } finally {
      set({ scanning: false });
    }
  },

  select: (selected) => set({ selected }),

  setOptions: (p) => set({ ...p, preview: null }),

  runFix: async (dryRun) => {
    const { files, selected, scope, mode, subfolder, rebaseDir, fixAll, backup, searchDirs, searchParent, guessMissing } = get();
    const targets =
      scope === "selected" ? files.filter((f) => f.path === selected) : files.filter((f) => !f.error && (fixAll || f.hasIssues));
    if (!targets.length) {
      uiLog("info", "Nothing to fix");
      return;
    }
    const plan: FbxFixPlan = { paths: targets.map((f) => f.path), mode, subfolder, rebaseDir, fixAll, backup, dryRun, searchDirs, searchParent, guessMissing };
    set({ fixing: true });
    try {
      const result = await fixFbxPaths(plan);
      if (dryRun) {
        set({ preview: result });
      } else {
        set({ preview: null, lastResult: result });
        await get().rescan();
      }
    } catch (err) {
      uiLog("error", `FBX fix failed: ${err}`);
    } finally {
      set({ fixing: false });
    }
  },

  restore: async (path) => {
    try {
      if (await restoreFbxBackup(path)) await get().rescan();
    } catch (err) {
      uiLog("error", `Restore failed: ${err}`);
    }
  },

  clear: () => {
    set({ sources: [], files: [], selected: null, preview: null, lastResult: null });
    syncHeader([]);
  },

  addSearchDir: async (dir) => {
    if (get().searchDirs.includes(dir)) return;
    set((s) => ({ searchDirs: [...s.searchDirs, dir], preview: null }));
    await get().rescan();
  },
  removeSearchDir: async (dir) => {
    set((s) => ({ searchDirs: s.searchDirs.filter((d) => d !== dir), preview: null }));
    await get().rescan();
  },
}));

registerDropHandler("fbx", (paths) => {
  useAppStore.getState().setActiveTab("fbx");
  void useFbxStore.getState().load(paths);
});
