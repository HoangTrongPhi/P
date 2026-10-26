import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { refreshAssetCount } from "../lib/assets";
import { routeDrop } from "../lib/dropRouter";
import { inTauri } from "../lib/ipc";
import { uiLog, useAppStore } from "../stores/appStore";
import type { TabId } from "../types/pipeline";

const PREVIEWABLE = /\.(fbx|obj|gltf|glb|png|jpe?g|tga|dds|exr|hdr|webp|psd)$/i;

/** Mirrors the prototype's routing: stay on the current tab unless a single file belongs elsewhere. */
function tabForDrop(paths: string[], current: TabId): TabId {
  if (paths.length !== 1) return current;
  const p = paths[0].toLowerCase();
  if (p.endsWith(".blend")) return "blender";
  if (!PREVIEWABLE.test(p)) return current;
  if (current === "renamer" || current === "tools" || (current === "fbx" && !p.endsWith(".fbx"))) return "preview";
  return current;
}

function handleDrop(paths: string[]) {
  const s = useAppStore.getState();
  s.setDragActive(false);
  if (!paths.length) return;
  s.setDroppedPaths(paths);
  const tab = tabForDrop(paths, s.activeTab);
  s.setActiveTab(tab);
  uiLog("info", `Dropped ${paths.length === 1 ? paths[0] : `${paths.length} items`}`);
  if (inTauri) routeDrop(tab, paths);
  void refreshAssetCount(paths);
}

/** Window-wide drag & drop. Tauri reports real filesystem paths; a plain browser only gives names. */
export function useWindowDragDrop() {
  useEffect(() => {
    const setActive = useAppStore.getState().setDragActive;

    if (inTauri) {
      const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") setActive(true);
        else if (payload.type === "leave") setActive(false);
        else if (payload.type === "drop") handleDrop(payload.paths);
      });
      return () => void unlisten.then((fn) => fn());
    }

    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => hasFiles(e) && ++depth === 1 && setActive(true);
    const onLeave = (e: DragEvent) => hasFiles(e) && --depth === 0 && setActive(false);
    const onOver = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      handleDrop(Array.from(e.dataTransfer!.files, (f) => f.name));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}
