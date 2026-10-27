import { create } from "zustand";
import { pickOne, pickSavePath } from "../lib/dialogs";
import { registerDropHandler } from "../lib/dropRouter";
import { classifyPaths } from "../lib/fsInfo";
import { loadRecipe, onRecipeProgress, runRecipe, saveTextFile } from "../lib/ipc";
import type { Recipe, RecipeProgress, RecipeRun, RecipeStep, RecipeStepKind } from "../types/pipeline";
import { uiLog, useAppStore } from "./appStore";
import { useRenamerStore } from "./renamerStore";

export interface StepItem {
  id: number;
  step: RecipeStep;
}

let nextId = 1;
const item = (step: RecipeStep): StepItem => ({ id: nextId++, step });

export const STEP_INFO: Record<RecipeStepKind, { title: string; description: string }> = {
  rename: { title: "Rename assets", description: "Renamer rules; undo from the Renamer tab" },
  fbxFix: { title: "Fix FBX texture paths", description: "FBX Doctor on every .fbx (with .fbx.bak backups)" },
  packOrm: { title: "Pack ORM textures", description: "One ORM per texture set that has roughness / metallic / AO" },
  convertTextures: { title: "Convert textures", description: "Resize, flip normal green, change format" },
  inspectMeshes: { title: "Inspect meshes", description: "Triangles, UVs, normals, units — report only" },
  findUnused: { title: "Find unused textures", description: "Report only, nothing is deleted" },
  findDuplicates: { title: "Find duplicates", description: "Report only, nothing is deleted" },
};

export function defaultStep(kind: RecipeStepKind): RecipeStep {
  switch (kind) {
    case "rename":
      return { kind, rules: [{ kind: "preset", preset: "ue5" }], recursive: true };
    case "fbxFix":
      return { kind, options: { mode: "relative", subfolder: "textures" } };
    case "packOrm":
      return { kind, format: "png", overwrite: false };
    case "convertTextures":
      return { kind, options: { maxSize: 2048, format: "keep", outputDir: "converted" }, nameContains: "" };
    case "inspectMeshes":
      return { kind, triBudget: null };
    case "findUnused":
      return { kind, includeBlend: false };
    case "findDuplicates":
      return { kind };
  }
}

export const TEMPLATES: { id: string; recipe: Recipe }[] = [
  {
    id: "ue5",
    recipe: {
      name: "Unreal Engine 5 import prep",
      steps: [
        { kind: "rename", rules: [{ kind: "preset", preset: "ue5" }], recursive: true },
        { kind: "fbxFix", options: { mode: "relative" } },
        { kind: "packOrm", format: "tga" },
        { kind: "convertTextures", options: { maxSize: 4096, powerOfTwo: true, format: "keep", outputDir: "converted" }, nameContains: "" },
        { kind: "inspectMeshes", triBudget: 100000 },
      ],
    },
  },
  {
    id: "unity",
    recipe: {
      name: "Unity import prep",
      steps: [
        { kind: "rename", rules: [{ kind: "preset", preset: "unity" }], recursive: true },
        { kind: "fbxFix", options: { mode: "collect", subfolder: "Textures" } },
        { kind: "convertTextures", options: { flipGreen: true, format: "keep", outputDir: ".", suffix: "_GL" }, nameContains: "_N" },
        { kind: "inspectMeshes", triBudget: 50000 },
      ],
    },
  },
  {
    id: "audit",
    recipe: {
      name: "Asset audit (read only)",
      steps: [{ kind: "inspectMeshes", triBudget: null }, { kind: "findUnused", includeBlend: false }, { kind: "findDuplicates" }],
    },
  },
];

interface RecipeState {
  name: string;
  steps: StepItem[];
  /** File the recipe was loaded from / saved to. */
  file: string | null;
  folder: string | null;
  dryRun: boolean;
  running: boolean;
  progress: RecipeProgress | null;
  result: RecipeRun | null;

  setName: (name: string) => void;
  addStep: (kind: RecipeStepKind) => void;
  updateStep: (id: number, step: RecipeStep) => void;
  removeStep: (id: number) => void;
  moveStep: (id: number, delta: -1 | 1) => void;
  applyTemplate: (id: string) => void;
  /** Replace a rename step's rules with the Renamer tab's enabled rules. */
  importRenamerRules: (id: number) => void;
  toRecipe: () => Recipe;
  save: () => Promise<void>;
  open: (path?: string) => Promise<void>;
  setFolder: (folder: string | null) => void;
  setDryRun: (v: boolean) => void;
  run: () => Promise<void>;
}

const fromRecipe = (r: Recipe) => ({ name: r.name, steps: r.steps.map(item), result: null });

export const useRecipeStore = create<RecipeState>()((set, get) => ({
  ...fromRecipe(TEMPLATES[0].recipe),
  file: null,
  folder: null,
  dryRun: true,
  running: false,
  progress: null,

  setName: (name) => set({ name }),
  addStep: (kind) => set((s) => ({ steps: [...s.steps, item(defaultStep(kind))] })),
  updateStep: (id, step) => set((s) => ({ steps: s.steps.map((x) => (x.id === id ? { ...x, step } : x)) })),
  removeStep: (id) => set((s) => ({ steps: s.steps.filter((x) => x.id !== id) })),
  moveStep: (id, delta) =>
    set((s) => {
      const i = s.steps.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= s.steps.length) return s;
      const steps = [...s.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { steps };
    }),
  applyTemplate: (id) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (t) set({ ...fromRecipe(structuredClone(t.recipe)), file: null });
  },
  importRenamerRules: (id) => {
    const rules = useRenamerStore.getState().rules.filter((r) => r.enabled).map((r) => r.spec);
    if (!rules.length) {
      uiLog("warn", "The Renamer tab has no enabled rules");
      return;
    }
    const cur = get().steps.find((x) => x.id === id)?.step;
    if (cur?.kind === "rename") get().updateStep(id, { ...cur, rules });
  },
  toRecipe: () => ({ name: get().name, steps: get().steps.map((x) => x.step) }),

  save: async () => {
    const { file, name } = get();
    const fallback = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe"}.json`;
    const path = await pickSavePath(file ?? fallback, [{ name: "Project P recipe", extensions: ["json"] }]);
    if (!path) return;
    const target = /\.json$/i.test(path) ? path : `${path}.json`;
    try {
      await saveTextFile(target, JSON.stringify(get().toRecipe(), null, 2) + "\n");
      set({ file: target });
    } catch (err) {
      uiLog("error", `Saving the recipe failed: ${err}`);
    }
  },
  open: async (path) => {
    const p = path ?? (await pickOne("file", [{ name: "Project P recipe", extensions: ["json"] }]));
    if (!p) return;
    try {
      const recipe = await loadRecipe(p);
      set({ ...fromRecipe(recipe), file: p });
      uiLog("info", `Loaded recipe "${recipe.name}" (${recipe.steps.length} steps)`);
    } catch (err) {
      uiLog("error", String(err));
    }
  },
  setFolder: (folder) => set({ folder, result: null }),
  setDryRun: (dryRun) => set({ dryRun }),

  run: async () => {
    const { folder, dryRun } = get();
    if (!folder) return;
    set({ running: true, result: null, progress: { done: 0, total: get().steps.length, message: "Starting" } });
    const unlisten = await onRecipeProgress((progress) => set({ progress })).catch(() => null);
    try {
      set({ result: await runRecipe(get().toRecipe(), folder, dryRun) });
    } catch (err) {
      uiLog("error", `Recipe failed: ${err}`);
    } finally {
      unlisten?.();
      set({ running: false, progress: null });
    }
  },
}));

/** The command line equivalent of the current run settings. */
export function cliCommand(recipeFile: string | null, folder: string | null, dryRun: boolean): string {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return ["project-p.exe", "--recipe", q(recipeFile ?? "recipe.json"), q(folder ?? "D:\\Assets"), ...(dryRun ? ["--dry-run"] : []), "--report", "report.json"].join(" ");
}

registerDropHandler("recipes", async (paths) => {
  useAppStore.getState().setActiveTab("recipes");
  const { folders, files } = await classifyPaths(paths);
  const s = useRecipeStore.getState();
  if (folders.length) s.setFolder(folders[0]);
  const json = files.find((f) => /\.json$/i.test(f));
  if (json) await s.open(json);
});
