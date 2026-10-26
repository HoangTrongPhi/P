import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

interface GlassCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
}

/** Raised panel surface with an optional title row. */
export function GlassCard({ title, actions, className, children, ...rest }: GlassCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-edge bg-panel/80 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur",
        className,
      )}
      {...rest}
    >
      {(title || actions) && (
        <div className="flex h-10 items-center justify-between border-b border-edge px-4">
          <div className="text-[12px] font-semibold tracking-wide text-ink-muted uppercase">{title}</div>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      {children}
    </div>
  );
}
