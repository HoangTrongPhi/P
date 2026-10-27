import { create } from "zustand";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { scanDirectory } from "../lib/ipc";
import { dirname } from "../lib/pathUtil";
import type { AssetCategory, AssetFile, ScanSummary } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export type Metric = "count" | "size";

/** Chart order of the asset types; also their color slot order. */
export const TYPES: AssetCategory[] = ["mesh", "texture", "scene", "source"];
export const ROOT_PACKAGE = "(root files)";

export interface Totals {
  count: number;
  size: number;
}

export interface PackageRow {
  name: string;
  total: Totals;
  byType: Record<AssetCategory, Totals>;
}

const zero = (): Totals => ({ count: 0, size: 0 });
const emptyByType = () => Object.fromEntries(TYPES.concat("other").map((t) => [t, zero()])) as Record<AssetCategory, Totals>;

/** Package = the first `depth` folder levels under the root (`Wall Modular`, `Wall Modular/Textures`). */
export function packageOf(file: AssetFile, root: string, depth: number): string {
  const rel = file.path.slice(root.length).replace(/^[\\/]+/, "");
  const parts = rel.split(/[\\/]/);
  const dirs = parts.slice(0, Math.min(depth, parts.length - 1));
  return dirs.length ? dirs.join("/") : ROOT_PACKAGE;
}

export function packageRows(summary: ScanSummary, depth: number): PackageRow[] {
  const rows = new Map<string, PackageRow>();
  for (const f of summary.files) {
    const name = packageOf(f, summary.root, depth);
    let row = rows.get(name);
    if (!row) rows.set(name, (row = { name, total: zero(), byType: emptyByType() }));
    row.total.count++;
    row.total.size += f.size;
    row.byType[f.category].count++;
    row.byType[f.category].size += f.size;
  }
  return [...rows.values()];
}

export function typeTotals(files: AssetFile[]): Record<AssetCategory, Totals & { exts: Map<string, Totals> }> {
  const out = Object.fromEntries(TYPES.concat("other").map((t) => [t, { ...zero(), exts: new Map<string, Totals>() }])) as Record<AssetCategory, Totals & { exts: Map<string, Totals> }>;
  for (const f of files) {
    const t = out[f.category];
    t.count++;
    t.size += f.size;
    const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "(none)";
    const e = t.exts.get(ext) ?? zero();
    e.count++;
    e.size += f.size;
    t.exts.set(ext, e);
  }
  return out;
}

interface DashboardState {
  folder: string | null;
  summary: ScanSummary | null;
  loading: boolean;
  metric: Metric;
  /** Folder levels that make a package. */
  depth: number;
  load: (folder: string) => Promise<void>;
  refresh: () => Promise<void>;
  setMetric: (m: Metric) => void;
  setDepth: (d: number) => void;
}

export const useDashboardStore = create<DashboardState>()((set, get) => ({
  folder: null,
  summary: null,
  loading: false,
  metric: "count",
  depth: 1,
  load: async (folder) => {
    set({ folder, loading: true });
    try {
      // Only names and sizes are read: on a streamed Google Drive this downloads nothing.
      set({ summary: await scanDirectory(folder, true, []) });
    } catch (err) {
      uiLog("error", `Dashboard scan failed: ${err}`);
    } finally {
      set({ loading: false });
    }
  },
  refresh: async () => {
    const { folder, load } = get();
    if (folder) await load(folder);
  },
  setMetric: (metric) => set({ metric }),
  setDepth: (depth) => set({ depth }),
}));

registerDropHandler("dashboard", async (paths) => {
  useAppStore.getState().setActiveTab("dashboard");
  const { folders, files } = await classifyPaths(paths);
  const folder = folders[0] ?? (files[0] ? dirname(files[0]) : null);
  if (folder) await useDashboardStore.getState().load(folder);
});
