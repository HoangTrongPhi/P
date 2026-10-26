import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Translucent toolbar / panel floating over a viewport. */
export function FloatingPanel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("absolute z-10 rounded-lg border border-edge-strong bg-panel/85 shadow-lg backdrop-blur", className)}>{children}</div>;
}

export function HudButton({ active, onClick, title, children }: { active?: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn("grid size-7 place-items-center rounded-md transition-colors", active ? "bg-accent/18 text-accent" : "text-ink-muted hover:bg-white/8 hover:text-ink")}
    >
      {children}
    </button>
  );
}

export function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-[11.5px]">
      <span className="text-ink-faint">{label}</span>
      <span className="font-mono text-ink tabular-nums">{value}</span>
    </div>
  );
}
