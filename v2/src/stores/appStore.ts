import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { AppInfo, LogEntry, LogLevel, TabId } from "../types/pipeline";

const MAX_LOG_LINES = 5000;

interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  /** About / contact dialog. */
  aboutOpen: boolean;
  setAboutOpen: (open: boolean) => void;

  logDrawerOpen: boolean;
  toggleLogDrawer: (open?: boolean) => void;
  logDrawerHeight: number;
  setLogDrawerHeight: (px: number) => void;

  logs: LogEntry[];
  addLogs: (entries: LogEntry[]) => void;
  clearLogs: () => void;

  appInfo: AppInfo | null;
  setAppInfo: (info: AppInfo) => void;

  /** Header dashboard counters; filled by the scanner and FBX doctor in later phases. */
  assetCount: number;
  brokenPathCount: number;
  setCounters: (c: { assetCount?: number; brokenPathCount?: number }) => void;

  /** Paths most recently dropped onto the window or picked from a dialog. */
  droppedPaths: string[];
  setDroppedPaths: (paths: string[]) => void;
  /** A drag carrying files is hovering the window. */
  dragActive: boolean;
  setDragActive: (active: boolean) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  activeTab: "renamer",
  setActiveTab: (activeTab) => set({ activeTab }),

  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  aboutOpen: false,
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),

  logDrawerOpen: true,
  toggleLogDrawer: (open) => set((s) => ({ logDrawerOpen: open ?? !s.logDrawerOpen })),
  logDrawerHeight: 180,
  setLogDrawerHeight: (px) => set({ logDrawerHeight: Math.round(Math.min(Math.max(px, 96), 600)) }),

  logs: [],
  addLogs: (entries) =>
    set((s) => {
      const logs = s.logs.concat(entries);
      return { logs: logs.length > MAX_LOG_LINES ? logs.slice(-MAX_LOG_LINES) : logs };
    }),
  clearLogs: () => set({ logs: [] }),

  appInfo: null,
  setAppInfo: (appInfo) => set({ appInfo }),

  assetCount: 0,
  brokenPathCount: 0,
  setCounters: (c) => set(c),

  droppedPaths: [],
  setDroppedPaths: (droppedPaths) => set({ droppedPaths }),
  dragActive: false,
  setDragActive: (dragActive) => set({ dragActive }),
}));

/** Log from the UI side into the same drawer the backend writes to (and to the app's stderr). */
export function uiLog(level: LogLevel, message: string, source = "ui") {
  useAppStore.getState().addLogs([{ tsMs: Date.now(), level, source, message }]);
  if (isTauri()) invoke("ui_log", { level, message }).catch(() => {});
}
