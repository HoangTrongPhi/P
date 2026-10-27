import { create } from "zustand";
import { pickSavePath } from "../lib/dialogs";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { cancelMatching, clearMeshCache, matchAssets, matcherEstimate, onMatcherProgress, saveTextFile } from "../lib/ipc";
import { dirname } from "../lib/pathUtil";
import { relPath } from "../lib/reports";
import type { MatchReport, MatchStatus, ReadEstimate, RecipeProgress, SlotMatch, TextureSet } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export type MatchFilter = "all" | "todo" | "review" | "none";

/** `<mesh index>:<slot index>`. */
export const slotKey = (mesh: number, slot: number) => `${mesh}:${slot}`;

/** A person's pick for a slot: a set index, or `null` for "no texture". */
export type Override = number | null;

export interface Choice {
  set: number | null;
  score: number | null;
  /** auto: the matcher's pick; manual: chosen or confirmed by a person; open: still needs a decision. */
  decision: "auto" | "manual" | "open";
}

/** What a slot ends up with: the person's pick, else the matcher's best unless it is unsure. */
export function choiceFor(slot: SlotMatch, override: Override | undefined): Choice {
  if (override !== undefined) {
    return { set: override, score: slot.candidates.find((c) => c.set === override)?.score ?? null, decision: "manual" };
  }
  const best = slot.candidates[0];
  if (!best) return { set: null, score: null, decision: "open" };
  return { set: best.set, score: best.score, decision: slot.status === "review" ? "open" : "auto" };
}

export function needsDecision(slot: SlotMatch, override: Override | undefined): boolean {
  return choiceFor(slot, override).decision === "open";
}

function setJson(set: TextureSet, root: string) {
  return {
    name: set.name,
    folder: relPath(set.dir, root),
    maps: Object.fromEntries(Object.entries(set.maps).map(([k, p]) => [k, relPath(p, root)])),
    missingMaps: set.missing,
  };
}

/** `asset_manifest.json`: every mesh slot with its texture set, paths relative to the delivery root. */
export function buildManifest(report: MatchReport, overrides: Record<string, Override>, generated = new Date()) {
  const used = new Set<number>();
  const assets = report.meshes.map((m, mi) => ({
    mesh: relPath(m.path, report.root),
    slots: m.slots.map((s, si) => {
      const c = choiceFor(s, overrides[slotKey(mi, si)]);
      if (c.set !== null) used.add(c.set);
      return {
        slot: s.name,
        isMaterial: s.isMaterial,
        textureSet: c.set === null ? null : setJson(report.sets[c.set], report.root),
        confidence: c.score,
        status: s.status as MatchStatus,
        decision: c.decision,
      };
    }),
    missingReferences: m.missingReferences,
    error: m.error,
  }));
  return {
    format: "project-p.asset-manifest",
    version: 1,
    root: report.root,
    generated: generated.toISOString(),
    assets,
    unassignedTextureSets: report.sets.flatMap((s, i) => (used.has(i) ? [] : [setJson(s, report.root)])),
    looseTextures: report.looseTextures.map((p) => relPath(p, report.root)),
  };
}

/** On Google Drive, ask before downloading more mesh data than this. */
export const CONFIRM_BYTES = 64 * 1024 * 1024;

interface MatcherState {
  folder: string | null;
  report: MatchReport | null;
  loading: boolean;
  /** A Drive folder waiting for the go-ahead to download its meshes. */
  confirm: ReadEstimate | null;
  progress: RecipeProgress | null;
  confirmRead: () => Promise<void>;
  dismissConfirm: () => void;
  cancel: () => void;
  clearCache: () => Promise<void>;
  filter: MatchFilter;
  query: string;
  overrides: Record<string, Override>;
  selected: string | null;
  load: (folder: string) => Promise<void>;
  refresh: () => Promise<void>;
  setFilter: (f: MatchFilter) => void;
  setQuery: (q: string) => void;
  select: (key: string | null) => void;
  choose: (key: string, set: Override) => void;
  /** Back to the matcher's pick. */
  reset: (key: string) => void;
  /** Confirm the matcher's best pick for every slot still open. */
  acceptAllBest: () => void;
  saveManifest: () => Promise<void>;
}

export const useMatcherStore = create<MatcherState>()((set, get) => ({
  folder: null,
  report: null,
  loading: false,
  filter: "all",
  query: "",
  overrides: {},
  selected: null,
  confirm: null,
  progress: null,
  load: async (folder) => {
    const keep = get().folder === folder && !!get().report;
    set({ folder, confirm: null, ...(keep ? {} : { report: null }) });
    // Names and sizes only; decides whether reading the meshes needs a go-ahead.
    const estimate = await matcherEstimate(folder).catch(() => null);
    if (estimate?.onDrive && estimate.bytes - estimate.cachedBytes > CONFIRM_BYTES) {
      set({ confirm: estimate });
      return;
    }
    await runMatch(folder, keep);
  },
  confirmRead: async () => {
    const { folder, report } = get();
    if (!folder) return;
    set({ confirm: null });
    await runMatch(folder, !!report);
  },
  dismissConfirm: () => set({ confirm: null }),
  cancel: () => void cancelMatching().catch(() => {}),
  clearCache: async () => {
    try {
      const n = await clearMeshCache();
      uiLog("info", `Forgot ${n} cached mesh file(s); the next match reads them again`);
    } catch (err) {
      uiLog("error", `Clearing the mesh cache failed: ${err}`);
    }
  },
  refresh: async () => {
    const { folder, load } = get();
    if (folder) await load(folder);
  },
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  select: (selected) => set({ selected }),
  choose: (key, value) => set((s) => ({ overrides: { ...s.overrides, [key]: value } })),
  reset: (key) =>
    set((s) => {
      const overrides = { ...s.overrides };
      delete overrides[key];
      return { overrides };
    }),
  acceptAllBest: () =>
    set((s) => {
      if (!s.report) return {};
      const overrides = { ...s.overrides };
      s.report.meshes.forEach((m, mi) =>
        m.slots.forEach((slot, si) => {
          const key = slotKey(mi, si);
          if (overrides[key] === undefined && slot.status === "review" && slot.candidates[0]) overrides[key] = slot.candidates[0].set;
        }),
      );
      return { overrides };
    }),
  saveManifest: async () => {
    const { report, overrides } = get();
    if (!report) return;
    const path = await pickSavePath("asset_manifest.json", [{ name: "Asset manifest", extensions: ["json"] }]);
    if (!path) return;
    const target = /\.json$/i.test(path) ? path : `${path}.json`;
    try {
      await saveTextFile(target, JSON.stringify(buildManifest(report, overrides), null, 2));
      uiLog("info", `Asset manifest saved: ${target}`);
    } catch (err) {
      uiLog("error", `Saving the manifest failed: ${err}`);
    }
  },
}));

/** Read and match `folder`; `keep` keeps the picks a person already made (a refresh). */
async function runMatch(folder: string, keep: boolean) {
  const set = useMatcherStore.setState;
  set({ loading: true, progress: null });
  const unlisten = await onMatcherProgress((progress) => set({ progress })).catch(() => null);
  try {
    const report = await matchAssets(folder);
    set({ report, ...(keep ? {} : { overrides: {}, selected: null }) });
  } catch (err) {
    if (String(err) !== "Cancelled") uiLog("error", `Asset matching failed: ${err}`);
  } finally {
    unlisten?.();
    set({ loading: false, progress: null });
  }
}

registerDropHandler("matcher", async (paths) => {
  useAppStore.getState().setActiveTab("matcher");
  const { folders, files } = await classifyPaths(paths);
  const folder = folders[0] ?? (files[0] ? dirname(files[0]) : null);
  if (folder) await useMatcherStore.getState().load(folder);
});
