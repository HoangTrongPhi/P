// IPC contracts shared with the Rust backend (ARCHITECTURE_V2_TAURI_RUST.md §5.2).
// Rust structs serialize with `#[serde(rename_all = "camelCase")]` to match these names.

export type TabId = "renamer" | "fbx" | "blender" | "preview" | "tools";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Unix epoch milliseconds. */
  tsMs: number;
  level: LogLevel;
  /** Emitting subsystem, e.g. `app`, `scanner`, `fbx`, `blender`, `ui`. */
  source: string;
  message: string;
}

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
  debug: boolean;
}

// ---------------------------------------------------------------- scanner

export type AssetCategory = "mesh" | "scene" | "texture" | "source" | "other";

export interface AssetFile {
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
  category: AssetCategory;
}

export interface ScanSummary {
  root: string;
  files: AssetFile[];
  counts: Partial<Record<AssetCategory, number>>;
  totalSize: number;
  elapsedMs: number;
  errors: string[];
}

// ---------------------------------------------------------------- renamer

export type CaseStyle = "camel" | "snake" | "pascal" | "upper" | "lower" | "kebab";
export type NamingPreset = "ue5" | "unity";

/** Applied in order to each file stem; extensions are never touched. */
export type RenameRuleSpec =
  /** Regex mode uses `$1` / `${name}` replacement references. */
  | { kind: "searchReplace"; find: string; replace?: string; regex?: boolean; caseSensitive?: boolean }
  | { kind: "prefix"; prefix: string; skipIfPresent?: boolean }
  | { kind: "suffix"; suffix: string; skipIfPresent?: boolean }
  | { kind: "case"; style: CaseStyle }
  | { kind: "preset"; preset: NamingPreset };

export interface RenameConfig {
  rules: RenameRuleSpec[];
  recursive?: boolean;
  /** Extension filter; empty means every asset type. */
  extensions?: string[];
  /** Explicit file list; when set, the folder is not scanned. */
  paths?: string[];
}

export interface RenameRow {
  originalPath: string;
  originalName: string;
  newName: string;
  targetPath: string;
  status: "OK" | "Skipped" | "Collision" | "Invalid";
  reason?: string;
}

export interface RenameAction {
  originalPath: string;
  targetPath: string;
}

export interface RenameResult {
  transactionId: string | null;
  renamed: number;
  /** Actions refused by the final safety check. */
  rejected: RenameRow[];
}

export interface UndoResult {
  transactionId: string | null;
  restored: number;
}

export interface TransactionSummary {
  id: string;
  /** Unix seconds. */
  timestamp: number;
  count: number;
}

// ---------------------------------------------------------------- FBX doctor

export type FbxPathKind = "ABSOLUTE_LOCAL" | "UNC_NETWORK" | "RELATIVE_PORTABLE" | "EMPTY";
export type FbxResolution = "found" | "found_by_name" | "missing" | "embedded";

export interface FbxPathEntry {
  /** Owning object, e.g. `Video::wood`. */
  nodeName: string;
  /** `FileName`, `RelativeFilename`, `P:Path`, … */
  propertyName: string;
  originalPath: string;
  resolvedPath: string | null;
  kind: FbxPathKind;
  existsOnDisk: boolean;
  resolution: FbxResolution;
  embedded: boolean;
  isProblem: boolean;
}

export interface FbxFileInfo {
  path: string;
  version: number;
  isBinary: boolean;
  entries: FbxPathEntry[];
  hasIssues: boolean;
  problemCount: number;
  error?: string;
}

export type FbxFixMode = "relative" | "strip" | "collect";

export interface FbxFixPlan {
  /** FBX files or folders (searched recursively). */
  paths: string[];
  mode?: FbxFixMode;
  /** Relative mode: point every texture at this folder instead of its found location. */
  rebaseDir?: string | null;
  /** Collect mode target, relative to each FBX. Default `textures`. */
  subfolder?: string;
  /** Rewrite every non-empty reference, not only problematic ones. */
  fixAll?: boolean;
  /** Keep `<file>.fbx.bak` (default true). */
  backup?: boolean;
  dryRun?: boolean;
  searchDirs?: string[];
}

export interface FbxPathChange {
  field: string;
  owner: string;
  old: string;
  new: string;
}

export interface FbxFixReport {
  path: string;
  changes: FbxPathChange[];
  copied: { from: string; to: string }[];
  warnings: string[];
  backup: string | null;
  written: boolean;
  dryRun: boolean;
}

export interface FbxFixResult {
  reports: FbxFixReport[];
  errors: { path: string; error: string }[];
}

// ---------------------------------------------------------------- Blender

export interface BlenderInstall {
  executable: string;
  version: [number, number, number];
  versionString: string;
  supported: boolean;
}

export interface BlenderPackOptions {
  consolidate?: boolean;
  unpack?: boolean;
  makeRelative?: boolean;
  packAll?: boolean;
  /** Save as a new .blend instead of overwriting (Blender keeps a `.blend1`). */
  output?: string | null;
  analyseOnly?: boolean;
  zipArchive?: string | null;
}

export interface BlenderPackConfig {
  /** Defaults to the newest supported install. */
  blenderPath?: string | null;
  blendFile: string;
  options?: BlenderPackOptions;
}

export interface BlenderDependency {
  name: string;
  type: string;
  filepath: string;
  abspath: string;
  exists: boolean;
  packed: boolean;
  relative: boolean;
}

/** Report written by `dcc_scripts/blender/headless_pack.py`. */
export interface BlenderReport {
  ok: boolean;
  blend: string;
  blender_version: string;
  before?: BlenderDependency[];
  after?: BlenderDependency[];
  missing?: BlenderDependency[];
  steps?: string[];
  error?: string;
}

export interface BlenderPackReport {
  ok: boolean;
  report: BlenderReport | null;
  returncode: number | null;
  outputLines: string[];
  archive: string | null;
  cancelled: boolean;
  error: string | null;
}

export interface BlenderProgress {
  done: number;
  total: number;
  message: string;
}

// ---------------------------------------------------------------- tools (Phase 3)

export interface OrmPackConfig {
  roughnessPath?: string;
  metallicPath?: string;
  aoPath?: string;
  outputPath: string;
  format: "png" | "tga";
}
