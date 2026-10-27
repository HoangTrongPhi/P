import { uiLog, useAppStore } from "../stores/appStore";
import { inTauri, scanDirectory } from "./ipc";

/** Count the assets under newly loaded paths for the header dashboard. */
export async function refreshAssetCount(paths: string[]) {
  if (!inTauri || !paths.length) return;
  try {
    const summaries = await Promise.all(paths.map((p) => scanDirectory(p, true)));
    useAppStore.getState().setCounters({ assetCount: summaries.reduce((n, s) => n + s.files.length, 0) });
  } catch (err) {
    uiLog("error", `Asset scan failed: ${err}`);
  }
}
