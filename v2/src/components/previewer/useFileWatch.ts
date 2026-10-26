import { stat } from "@tauri-apps/plugin-fs";
import { useEffect, useRef } from "react";
import { inTauri } from "../../lib/ipc";

export type FileStamp = { size: number; modifiedMs: number };

const POLL_MS = 1000;
const sig = (s: FileStamp | null | undefined) => (s ? `${s.size}|${s.modifiedMs}` : "");

async function readStamps(paths: string[]): Promise<Map<string, FileStamp | null>> {
  const stamps = await Promise.all(
    paths.map((p) =>
      stat(p)
        .then((s): FileStamp => ({ size: s.size, modifiedMs: s.mtime?.getTime() ?? 0 }))
        .catch(() => null),
    ),
  );
  return new Map(paths.map((p, i) => [p, stamps[i]]));
}

/**
 * Poll `paths` and call `onChange` once a changed file has stopped changing (same size and
 * time on two polls in a row), so an export still being written is not loaded half-way.
 * A file that is briefly missing (saved via a temp file and rename) is not a change.
 */
export function useFileWatch(paths: string[], onChange: (changed: string[], stamps: Map<string, FileStamp>) => void, enabled = true) {
  const callback = useRef(onChange);
  callback.current = onChange;
  const key = paths.join("\n");

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (!enabled || !inTauri || !list.length) return;
    let stopped = false;
    let timer = 0;
    let base: Map<string, FileStamp | null> | null = null;
    let candidate: Map<string, FileStamp | null> | null = null;

    const poll = async () => {
      const now = await readStamps(list);
      if (stopped) return;
      if (!base) base = now;
      else {
        const changed = list.filter((p) => now.get(p) && sig(now.get(p)) !== sig(base!.get(p)));
        if (!changed.length) candidate = null;
        else if (candidate && changed.every((p) => sig(candidate!.get(p)) === sig(now.get(p)))) {
          for (const p of changed) base.set(p, now.get(p)!);
          candidate = null;
          callback.current(changed, new Map(changed.map((p) => [p, now.get(p)!])));
        } else candidate = now;
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, enabled]);
}
