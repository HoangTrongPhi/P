// IPC contracts shared with the Rust backend (ARCHITECTURE_V2_TAURI_RUST.md §5.2).
// Rust structs serialize with `#[serde(rename_all = "camelCase")]` to match these names.

export type TabId = "renamer" | "fbx" | "blender" | "preview" | "tools" | "recipes" | "dashboard" | "matcher";

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
  /** Extra folders searched by file name (up to 4 levels deep). */
  searchDirs?: string[];
  /** Also search the FBX folder's parent and its direct subfolders (default true). */
  searchParent?: boolean;
  /** Rewrite unfound textures to `<subfolder>/<name>` instead of leaving them (default false). */
  guessMissing?: boolean;
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

// ---------------------------------------------------------------- previewer & tools

/** ORM channel layout: R = AO, G = Roughness, B = Metallic (Unreal convention). */
export interface OrmPackConfig {
  roughnessPath?: string | null;
  metallicPath?: string | null;
  aoPath?: string | null;
  outputPath: string;
  format: "png" | "tga";
  /** The roughness input is a gloss / smoothness map and gets inverted. */
  roughnessFromGloss?: boolean;
}

export interface DuplicateGroup {
  /** XXH3-128, hex. */
  hash: string;
  size: number;
  files: string[];
}

export interface DuplicateReport {
  /** Largest waste first. */
  groups: DuplicateGroup[];
  wastedBytes: number;
  scannedFiles: number;
  hashedFiles: number;
  elapsedMs: number;
  errors: string[];
}

export interface UnusedReport {
  textures: AssetFile[];
  reclaimableBytes: number;
  totalTextures: number;
  /** FBX / MTL / glTF / GLB files that were read. */
  referenceFiles: number;
  /** `.blend` files under the folder. */
  blendFiles: number;
  /** `.blend` files read through Blender (`includeBlend`). */
  blendInspected: number;
  warnings: string[];
}

// ---------------------------------------------------------------- texture sets

export type MapKind = "baseColor" | "normal" | "orm" | "roughness" | "gloss" | "metallic" | "ao" | "emissive" | "height" | "opacity" | "specular";

export interface TextureSet {
  dir: string;
  /** Base name shared by the maps, e.g. `wood_planks`. */
  name: string;
  maps: Partial<Record<MapKind, string>>;
  /** More files of a map type the set already has. */
  extra: string[];
  /** Of base color, normal and ORM-or-roughness. */
  missing: MapKind[];
  /** Has roughness / gloss / metallic / AO maps but no ORM yet. */
  canPackOrm: boolean;
  /** `<dir>/T_<Name>_ORM.png`. */
  suggestedOrm: string;
}

export interface TextureSetReport {
  sets: TextureSet[];
  totalTextures: number;
  /** Textures without a recognisable map suffix. */
  unmatched: string[];
}

export interface OrmBatchItem {
  outputPath: string;
  ok: boolean;
  error: string | null;
}

// ---------------------------------------------------------------- texture converter

export type ConvertFormat = "keep" | "png" | "tga" | "jpg" | "dds";

export interface ConvertOptions {
  /** Longest side limit; never upscales. */
  maxSize?: number | null;
  powerOfTwo?: boolean;
  format?: ConvertFormat;
  /** Invert green: DirectX <-> OpenGL normal maps. */
  flipGreen?: boolean;
  jpegQuality?: number;
  ddsMipmaps?: boolean;
  /** Absolute, or relative to each source folder. Default `converted`. */
  outputDir?: string;
  /** Appended to the output stem, e.g. `_GL`. */
  suffix?: string;
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface ConvertItem {
  source: string;
  output: string | null;
  fromSize: [number, number] | null;
  toSize: [number, number] | null;
  bytesBefore: number;
  bytesAfter: number | null;
  written: boolean;
  skipped: string | null;
  error: string | null;
}

// ---------------------------------------------------------------- mesh inspector

export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface MeshStats {
  path: string;
  format: "fbx-binary" | "fbx-ascii" | "obj" | "gltf" | "glb" | string;
  meshes: number;
  vertices: number;
  triangles: number;
  polygons: number;
  materials: number;
  /** Material (slot) names in file order. */
  materialNames: string[];
  uvSets: number;
  hasNormals: boolean;
  /** Local space (node transforms not applied). */
  bounds: MeshBounds | null;
  /** Centimetres per file unit. */
  unitScaleCm: number | null;
  upAxis: string | null;
  warnings: string[];
  error: string | null;
}

// ---------------------------------------------------------------- asset matcher

/** exact: the mesh file references the set; likely: clear winner by name; review: close call; none: no candidate. */
export type MatchStatus = "exact" | "likely" | "review" | "none";

export interface MatchCandidate {
  /** Index into `MatchReport.sets`. */
  set: number;
  /** 0-100. */
  score: number;
  reasons: string[];
}

export interface SlotMatch {
  /** Material name, or the mesh name when the file has no materials. */
  name: string;
  isMaterial: boolean;
  /** Best first. */
  candidates: MatchCandidate[];
  status: MatchStatus;
}

export interface MeshMatch {
  path: string;
  /** Texture file names the mesh references (lower case). */
  references: string[];
  /** Referenced names with no texture under the folder. */
  missingReferences: string[];
  slots: SlotMatch[];
  error: string | null;
}

export interface MatchReport {
  root: string;
  meshes: MeshMatch[];
  sets: TextureSet[];
  /** Sets no slot picked as its best match. */
  orphanSets: number[];
  /** Textures without a recognisable map suffix. */
  looseTextures: string[];
  elapsedMs: number;
}

// ---------------------------------------------------------------- recipes

export type RecipeStep =
  | { kind: "rename"; rules: RenameRuleSpec[]; extensions?: string[]; recursive?: boolean }
  | { kind: "fbxFix"; options?: Omit<FbxFixPlan, "paths"> }
  | { kind: "packOrm"; format?: "png" | "tga"; overwrite?: boolean }
  | { kind: "convertTextures"; options?: ConvertOptions; extensions?: string[]; nameContains?: string }
  | { kind: "inspectMeshes"; triBudget?: number | null }
  | { kind: "findUnused"; includeBlend?: boolean }
  | { kind: "findDuplicates" };

export type RecipeStepKind = RecipeStep["kind"];

export interface Recipe {
  name: string;
  description?: string;
  steps: RecipeStep[];
}

export interface StepOutcome {
  kind: RecipeStepKind;
  title: string;
  ok: boolean;
  /** Not run because an earlier step failed. */
  skipped: boolean;
  summary: string;
  details: string[];
  elapsedMs: number;
}

export interface RecipeRun {
  name: string;
  folder: string;
  dryRun: boolean;
  ok: boolean;
  steps: StepOutcome[];
  elapsedMs: number;
}

export interface RecipeProgress {
  done: number;
  total: number;
  message: string;
}
