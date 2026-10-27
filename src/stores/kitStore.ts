import { create } from "zustand";
import { pickOne } from "../lib/dialogs";
import { assembleKit, loadAssetManifest, onKitProgress } from "../lib/ipc";
import type { AssetManifest, KitOptions, KitReport, RecipeProgress } from "../types/pipeline";
import { uiLog } from "./appStore";
import { buildManifest, useMatcherStore } from "./matcherStore";

const OPTIONS_KEY = "poseidon.kit.options";

const DEFAULTS: KitOptions = {
  dest: "",
  naming: "ue5",
  meshDir: "Meshes",
  textureDir: "Textures",
  keepPackages: false,
  packOrm: true,
  relink: true,
  includeOpen: false,
  overwrite: false,
  dryRun: true,
};

/** Destination and preferences survive restarts (per machine; nothing else depends on them). */
function loadOptions(): KitOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") as Partial<KitOptions>;
    return { ...DEFAULTS, ...saved, dryRun: true, overwrite: false };
  } catch {
    return DEFAULTS;
  }
}

function saveOptions(o: KitOptions) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...o, overwrite: false }));
  } catch {
    // Private mode / blocked storage: options just are not remembered.
  }
}

/** Slots in a manifest whose match is still open. */
export function openSlots(m: AssetManifest): number {
  return m.assets.reduce((n, a) => n + a.slots.filter((s) => s.textureSet && s.decision === "open").length, 0);
}

interface KitState {
  open: boolean;
  manifest: AssetManifest | null;
  /** Where the manifest came from: a file path, or null for the Asset Matcher's current picks. */
  manifestFile: string | null;
  options: KitOptions;
  plan: KitReport | null;
  planning: boolean;
  result: KitReport | null;
  running: boolean;
  progress: RecipeProgress | null;
  error: string | null;
  openFromMatcher: () => void;
  openManifestFile: () => Promise<void>;
  close: () => void;
  setOptions: (patch: Partial<KitOptions>) => void;
  pickDest: () => Promise<void>;
  preview: () => Promise<void>;
  assemble: () => Promise<void>;
}

export const useKitStore = create<KitState>()((set, get) => ({
  open: false,
  manifest: null,
  manifestFile: null,
  options: loadOptions(),
  plan: null,
  planning: false,
  result: null,
  running: false,
  progress: null,
  error: null,

  openFromMatcher: () => {
    const { report, overrides } = useMatcherStore.getState();
    if (!report) return;
    set({ open: true, manifest: buildManifest(report, overrides), manifestFile: null, plan: null, result: null, error: null });
  },
  openManifestFile: async () => {
    const path = await pickOne("file", [{ name: "Asset manifest", extensions: ["json"] }]);
    if (!path) return;
    try {
      const manifest = await loadAssetManifest(path);
      set({ open: true, manifest, manifestFile: path, plan: null, result: null, error: null });
    } catch (err) {
      uiLog("error", `Could not open the manifest: ${err}`);
    }
  },
  close: () => {
    if (!get().running) set({ open: false });
  },
  setOptions: (patch) => {
    const options = { ...get().options, ...patch };
    saveOptions(options);
    set({ options, result: null });
  },
  pickDest: async () => {
    const dest = await pickOne("folder");
    if (dest) {
      get().setOptions({ dest });
    }
  },
  /** The dialog re-plans (dry run) whenever the manifest or the options change. */
  preview: async () => {
    const { manifest, options } = get();
    if (!manifest || !options.dest) return set({ plan: null, error: null });
    set({ planning: true });
    try {
      set({ plan: await assembleKit(manifest, { ...options, dryRun: true }), error: null });
    } catch (err) {
      set({ plan: null, error: String(err) });
    } finally {
      set({ planning: false });
    }
  },
  assemble: async () => {
    const { manifest, options } = get();
    if (!manifest || !options.dest) return;
    set({ running: true, progress: null, error: null });
    const unlisten = await onKitProgress((progress) => set({ progress })).catch(() => null);
    try {
      const result = await assembleKit(manifest, { ...options, dryRun: false });
      // Afterwards the plan shows what is now in the destination.
      set({ result, plan: result });
    } catch (err) {
      set({ error: String(err) });
      uiLog("error", `Kit assembly failed: ${err}`);
    } finally {
      unlisten?.();
      set({ running: false, progress: null });
    }
  },
}));
