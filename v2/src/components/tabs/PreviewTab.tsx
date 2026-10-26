import { ModulePlaceholder } from "./ModulePlaceholder";

const FEATURES = [
  "Three.js viewport: FBX, OBJ, glTF / GLB via asset://",
  "Orbit, wireframe, UV checker, reset camera",
  "Poly / vertex counts and bounding-box size",
  "Texture inspector with GPU pan and zoom",
  "Exposure and gamma for HDR / EXR",
  "Channel isolation: RGBA, RGB, A, R, G, B",
];

export function PreviewTab() {
  return <ModulePlaceholder id="preview" phase={3} dropHint="Any mesh, texture, HDR or PSD file" features={FEATURES} />;
}
