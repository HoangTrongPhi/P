import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  AssetManifest,
  BlenderInstall,
  BlenderPackConfig,
  BlenderPackReport,
  BlenderProgress,
  ConvertItem,
  ConvertOptions,
  DriveMount,
  DuplicateReport,
  FbxFileInfo,
  FbxFixPlan,
  FbxFixResult,
  KitOptions,
  KitReport,
  LogEntry,
  MatchReport,
  MeshStats,
  OrmBatchItem,
  OrmPackConfig,
  Recipe,
  RecipeProgress,
  ReadEstimate,
  RecipeRun,
  RenameAction,
  RenameConfig,
  RenameResult,
  RenameRow,
  ScanSummary,
  TextureSetReport,
  TransactionSummary,
  UndoResult,
  UnusedReport,
} from "../types/pipeline";

/** Event names emitted by the Rust backend. Keep in sync with `logbus.rs` / `blender_cmd.rs`. */
export const EVENTS = {
  log: "log://entry",
  blenderProgress: "blender://progress",
  recipeProgress: "recipe://progress",
  kitProgress: "kit://progress",
  matcherProgress: "matcher://progress",
} as const;

/** True inside the Tauri webview; false when the UI runs in a plain browser via `npm run dev`. */
export const inTauri = isTauri();

export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** Log lines emitted before the UI attached its listener. */
export function getLogHistory(): Promise<LogEntry[]> {
  return invoke<LogEntry[]>("log_history");
}

export function onBackendLog(handler: (entry: LogEntry) => void): Promise<UnlistenFn> {
  return listen<LogEntry>(EVENTS.log, (e) => handler(e.payload));
}

// ---------------------------------------------------------------- scanner

export function scanDirectory(path: string, recursive = true, filters: string[] = []): Promise<ScanSummary> {
  return invoke<ScanSummary>("scan_directory", { path, recursive, filters });
}

// ---------------------------------------------------------------- renamer

export function dryRunRename(folder: string, rules: RenameConfig): Promise<RenameRow[]> {
  return invoke<RenameRow[]>("dry_run_rename", { folder, rules });
}

export function applyRename(folder: string, items: RenameAction[]): Promise<RenameResult> {
  return invoke<RenameResult>("apply_rename", { folder, items });
}

export function undoLastRename(folder: string): Promise<UndoResult> {
  return invoke<UndoResult>("undo_last_rename", { folder });
}

export function renameHistory(folder: string): Promise<TransactionSummary[]> {
  return invoke<TransactionSummary[]>("rename_history", { folder });
}

// ---------------------------------------------------------------- FBX doctor

/** `searchParent` (default true) also looks in each FBX folder's parent, e.g. `../Textures`. */
export function scanFbxFiles(paths: string[], searchDirs?: string[], searchParent = true): Promise<FbxFileInfo[]> {
  return invoke<FbxFileInfo[]>("scan_fbx_files", { paths, searchDirs, searchParent });
}

export function fixFbxPaths(plan: FbxFixPlan): Promise<FbxFixResult> {
  return invoke<FbxFixResult>("fix_fbx_paths", { plan });
}

export function restoreFbxBackup(path: string): Promise<boolean> {
  return invoke<boolean>("restore_fbx_backup", { path });
}

// ---------------------------------------------------------------- Blender

export function discoverBlender(): Promise<BlenderInstall[]> {
  return invoke<BlenderInstall[]>("discover_blender");
}

export function runBlenderPack(config: BlenderPackConfig): Promise<BlenderPackReport> {
  return invoke<BlenderPackReport>("run_blender_pack", { config });
}

export function cancelBlenderPack(): Promise<boolean> {
  return invoke<boolean>("cancel_blender_pack");
}

export function onBlenderProgress(handler: (p: BlenderProgress) => void): Promise<UnlistenFn> {
  return listen<BlenderProgress>(EVENTS.blenderProgress, (e) => handler(e.payload));
}

// ---------------------------------------------------------------- previewer & tools

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA8, rows top to bottom. */
  pixels: Uint8Array;
}

/** PSD / TIFF and other formats the webview cannot decode, via Rust. */
export async function decodeImage(path: string): Promise<DecodedImage> {
  const buf = await invoke<ArrayBuffer>("decode_image", { path });
  const view = new DataView(buf);
  return { width: view.getUint32(0, true), height: view.getUint32(4, true), pixels: new Uint8Array(buf, 8) };
}

/** Open an `https://` or `mailto:` link in the default browser / mail app. */
export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

export function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
}

export function packOrmTexture(config: OrmPackConfig): Promise<string> {
  return invoke<string>("pack_orm_texture", { config });
}

export function findDuplicateAssets(folder: string): Promise<DuplicateReport> {
  return invoke<DuplicateReport>("find_duplicate_assets", { folder });
}

/** `includeBlend` also reads `.blend` files through headless Blender (slow). */
export function findUnusedTextures(folder: string, includeBlend = false, blenderPath?: string | null): Promise<UnusedReport> {
  return invoke<UnusedReport>("find_unused_textures", { folder, includeBlend, blenderPath });
}

export function findTextureSets(folder: string): Promise<TextureSetReport> {
  return invoke<TextureSetReport>("find_texture_sets", { folder });
}

export function matchAssets(folder: string): Promise<MatchReport> {
  return invoke<MatchReport>("match_assets", { folder });
}

export function matcherEstimate(folder: string): Promise<ReadEstimate> {
  return invoke<ReadEstimate>("matcher_estimate", { folder });
}

export function cancelMatching(): Promise<void> {
  return invoke<void>("cancel_matching");
}

/** Returns how many cached mesh files were forgotten. */
export function clearMeshCache(): Promise<number> {
  return invoke<number>("clear_mesh_cache");
}

/** `message` is the mesh file just read. */
export function onMatcherProgress(handler: (p: RecipeProgress) => void): Promise<UnlistenFn> {
  return listen<RecipeProgress>(EVENTS.matcherProgress, (e) => handler(e.payload));
}

export function driveMounts(): Promise<DriveMount[]> {
  return invoke<DriveMount[]>("drive_mounts");
}

export function loadAssetManifest(path: string): Promise<AssetManifest> {
  return invoke<AssetManifest>("load_asset_manifest", { path });
}

export function assembleKit(manifest: AssetManifest, options: KitOptions): Promise<KitReport> {
  return invoke<KitReport>("assemble_kit", { manifest, options });
}

/** Same payload shape as recipe progress: `message` is the file being written. */
export function onKitProgress(handler: (p: RecipeProgress) => void): Promise<UnlistenFn> {
  return listen<RecipeProgress>(EVENTS.kitProgress, (e) => handler(e.payload));
}

export function packOrmBatch(configs: OrmPackConfig[]): Promise<OrmBatchItem[]> {
  return invoke<OrmBatchItem[]>("pack_orm_batch", { configs });
}

/** `paths` may contain folders (searched recursively for textures). */
export function convertTextures(paths: string[], options: ConvertOptions): Promise<ConvertItem[]> {
  return invoke<ConvertItem[]>("convert_textures", { paths, options });
}

/** `paths` may contain folders (searched recursively for FBX / OBJ / glTF / GLB). */
export function inspectMeshes(paths: string[], triBudget?: number | null): Promise<MeshStats[]> {
  return invoke<MeshStats[]>("inspect_meshes", { paths, triBudget });
}

// ---------------------------------------------------------------- reports & recipes

/** Write an exported report or recipe (.csv / .html / .json only). */
export function saveTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("save_text_file", { path, contents });
}

export function loadRecipe(path: string): Promise<Recipe> {
  return invoke<Recipe>("load_recipe", { path });
}

export function runRecipe(recipe: Recipe, folder: string, dryRun: boolean, blenderPath?: string | null): Promise<RecipeRun> {
  return invoke<RecipeRun>("run_recipe", { recipe, folder, dryRun, blenderPath });
}

export function onRecipeProgress(handler: (p: RecipeProgress) => void): Promise<UnlistenFn> {
  return listen<RecipeProgress>(EVENTS.recipeProgress, (e) => handler(e.payload));
}
