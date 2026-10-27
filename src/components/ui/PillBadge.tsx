import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type PillTone = "neutral" | "accent" | "amber" | "emerald" | "rose";

const TONES: Record<PillTone, string> = {
  neutral: "bg-tint/5 text-ink-muted ring-edge",
  accent: "bg-accent/12 text-accent ring-accent/25",
  amber: "bg-amber/12 text-amber ring-amber/25",
  emerald: "bg-emerald/12 text-emerald ring-emerald/25",
  rose: "bg-rose/12 text-rose ring-rose/25",
};

export function PillBadge({ tone = "neutral", children, className }: { tone?: PillTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium tabular-nums ring-1 ring-inset whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
