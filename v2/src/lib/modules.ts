import { ListChecks, Package, ScanEye, Stethoscope, TextCursorInput, Wrench, type LucideIcon } from "lucide-react";
import type { TabId } from "../types/pipeline";

export interface ModuleDef {
  id: TabId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Ctrl+<digit> shortcut. */
  hotkey: string;
}

/** The toolkit modules, in navigation order. */
export const MODULES: ModuleDef[] = [
  { id: "renamer", label: "Batch Renamer", description: "Regex & UE5/Unity naming presets with undo", icon: TextCursorInput, hotkey: "1" },
  { id: "fbx", label: "FBX Doctor", description: "Find and fix absolute texture paths in FBX", icon: Stethoscope, hotkey: "2" },
  { id: "blender", label: "Blender Packer", description: "Headless Blender 5 texture consolidation", icon: Package, hotkey: "3" },
  { id: "preview", label: "Asset Previewer", description: "3D viewport and texture / HDR inspector", icon: ScanEye, hotkey: "4" },
  { id: "tools", label: "Pipeline Tools", description: "ORM packer, converter, texture sets, meshes, duplicates, unused textures", icon: Wrench, hotkey: "5" },
  { id: "recipes", label: "Recipes", description: "Chain tools into one repeatable run (also from the command line)", icon: ListChecks, hotkey: "6" },
];

export const moduleById = (id: TabId) => MODULES.find((m) => m.id === id)!;
