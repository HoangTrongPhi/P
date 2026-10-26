import { Command, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { MODULES } from "../../lib/modules";
import { useAppStore } from "../../stores/appStore";

function RailButton({ active, label, shortcut, onClick, children }: {
  active?: boolean;
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative grid size-10 place-items-center rounded-lg transition-colors",
        active ? "bg-accent/14 text-accent" : "text-ink-faint hover:bg-white/5 hover:text-ink",
      )}
    >
      {active && <span className="absolute -left-2.5 h-5 w-[3px] rounded-r-full bg-accent" />}
      {children}
      {/* Tooltip */}
      <span className="pointer-events-none absolute left-full z-50 ml-3 flex items-center gap-2 rounded-md border border-edge bg-panel-raised px-2 py-1 text-[12px] whitespace-nowrap text-ink opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-hover:delay-300">
        {label}
        {shortcut && <kbd>{shortcut}</kbd>}
      </span>
    </button>
  );
}

export function NavigationRail() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const logOpen = useAppStore((s) => s.logDrawerOpen);
  const toggleLog = useAppStore((s) => s.toggleLogDrawer);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-edge bg-panel py-3">
      <img src="/app-icon.svg" alt="Project P" className="mb-3 size-8" draggable={false} />
      {MODULES.map((m) => (
        <RailButton key={m.id} label={m.label} shortcut={`Ctrl+${m.hotkey}`} active={activeTab === m.id} onClick={() => setActiveTab(m.id)}>
          <m.icon className="size-[18px]" strokeWidth={1.75} />
        </RailButton>
      ))}
      <div className="flex-1" />
      <RailButton label="Command palette" shortcut="Ctrl+K" onClick={() => setPaletteOpen(true)}>
        <Command className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
      <RailButton label={logOpen ? "Hide log" : "Show log"} shortcut="Ctrl+`" active={logOpen} onClick={() => toggleLog()}>
        <Terminal className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
    </nav>
  );
}
