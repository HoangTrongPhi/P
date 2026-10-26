import { ModulePlaceholder } from "./ModulePlaceholder";

const FEATURES = [
  "Binary FBX 7.x parser (32-bit and 7.5+ 64-bit offsets)",
  "ASCII FBX parser preserving formatting",
  "Classify ABSOLUTE_LOCAL, UNC_NETWORK, RELATIVE_PORTABLE, EMPTY",
  "Fix: convert to relative, strip to basename",
  "Fix: collect textures into textures/ and relink",
  "Byte-identical round trip, .fbx.bak before every rewrite",
];

export function FbxDoctorTab() {
  return <ModulePlaceholder id="fbx" phase={2} dropHint="FBX files or folders containing them" features={FEATURES} />;
}
