import { CircleAlert } from "lucide-react";
import { moduleById } from "../../lib/modules";
import type { TabId } from "../../types/pipeline";
import { DropZone } from "../ui/DropZone";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge } from "../ui/PillBadge";

/** Shared shell for modules whose engines land in later migration phases. */
export function ModulePlaceholder({ id, phase, dropHint, features }: {
  id: TabId;
  phase: number;
  dropHint: string;
  features: string[];
}) {
  const mod = moduleById(id);
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <GlassCard
        title={
          <span className="flex items-center gap-2">
            <mod.icon className="size-3.5" /> {mod.label}
          </span>
        }
        actions={<PillBadge tone="amber">Phase {phase}</PillBadge>}
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-start gap-2 rounded-lg border border-amber/20 bg-amber/6 px-3 py-2 text-[12px] text-ink-muted">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
            The Rust engine for this module is scheduled for Phase {phase} of the V2 migration. The layout, drag & drop and
            dialogs below are live.
          </div>
          <DropZone hint={dropHint} />
        </div>
      </GlassCard>
      <GlassCard title="Planned capabilities">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 text-[12.5px] text-ink-muted md:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="flex gap-2">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />
              {f}
            </li>
          ))}
        </ul>
      </GlassCard>
    </div>
  );
}
