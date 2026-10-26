import { ModulePlaceholder } from "./ModulePlaceholder";

const FEATURES = [
  "ORM channel packer (Roughness, Metallic, AO) via image-rs",
  "Duplicate asset finder with XXH3 hashing",
  "Unused texture detector with reclaimable disk space",
];

export function ToolsTab() {
  return <ModulePlaceholder id="tools" phase={3} dropHint="A project folder to analyse" features={FEATURES} />;
}
