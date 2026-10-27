import { stat } from "@tauri-apps/plugin-fs";

/** Split dropped paths into folders and files. */
export async function classifyPaths(paths: string[]): Promise<{ folders: string[]; files: string[] }> {
  const infos = await Promise.all(paths.map((p) => stat(p).then((s) => s.isDirectory).catch(() => false)));
  return {
    folders: paths.filter((_, i) => infos[i]),
    files: paths.filter((_, i) => !infos[i]),
  };
}
