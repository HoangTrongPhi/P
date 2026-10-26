import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  BlenderInstall,
  BlenderPackConfig,
  BlenderPackReport,
  BlenderProgress,
  FbxFileInfo,
  FbxFixPlan,
  FbxFixResult,
  LogEntry,
  RenameAction,
  RenameConfig,
  RenameResult,
  RenameRow,
  ScanSummary,
  TransactionSummary,
  UndoResult,
} from "../types/pipeline";

/** Event names emitted by the Rust backend. Keep in sync with `logbus.rs` / `blender_cmd.rs`. */
export const EVENTS = {
  log: "log://entry",
  blenderProgress: "blender://progress",
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

export function scanFbxFiles(paths: string[], searchDirs?: string[]): Promise<FbxFileInfo[]> {
  return invoke<FbxFileInfo[]>("scan_fbx_files", { paths, searchDirs });
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
