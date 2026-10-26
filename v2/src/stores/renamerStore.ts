import { create } from "zustand";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { applyRename, dryRunRename, renameHistory, undoLastRename } from "../lib/ipc";
import { dirname } from "../lib/pathUtil";
import type { RenameRow, RenameRuleSpec, TransactionSummary } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export type AssetFilter = "all" | "mesh" | "texture" | "source";

const FILTER_EXTS: Record<AssetFilter, string[]> = {
  all: [],
  mesh: ["fbx", "obj", "glb", "gltf"],
  texture: ["png", "jpg", "jpeg", "tga", "dds", "exr", "hdr", "tif", "tiff", "bmp", "webp"],
  source: ["psd"],
};

export interface RuleItem {
  id: number;
  enabled: boolean;
  spec: RenameRuleSpec;
}

let nextId = 1;
export const newRule = (spec: RenameRuleSpec): RuleItem => ({ id: nextId++, enabled: true, spec });

interface RenamerState {
  /** Working folder: scanned for files and home of `.rename_history.json`. */
  folder: string | null;
  /** Explicit files (when individual files were dropped instead of a folder). */
  files: string[] | null;
  recursive: boolean;
  filter: AssetFilter;
  rules: RuleItem[];
  rows: RenameRow[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  history: TransactionSummary[];

  load: (paths: string[]) => Promise<void>;
  setRecursive: (v: boolean) => void;
  setFilter: (v: AssetFilter) => void;
  addRule: (spec: RenameRuleSpec) => void;
  updateRule: (id: number, patch: Partial<RuleItem>) => void;
  removeRule: (id: number) => void;
  moveRule: (id: number, delta: -1 | 1) => void;
  refresh: () => Promise<void>;
  apply: () => Promise<void>;
  undo: () => Promise<void>;
}

let requestSeq = 0;
/** Renames applied this session (old -> new), newest last, to keep an explicit file list in sync on undo. */
const moveStack: Map<string, string>[] = [];

export const useRenamerStore = create<RenamerState>()((set, get) => ({
  folder: null,
  files: null,
  recursive: false,
  filter: "all",
  rules: [newRule({ kind: "preset", preset: "ue5" })],
  rows: [],
  loading: false,
  busy: false,
  error: null,
  history: [],

  load: async (paths) => {
    const { folders, files } = await classifyPaths(paths);
    moveStack.length = 0;
    if (folders.length) {
      if (folders.length > 1) uiLog("warn", `Renamer works on one folder at a time; using ${folders[0]}`);
      set({ folder: folders[0], files: null, rows: [] });
    } else if (files.length) {
      set({ folder: dirname(files[0]), files, rows: [] });
    }
    await Promise.all([get().refresh(), loadHistory()]);
  },
  setRecursive: (recursive) => set({ recursive }),
  setFilter: (filter) => set({ filter }),
  addRule: (spec) => set((s) => ({ rules: [...s.rules, newRule(spec)] })),
  updateRule: (id, patch) => set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
  moveRule: (id, delta) =>
    set((s) => {
      const i = s.rules.findIndex((r) => r.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= s.rules.length) return s;
      const rules = [...s.rules];
      [rules[i], rules[j]] = [rules[j], rules[i]];
      return { rules };
    }),

  refresh: async () => {
    const { folder, files, recursive, filter, rules } = get();
    if (!folder) return;
    const seq = ++requestSeq;
    set({ loading: true });
    try {
      const rows = await dryRunRename(folder, {
        rules: rules.filter((r) => r.enabled).map((r) => r.spec),
        recursive,
        extensions: FILTER_EXTS[filter],
        paths: files ?? undefined,
      });
      // Ignore answers to superseded requests (rules change faster than big folders scan).
      if (seq === requestSeq) set({ rows, error: null, loading: false });
    } catch (err) {
      if (seq === requestSeq) set({ error: String(err), loading: false });
    }
  },

  apply: async () => {
    const { folder, rows } = get();
    const items = rows.filter((r) => r.status === "OK").map((r) => ({ originalPath: r.originalPath, targetPath: r.targetPath }));
    if (!folder || !items.length) return;
    set({ busy: true });
    try {
      const res = await applyRename(folder, items);
      if (res.rejected.length) uiLog("warn", `${res.rejected.length} rename(s) refused by the final safety check`);
      // Files that were renamed no longer exist under their old names.
      const moved = new Map(items.filter((i) => !res.rejected.some((r) => r.originalPath === i.originalPath)).map((i) => [i.originalPath, i.targetPath]));
      moveStack.push(moved);
      const { files } = get();
      if (files) set({ files: files.map((f) => moved.get(f) ?? f) });
    } catch (err) {
      uiLog("error", String(err));
    } finally {
      set({ busy: false });
      await Promise.all([get().refresh(), loadHistory()]);
    }
  },

  undo: async () => {
    const { folder } = get();
    if (!folder) return;
    set({ busy: true });
    try {
      const res = await undoLastRename(folder);
      const moved = res.restored ? moveStack.pop() : undefined;
      const { files } = get();
      if (files && res.restored) {
        if (moved) {
          const back = new Map([...moved].map(([from, to]) => [to, from]));
          set({ files: files.map((f) => back.get(f) ?? f) });
        } else {
          set({ files: null }); // renamed in an earlier session: names unknown, fall back to the folder
        }
      }
    } catch (err) {
      uiLog("error", String(err));
    } finally {
      set({ busy: false });
      await Promise.all([get().refresh(), loadHistory()]);
    }
  },
}));

async function loadHistory() {
  const folder = useRenamerStore.getState().folder;
  if (!folder) return;
  try {
    useRenamerStore.setState({ history: await renameHistory(folder) });
  } catch {
    useRenamerStore.setState({ history: [] });
  }
}

registerDropHandler("renamer", (paths) => {
  useAppStore.getState().setActiveTab("renamer");
  void useRenamerStore.getState().load(paths);
});
