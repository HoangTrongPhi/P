import { ModulePlaceholder } from "./ModulePlaceholder";

const FEATURES = [
  "Locate Blender 5.x via BLENDER_PATH, registry or Program Files",
  "Headless run of headless_pack.py",
  "Live PP_PROGRESS events streamed to a progress bar",
  "Pack textures, remap relative paths, report missing files",
];

export function BlenderTab() {
  return <ModulePlaceholder id="blender" phase={2} dropHint="A .blend file to consolidate" features={FEATURES} />;
}
