import { Monitor, Moon, RotateCcw, Settings2, Sun, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../stores/appStore";
import { MONO_FONTS, UI_FONTS, UI_SCALES, useSettingsStore, type FontOption, type ThemeMode } from "../../stores/settingsStore";
import { FieldLabel, Segmented } from "../ui/Controls";

const THEMES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
  { id: "system", label: "System", icon: Monitor },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <FieldLabel>{title}</FieldLabel>
      {children}
    </div>
  );
}

/** One row per font, each previewed in its own face (with Vietnamese, to show coverage). */
function FontList({ fonts, value, onChange, mono }: { fonts: FontOption[]; value: string; onChange: (id: string) => void; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1" role="radiogroup">
      {fonts.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={value === f.id}
          onClick={() => onChange(f.id)}
          className={cn(
            "flex items-baseline gap-3 rounded-lg border px-3 py-1.5 text-left transition-colors",
            value === f.id ? "border-accent/60 bg-accent/10" : "border-edge bg-panel-raised/50 hover:border-edge-strong",
          )}
        >
          <span className="w-44 shrink-0 text-[12px] text-ink-muted">{f.label}</span>
          <span className="truncate text-[13px] text-ink" style={{ fontFamily: f.stack }}>
            {mono ? "SM_Crate_01.fbx → T_Crate_D.png" : "Poseidon — Tiếng Việt có dấu"}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Appearance: theme, UI font, code font, UI scale. Changes apply at once and are remembered. */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const { theme, uiFont, monoFont, uiScale, setTheme, setUiFont, setMonoFont, setUiScale, reset } = useSettingsStore();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/60 p-4 backdrop-blur-[2px]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-full w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <Settings2 className="size-4 text-accent" />
          <h2 id="settings-title" className="flex-1 text-[14px] font-semibold text-ink">
            Appearance
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
          <Section title="Theme">
            <div className="grid grid-cols-3 gap-2" role="radiogroup">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.id}
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    "flex h-9 items-center justify-center gap-2 rounded-lg border text-[12.5px] transition-colors",
                    theme === t.id ? "border-accent/60 bg-accent/10 text-accent" : "border-edge bg-panel-raised/50 text-ink-muted hover:border-edge-strong hover:text-ink",
                  )}
                >
                  <t.icon className="size-4" /> {t.label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Interface font">
            <FontList fonts={UI_FONTS} value={uiFont} onChange={setUiFont} />
          </Section>

          <Section title="Code & path font">
            <FontList fonts={MONO_FONTS} value={monoFont} onChange={setMonoFont} mono />
          </Section>

          <Section title="Interface size">
            <Segmented
              value={String(uiScale)}
              options={UI_SCALES.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }))}
              onChange={(v) => setUiScale(Number(v))}
            />
          </Section>
        </div>

        <div className="flex justify-between gap-2 border-t border-edge px-4 py-3">
          <button type="button" className="btn h-8" onClick={reset}>
            <RotateCcw className="size-3.5" /> Reset
          </button>
          <button type="button" className="btn btn-primary h-8" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
