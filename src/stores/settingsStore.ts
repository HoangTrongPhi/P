import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { inTauri } from "../lib/ipc";

/**
 * Appearance preferences: colour theme, UI / code fonts and UI scale. Kept in the webview's
 * localStorage and applied to `<html>` (`data-theme`, `--font-sans`, `--font-mono`) before the
 * first render, so the app opens in the chosen look without a flash.
 */
export type ThemeMode = "dark" | "light" | "system";

export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

/** Inter, Be Vietnam Pro and JetBrains Mono are bundled (full Vietnamese); the rest ship with Windows. */
export const UI_FONTS: FontOption[] = [
  { id: "segoe", label: "Segoe UI (Windows)", stack: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
  { id: "inter", label: "Inter", stack: '"Inter Variable", "Segoe UI", system-ui, sans-serif' },
  { id: "be-vietnam", label: "Be Vietnam Pro", stack: '"Be Vietnam Pro", "Segoe UI", system-ui, sans-serif' },
  { id: "bahnschrift", label: "Bahnschrift", stack: 'Bahnschrift, "Segoe UI", system-ui, sans-serif' },
  { id: "tahoma", label: "Tahoma", stack: 'Tahoma, "Segoe UI", system-ui, sans-serif' },
];

export const MONO_FONTS: FontOption[] = [
  { id: "cascadia", label: "Cascadia Mono (Windows)", stack: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono Variable", Consolas, monospace' },
  { id: "consolas", label: "Consolas", stack: "Consolas, monospace" },
];

export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;

interface SettingsState {
  theme: ThemeMode;
  uiFont: string;
  monoFont: string;
  uiScale: number;
  setTheme: (theme: ThemeMode) => void;
  setUiFont: (id: string) => void;
  setMonoFont: (id: string) => void;
  setUiScale: (scale: number) => void;
  reset: () => void;
}

const DEFAULTS = { theme: "dark" as ThemeMode, uiFont: "segoe", monoFont: "cascadia", uiScale: 1 };

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setTheme: (theme) => set({ theme }),
      setUiFont: (uiFont) => set({ uiFont }),
      setMonoFont: (monoFont) => set({ monoFont }),
      setUiScale: (uiScale) => set({ uiScale }),
      reset: () => set(DEFAULTS),
    }),
    { name: "poseidon.settings", version: 1 },
  ),
);

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme actually shown: `system` follows Windows' app mode. */
export function resolvedTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? (systemDark.matches ? "dark" : "light") : mode;
}

function apply(s: Pick<SettingsState, "theme" | "uiFont" | "monoFont" | "uiScale">) {
  const root = document.documentElement;
  const theme = resolvedTheme(s.theme);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.setProperty("--font-sans", (UI_FONTS.find((f) => f.id === s.uiFont) ?? UI_FONTS[0]).stack);
  root.style.setProperty("--font-mono", (MONO_FONTS.find((f) => f.id === s.monoFont) ?? MONO_FONTS[0]).stack);
  if (inTauri) {
    // Title bar follows the theme (null = follow Windows); zoom scales the whole UI like Ctrl +/-.
    getCurrentWindow().setTheme(s.theme === "system" ? null : theme).catch(() => {});
    getCurrentWebview().setZoom(s.uiScale).catch(() => {});
  }
}

/** Apply the saved look now and whenever it (or the Windows theme, in `system` mode) changes. */
export function initAppearance() {
  apply(useSettingsStore.getState());
  useSettingsStore.subscribe(apply);
  systemDark.addEventListener("change", () => useSettingsStore.getState().theme === "system" && apply(useSettingsStore.getState()));
}

/** Command palette: flip between light and dark (leaves `system`). */
export function toggleTheme() {
  const { theme, setTheme } = useSettingsStore.getState();
  setTheme(resolvedTheme(theme) === "dark" ? "light" : "dark");
}
