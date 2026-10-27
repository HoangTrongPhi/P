import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Checkbox({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-[12.5px] text-ink", disabled && "pointer-events-none opacity-40")} title={hint}>
      <input type="checkbox" className="mt-[3px] size-3.5 accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-ink-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: {
  value: T;
  options: { value: T; label: ReactNode; hint?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-lg border border-edge bg-canvas/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 font-medium transition-colors",
            size === "sm" ? "h-6 text-[11.5px]" : "h-7 text-[12px]",
            value === o.value ? "bg-panel-raised text-ink shadow-sm ring-1 ring-edge-strong" : "text-ink-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TextField({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      spellCheck={false}
      {...rest}
      className={cn(
        "h-7 min-w-0 rounded-md border border-edge bg-canvas/70 px-2 text-[12px] text-ink outline-none transition-colors select-text placeholder:text-ink-faint focus:border-accent/60",
        mono && "font-mono text-[11.5px]",
        className,
      )}
    />
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[11px] font-medium tracking-wide text-ink-faint uppercase">{children}</div>;
}

export function ProgressBar({ value, total, indeterminate }: { value: number; total: number; indeterminate?: boolean }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-tint/6">
      <div
        className={cn("h-full rounded-full bg-accent transition-[width] duration-300", indeterminate && "w-1/3 animate-pulse")}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/** A path shown as `…/folder/name` with the full path on hover. */
export function PathText({ path, className }: { path: string; className?: string }) {
  return (
    <span className={cn("truncate font-mono text-[11.5px]", className)} title={path} dir="rtl">
      {/* rtl keeps the file name visible when the path is truncated */}
      <bdi>{path}</bdi>
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-tint/5 text-ink-faint ring-1 ring-edge">{icon}</div>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {children && <div className="max-w-md text-[12px] text-ink-faint">{children}</div>}
    </div>
  );
}
