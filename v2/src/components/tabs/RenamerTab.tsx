import { ModulePlaceholder } from "./ModulePlaceholder";

const FEATURES = [
  "Parallel directory scan (walkdir + rayon)",
  "Unreal Engine 5 presets: SM_, SK_, T_*_D / _N / _R / _M / _ORM",
  "Unity presets: PascalCase + _Albedo, _Normal, _MaskMap",
  "Regex search & replace with $1 capture groups",
  "Prefix / suffix and snake, camel, Pascal, UPPER, kebab case",
  "Dry-run table with collision and invalid-name detection",
  "Two-phase swap-safe renames",
  "Undo stack persisted in .rename_history.json",
];

export function RenamerTab() {
  return <ModulePlaceholder id="renamer" phase={2} dropHint="Folders with meshes and textures to rename" features={FEATURES} />;
}
