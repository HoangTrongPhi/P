import { inTauri, scanFbxFiles } from "../../lib/ipc";
import { basename } from "../../lib/pathUtil";
import { uiLog } from "../../stores/appStore";
import type { TextureMap } from "./modelEngine";

/**
 * Where an FBX's textures really are. FBXLoader only looks next to the model, so ask the Rust
 * doctor, which (like FBX Doctor's default) also searches the parent folder (`FBX/` + `Textures/`).
 */
export async function fbxTextureMap(path: string): Promise<TextureMap | undefined> {
  if (!path.toLowerCase().endsWith(".fbx") || !inTauri) return undefined;
  try {
    const [info] = await scanFbxFiles([path]);
    const map: TextureMap = new Map();
    for (const e of info?.entries ?? []) {
      if (e.resolvedPath) map.set(basename(e.originalPath).toLowerCase(), e.resolvedPath);
    }
    return map;
  } catch (err) {
    uiLog("warn", `Texture lookup failed for ${path}: ${err}`);
    return undefined;
  }
}
