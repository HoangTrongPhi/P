import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore, uiLog } from "../stores/appStore";
import { refreshAssetCount } from "./assets";
import { inTauri } from "./ipc";

/** Native folder / file pickers. Picked paths go to the same place as dropped paths. */
export async function pickPaths(kind: "folder" | "files"): Promise<string[]> {
  if (!inTauri) {
    uiLog("warn", "Native dialogs are only available inside the Tauri app.");
    return [];
  }
  const result = await open(kind === "folder" ? { directory: true } : { multiple: true });
  const paths = result == null ? [] : Array.isArray(result) ? result : [result];
  if (paths.length) {
    useAppStore.getState().setDroppedPaths(paths);
    uiLog("info", `Selected ${paths.length === 1 ? paths[0] : `${paths.length} items`}`);
    void refreshAssetCount(paths);
  }
  return paths;
}
