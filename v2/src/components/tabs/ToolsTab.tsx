import { Combine, Copy, ExternalLink, EyeOff, FolderOpen, ImageOff, Loader2, Play, ScanEye, TriangleAlert, X } from "lucide-react";
import { assetUrl } from "../../lib/assetUrl";
import { cn } from "../../lib/cn";
import { pickOne, pickSavePath } from "../../lib/dialogs";
import { routeDrop } from "../../lib/dropRouter";
import { revealInExplorer } from "../../lib/ipc";
import { basename, humanSize } from "../../lib/pathUtil";
import { uiLog } from "../../stores/appStore";
import { useToolsStore, type OrmSlot, type ToolsView } from "../../stores/toolsStore";
import { Checkbox, EmptyState, FieldLabel, PathText, Segmented, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge } from "../ui/PillBadge";

const IMAGE_FILTER = [{ name: "Textures", extensions: ["png", "jpg", "jpeg", "tga", "tif", "tiff", "bmp", "webp"] }];
const THUMB_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

const SLOTS: { slot: OrmSlot; channel: string; label: string; fallback: string; tone: string }[] = [
  { slot: "ao", channel: "R", label: "Ambient occlusion", fallback: "white (1.0)", tone: "text-rose" },
  { slot: "roughness", channel: "G", label: "Roughness", fallback: "0.5", tone: "text-emerald" },
  { slot: "metallic", channel: "B", label: "Metallic", fallback: "black (0.0)", tone: "text-accent" },
];

const reveal = (p: string) => revealInExplorer(p).catch((e) => uiLog("error", String(e)));

export function ToolsTab() {
  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <OrmCard />
      <AnalysisCard />
    </div>
  );
}

function OrmCard() {
  const s = useToolsStore();
  const hasInput = Object.values(s.slots).some(Boolean);
  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          <Combine className="size-3.5" /> ORM channel packer
        </span>
      }
      className="flex w-[380px] shrink-0 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="text-[11.5px] text-ink-faint">Drop maps named …_ao, …_roughness, …_metallic onto the window, or pick each one.</div>
        {SLOTS.map((d) => (
          <SlotRow key={d.slot} {...d} path={s.slots[d.slot]} onPick={async () => { const p = await pickOne("file", IMAGE_FILTER); if (p) s.setSlot(d.slot, p); }} onClear={() => s.setSlot(d.slot, null)} />
        ))}
        <Checkbox checked={s.gloss} onChange={s.setGloss} disabled={!s.slots.roughness} label="Roughness input is a gloss / smoothness map" hint="Inverted before packing" />
        <div>
          <FieldLabel>Output</FieldLabel>
          <div className="flex gap-1.5">
            <TextField mono className="flex-1" value={s.outputPath} placeholder="T_Asset_ORM.png" onChange={(e) => s.setOutputPath(e.target.value)} />
            <button type="button" className="btn px-2" aria-label="Browse" onClick={async () => { const p = await pickSavePath(s.outputPath || undefined, [{ name: s.format.toUpperCase(), extensions: [s.format] }]); if (p) s.setOutputPath(p); }}>
              <FolderOpen className="size-3.5" />
            </button>
          </div>
        </div>
        <Segmented value={s.format} onChange={s.setFormat} options={[{ value: "png", label: "PNG" }, { value: "tga", label: "TGA" }]} />
        <button type="button" className="btn btn-primary h-8 justify-center" disabled={!hasInput || !s.outputPath || s.packing} onClick={() => void s.pack()}>
          {s.packing ? <Loader2 className="size-3.5 animate-spin" /> : <Combine className="size-3.5" />} Pack ORM texture
        </button>
        {s.packed && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald/25 bg-emerald/6 px-2.5 py-2">
            <PathText path={s.packed} className="flex-1 text-ink" />
            <button type="button" className="icon-btn size-6" title="Preview" onClick={() => routeDrop("preview", [s.packed!])}>
              <ScanEye className="size-3.5" />
            </button>
            <button type="button" className="icon-btn size-6" title="Show in Explorer" onClick={() => void reveal(s.packed!)}>
              <ExternalLink className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function SlotRow({ channel, label, fallback, tone, path, onPick, onClear }: {
  channel: string;
  label: string;
  fallback: string;
  tone: string;
  path: string | null;
  onPick: () => void;
  onClear: () => void;
}) {
  const ext = path?.split(".").pop()?.toLowerCase() ?? "";
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-edge bg-panel-raised/50 p-2">
      <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md bg-canvas ring-1 ring-edge">
        {path && THUMB_EXTS.includes(ext) ? <img src={assetUrl(path)} alt="" className="size-full object-cover" draggable={false} /> : path ? <span className="text-[10px] text-ink-faint uppercase">{ext}</span> : <ImageOff className="size-4 text-ink-faint" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px] text-ink">
          <span className={cn("font-mono font-bold", tone)}>{channel}</span> {label}
        </div>
        {path ? <PathText path={basename(path)} className="block text-ink-muted" /> : <div className="text-[11px] text-ink-faint">empty → {fallback}</div>}
      </div>
      {path && (
        <button type="button" className="icon-btn size-6" aria-label={`Clear ${label}`} onClick={onClear}>
          <X className="size-3.5" />
        </button>
      )}
      <button type="button" className="btn h-6 px-2" onClick={onPick}>
        Pick
      </button>
    </div>
  );
}

function AnalysisCard() {
  const { folder, view, running, duplicates, unused, setFolder, setView, runAnalysis } = useToolsStore();
  return (
    <GlassCard
      className="flex min-w-0 flex-1 flex-col"
      title={
        <Segmented<ToolsView>
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "duplicates", label: "Duplicate finder" },
            { value: "unused", label: "Unused textures" },
          ]}
        />
      }
    >
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
        <FolderOpen className="size-4 shrink-0 text-ink-faint" />
        {folder ? <PathText path={folder} className="flex-1 text-ink" /> : <span className="flex-1 text-[12px] text-ink-faint">Drop a project folder or choose one</span>}
        <button type="button" className="btn" onClick={async () => { const f = await pickOne("folder"); if (f) setFolder(f); }}>
          Choose…
        </button>
        <button type="button" className="btn btn-primary" disabled={!folder || running} onClick={() => void runAnalysis()}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {view === "duplicates" ? "Find duplicates" : "Find unused"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "duplicates" ? (
          duplicates ? <DuplicatesView /> : <EmptyState icon={<Copy className="size-5" />} title="Byte-identical assets">Files are grouped by size, then hashed with XXH3 in parallel. Only one copy per group is needed.</EmptyState>
        ) : unused ? (
          <UnusedView />
        ) : (
          <EmptyState icon={<EyeOff className="size-5" />} title="Textures nothing references">Every FBX, OBJ/MTL, glTF and GLB file is read and compared against the textures on disk.</EmptyState>
        )}
      </div>
    </GlassCard>
  );
}

function FileLine({ path, root, size }: { path: string; root: string | null; size?: number }) {
  const rel = root && path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-white/4">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-muted" title={path}>
        {rel}
      </span>
      {size !== undefined && <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{humanSize(size)}</span>}
      <button type="button" className="icon-btn size-6 opacity-0 group-hover:opacity-100" title="Preview" onClick={() => routeDrop("preview", [path])}>
        <ScanEye className="size-3.5" />
      </button>
      <button type="button" className="icon-btn size-6 opacity-0 group-hover:opacity-100" title="Show in Explorer" onClick={() => void reveal(path)}>
        <ExternalLink className="size-3.5" />
      </button>
    </div>
  );
}

function DuplicatesView() {
  const { duplicates: d, folder } = useToolsStore();
  if (!d) return null;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PillBadge tone={d.groups.length ? "amber" : "emerald"}>{d.groups.length} group(s)</PillBadge>
        <PillBadge tone="accent">{humanSize(d.wastedBytes)} reclaimable</PillBadge>
        <span className="text-[11.5px] text-ink-faint">
          {d.scannedFiles} assets scanned, {d.hashedFiles} hashed in {d.elapsedMs} ms
        </span>
      </div>
      {d.groups.map((g) => (
        <div key={g.hash} className="rounded-lg border border-edge bg-panel-raised/40">
          <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5 text-[12px]">
            <span className="font-medium text-ink">{basename(g.files[0])}</span>
            <span className="text-ink-faint">
              {g.files.length} copies × {humanSize(g.size)}
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-ink-faint" title="XXH3-128">
              {g.hash.slice(0, 12)}
            </span>
          </div>
          <div className="p-1">
            {g.files.map((f) => (
              <FileLine key={f} path={f} root={folder} />
            ))}
          </div>
        </div>
      ))}
      {d.groups.length === 0 && <EmptyState icon={<Copy className="size-5" />} title="No duplicates found" />}
    </div>
  );
}

function UnusedView() {
  const { unused: u, folder } = useToolsStore();
  if (!u) return null;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PillBadge tone={u.textures.length ? "amber" : "emerald"}>
          {u.textures.length} of {u.totalTextures} unreferenced
        </PillBadge>
        <PillBadge tone="accent">{humanSize(u.reclaimableBytes)} reclaimable</PillBadge>
        <span className="text-[11.5px] text-ink-faint">{u.referenceFiles} FBX / MTL / glTF file(s) read</span>
      </div>
      <div className="flex gap-2 rounded-lg border border-amber/20 bg-amber/6 px-3 py-2 text-[11.5px] text-ink-muted">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
        .blend files are not inspected: textures used only by Blender scenes appear here too. Review before deleting.
      </div>
      {u.warnings.length > 0 && <div className="text-[11.5px] text-amber">{u.warnings.length} file(s) could not be read (see the log)</div>}
      <div className="rounded-lg border border-edge bg-panel-raised/40 p-1">
        {u.textures.map((t) => (
          <FileLine key={t.path} path={t.path} root={folder} size={t.size} />
        ))}
        {u.textures.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-ink-faint">Every texture is referenced.</div>}
      </div>
    </div>
  );
}
