import { FolderOpen, Files, PackageCheck, PanelBottom, RefreshCw, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { useKitStore } from "../stores/kitStore";
import { useUpdateStore } from "../stores/updateStore";
import { pickPaths } from "./dialogs";
import { MODULES } from "./modules";

export interface PaletteCommand {
  id: string;
  title: string;
  group: "Navigate" | "Actions" | "View";
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string;
  run: () => void | Promise<unknown>;
}

/** Everything reachable from the command palette. Later phases append module actions here. */
export function buildCommands(): PaletteCommand[] {
  const s = useAppStore.getState();
  return [
    ...MODULES.map<PaletteCommand>((m) => ({
      id: `nav.${m.id}`,
      title: `Go to ${m.label}`,
      group: "Navigate",
      icon: m.icon,
      shortcut: `Ctrl+${m.hotkey}`,
      keywords: m.description,
      run: () => s.setActiveTab(m.id),
    })),
    { id: "act.openFolder", title: "Open folder…", group: "Actions", icon: FolderOpen, keywords: "browse directory scan", run: () => pickPaths("folder") },
    { id: "act.openFiles", title: "Open files…", group: "Actions", icon: Files, keywords: "browse assets fbx texture", run: () => pickPaths("files") },
    { id: "view.toggleLog", title: "Toggle log drawer", group: "View", icon: PanelBottom, shortcut: "Ctrl+`", keywords: "console terminal output", run: () => s.toggleLogDrawer() },
    { id: "kit.fromManifest", title: "Assemble kit from manifest…", group: "Actions", icon: PackageCheck, keywords: "asset manifest collect copy project ue5 unity", run: () => void useKitStore.getState().openManifestFile() },
    { id: "view.about", title: "About & contact", group: "View", icon: UserRound, keywords: "author email contact info help version", run: () => s.setAboutOpen(true) },
    { id: "app.checkUpdates", title: "Check for updates…", group: "Actions", icon: RefreshCw, keywords: "update upgrade new version release download install", run: () => void useUpdateStore.getState().checkForUpdates() },
    { id: "view.clearLog", title: "Clear log", group: "View", icon: Trash2, keywords: "console reset", run: () => s.clearLogs() },
  ];
}

/** Subsequence fuzzy score; higher is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}
