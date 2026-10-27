import { useEffect } from "react";
import { MODULES } from "../lib/modules";
import { useAppStore } from "../stores/appStore";

/** Ctrl+K / Ctrl+P palette, Ctrl+` log drawer, Ctrl+, appearance, Ctrl+1…8 module switch. */
export function useGlobalHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const s = useAppStore.getState();
      const key = e.key.toLowerCase();
      if (key === "k" || key === "p") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (key === ",") {
        e.preventDefault();
        s.setSettingsOpen(!s.settingsOpen);
      } else if (e.code === "Backquote") {
        e.preventDefault();
        s.toggleLogDrawer();
      } else {
        const mod = MODULES.find((m) => m.hotkey === e.key);
        if (mod) {
          e.preventDefault();
          s.setPaletteOpen(false);
          s.setActiveTab(mod.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
