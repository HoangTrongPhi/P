import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { inTauri } from "../lib/ipc";
import { uiLog } from "./appStore";

/**
 * Check for updates against the `latest.json` of the newest GitHub release
 * (`plugins.updater` in `tauri.conf.json`). The installer is verified with the
 * signing public key before it runs; see `docs/RELEASING.md`.
 */
export type UpdatePhase = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

/** Silent check this long after startup, so it never competes with the first scan. */
const STARTUP_DELAY_MS = 4000;

interface UpdateState {
  phase: UpdatePhase;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Version, date and release notes of the update on offer. */
  available: { version: string; date?: string; notes?: string } | null;
  downloaded: number;
  total: number;
  error: string | null;
  /** `silent`: only open the dialog when an update exists (startup check). */
  checkForUpdates: (opts?: { silent?: boolean }) => Promise<void>;
  installAndRestart: () => Promise<void>;
}

let pending: Update | null = null;

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  phase: "idle",
  dialogOpen: false,
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  available: null,
  downloaded: 0,
  total: 0,
  error: null,

  async checkForUpdates({ silent = false } = {}) {
    if (!silent) set({ dialogOpen: true });
    if (!inTauri) {
      set({ phase: "error", error: "Updates are only available in the desktop app." });
      return;
    }
    const busy = get().phase;
    if (busy === "checking" || busy === "downloading" || busy === "installing") return;
    set({ phase: "checking", error: null });
    try {
      const update = await check();
      pending = update;
      if (!update) {
        set({ phase: "upToDate", available: null });
        if (!silent) uiLog("info", "Poseidon is up to date", "updater");
        return;
      }
      set({ phase: "available", available: { version: update.version, date: update.date, notes: update.body } });
      uiLog("info", `Update available: v${update.version}`, "updater");
      if (silent) set({ dialogOpen: true });
    } catch (e) {
      // Offline or no release published yet: stay quiet at startup, explain when asked.
      set({ phase: silent ? "idle" : "error", error: String(e) });
      uiLog(silent ? "debug" : "warn", `Update check failed: ${e}`, "updater");
    }
  },

  async installAndRestart() {
    if (!pending) return;
    set({ phase: "downloading", downloaded: 0, total: 0, error: null });
    try {
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") set({ total: event.data.contentLength ?? 0 });
        else if (event.event === "Progress") set((s) => ({ downloaded: s.downloaded + event.data.chunkLength }));
        else if (event.event === "Finished") set({ phase: "installing" });
      });
      uiLog("info", `Installed v${pending.version}, restarting`, "updater");
      // On Windows the installer usually closes the app itself; relaunch covers the rest.
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
      uiLog("error", `Update failed: ${e}`, "updater");
    }
  },
}));

/** Once per launch, in release builds only (dev builds would offer to replace themselves). */
export function scheduleStartupUpdateCheck(debug: boolean) {
  if (!inTauri || debug) return;
  setTimeout(() => void useUpdateStore.getState().checkForUpdates({ silent: true }), STARTUP_DELAY_MS);
}
