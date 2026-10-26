import { create } from "zustand";
import { registerDropHandler } from "../lib/dropRouter";
import { cancelBlenderPack, discoverBlender, onBlenderProgress, runBlenderPack } from "../lib/ipc";
import { dirname, joinPath, stem } from "../lib/pathUtil";
import type { BlenderInstall, BlenderPackReport, BlenderProgress } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";

export interface PackForm {
  consolidate: boolean;
  unpack: boolean;
  makeRelative: boolean;
  packAll: boolean;
  analyseOnly: boolean;
  saveAsNew: boolean;
  outputPath: string;
  makeZip: boolean;
  zipPath: string;
}

interface BlenderState {
  installs: BlenderInstall[];
  discovered: boolean;
  discovering: boolean;
  blenderPath: string | null;
  blendFile: string | null;
  form: PackForm;
  running: boolean;
  progress: BlenderProgress | null;
  result: BlenderPackReport | null;

  discover: () => Promise<void>;
  setBlender: (path: string) => void;
  setBlendFile: (path: string) => void;
  setForm: (p: Partial<PackForm>) => void;
  run: () => Promise<void>;
  cancel: () => Promise<void>;
}

/** Default output locations next to the source file. */
function defaultsFor(blend: string): Pick<PackForm, "outputPath" | "zipPath"> {
  const dir = dirname(blend);
  const name = stem(blend);
  return { outputPath: joinPath(dir, `${name}_packed`, `${name}.blend`), zipPath: joinPath(dir, `${name}_bundle.zip`) };
}

export const useBlenderStore = create<BlenderState>()((set, get) => ({
  installs: [],
  discovered: false,
  discovering: false,
  blenderPath: null,
  blendFile: null,
  form: {
    consolidate: true,
    unpack: false,
    makeRelative: true,
    packAll: false,
    analyseOnly: false,
    saveAsNew: true,
    outputPath: "",
    makeZip: false,
    zipPath: "",
  },
  running: false,
  progress: null,
  result: null,

  discover: async () => {
    set({ discovering: true });
    try {
      const installs = await discoverBlender();
      const current = get().blenderPath;
      const best = installs.find((b) => b.supported) ?? installs[0];
      set({ installs, discovered: true, blenderPath: current ?? best?.executable ?? null });
    } catch (err) {
      uiLog("error", `Blender discovery failed: ${err}`);
    } finally {
      set({ discovering: false, discovered: true }); // no automatic retry loop on failure
    }
  },

  setBlender: (blenderPath) => set({ blenderPath }),

  setBlendFile: (blendFile) => set((s) => ({ blendFile, result: null, progress: null, form: { ...s.form, ...defaultsFor(blendFile) } })),

  setForm: (p) => set((s) => ({ form: { ...s.form, ...p } })),

  run: async () => {
    const { blendFile, blenderPath, form } = get();
    if (!blendFile || get().running) return;
    set({ running: true, progress: null, result: null });
    const unlisten = await onBlenderProgress((progress) => set({ progress }));
    try {
      const result = await runBlenderPack({
        blenderPath,
        blendFile,
        options: {
          consolidate: form.consolidate,
          unpack: form.unpack,
          makeRelative: form.makeRelative,
          packAll: form.packAll,
          analyseOnly: form.analyseOnly,
          output: form.saveAsNew && !form.analyseOnly ? form.outputPath || null : null,
          zipArchive: form.makeZip && !form.analyseOnly ? form.zipPath || null : null,
        },
      });
      set({ result });
    } catch (err) {
      uiLog("error", `Blender pack failed: ${err}`);
    } finally {
      unlisten();
      set({ running: false });
    }
  },

  cancel: async () => {
    await cancelBlenderPack();
  },
}));

registerDropHandler("blender", (paths) => {
  const blend = paths.find((p) => p.toLowerCase().endsWith(".blend"));
  if (!blend) {
    uiLog("warn", "Drop a .blend file to consolidate it");
    return;
  }
  useAppStore.getState().setActiveTab("blender");
  useBlenderStore.getState().setBlendFile(blend);
});
