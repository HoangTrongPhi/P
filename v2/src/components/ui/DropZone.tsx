import { FolderOpen, Files, Upload } from "lucide-react";
import { pickPaths } from "../../lib/dialogs";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../stores/appStore";

/**
 * Drop target hint plus folder/file pickers. Actual drops are captured window-wide by
 * `useWindowDragDrop`, which provides real filesystem paths from Tauri.
 */
export function DropZone({ hint, className }: { hint: string; className?: string }) {
  const dragging = useAppStore((s) => s.dragActive);
  const dropped = useAppStore((s) => s.droppedPaths);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
        dragging ? "border-accent bg-accent/8" : "border-edge-strong bg-white/[0.015]",
        className,
      )}
    >
      <div className={cn("grid size-11 place-items-center rounded-full ring-1", dragging ? "bg-accent/15 text-accent ring-accent/30" : "bg-white/5 text-ink-muted ring-edge")}>
        <Upload className="size-5" />
      </div>
      <div>
        <div className="text-[13px] font-medium text-ink">{dragging ? "Release to load" : "Drop folders or asset files"}</div>
        <div className="mt-0.5 text-[12px] text-ink-faint">{hint}</div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => pickPaths("folder")} className="btn">
          <FolderOpen className="size-3.5" /> Open folder
        </button>
        <button type="button" onClick={() => pickPaths("files")} className="btn">
          <Files className="size-3.5" /> Open files
        </button>
      </div>
      {dropped.length > 0 && (
        <div className="mt-1 w-full max-w-xl rounded-lg border border-edge bg-canvas/60 p-2 text-left font-mono text-[11px] text-ink-muted">
          {dropped.slice(0, 6).map((p) => (
            <div key={p} className="truncate" title={p}>
              {p}
            </div>
          ))}
          {dropped.length > 6 && <div className="text-ink-faint">… and {dropped.length - 6} more</div>}
        </div>
      )}
    </div>
  );
}
