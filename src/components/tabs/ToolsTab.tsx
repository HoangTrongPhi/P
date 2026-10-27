import { Box, Combine, Copy, Download, ExternalLink, EyeOff, FolderOpen, ImageOff, Layers, Loader2, Play, Plus, RefreshCw, ScanEye, TriangleAlert, X } from "lucide-react";
import { assetUrl } from "../../lib/assetUrl";
import { cn } from "../../lib/cn";
import { pickOne, pickSavePath } from "../../lib/dialogs";
import { routeDrop } from "../../lib/dropRouter";
import { revealInExplorer } from "../../lib/ipc";
import { basename, humanSize } from "../../lib/pathUtil";
import { convertReport, duplicatesReport, MAP_LABELS, meshesReport, textureSetsReport, unusedReport } from "../../lib/reportBuilders";
import { exportReport, relPath, type ReportDoc } from "../../lib/reports";
import { uiLog } from "../../stores/appStore";
import { useToolsStore, type LeftView, type OrmSlot, type ToolsView } from "../../stores/toolsStore";
import type { ConvertFormat, MapKind, MeshStats } from "../../types/pipeline";
import { Checkbox, EmptyState, FieldLabel, PathText, Segmented, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge } from "../ui/PillBadge";

const IMAGE_FILTER = [{ name: "Textures", extensions: ["png", "jpg", "jpeg", "tga", "tif", "tiff", "bmp", "webp"] }];
const CONVERT_FILTER = [{ name: "Textures", extensions: ["png", "jpg", "jpeg", "tga", "tif", "tiff", "bmp", "webp", "psd"] }];
const THUMB_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

const SLOTS: { slot: OrmSlot; channel: string; label: string; fallback: string; tone: string }[] = [
  { slot: "ao", channel: "R", label: "Ambient occlusion", fallback: "white (1.0)", tone: "text-rose" },
  { slot: "roughness", channel: "G", label: "Roughness", fallback: "0.5", tone: "text-emerald" },
  { slot: "metallic", channel: "B", label: "Metallic", fallback: "black (0.0)", tone: "text-accent" },
];

const SELECT = "h-7 rounded-md border border-edge bg-canvas/70 px-1.5 text-[12px] text-ink outline-none focus:border-accent/60";

const reveal = (p: string) => revealInExplorer(p).catch((e) => uiLog("error", String(e)));

export function ToolsTab() {
  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <LeftCard />
      <AnalysisCard />
    </div>
  );
}

function LeftCard() {
  const { leftView, setLeftView } = useToolsStore();
  return (
    <GlassCard
      title={
        <Segmented<LeftView>
          size="sm"
          value={leftView}
          onChange={setLeftView}
          options={[
            { value: "orm", label: "ORM packer" },
            { value: "convert", label: "Converter" },
          ]}
        />
      }
      className="flex w-[380px] shrink-0 flex-col"
    >
      {leftView === "orm" ? <OrmPanel /> : <ConverterPanel />}
    </GlassCard>
  );
}

function OrmPanel() {
  const s = useToolsStore();
  const hasInput = Object.values(s.slots).some(Boolean);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="text-[11.5px] text-ink-faint">Drop maps named …_ao, …_roughness, …_metallic onto the window, or pick each one. For many materials at once, use Texture sets on the right.</div>
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
      {s.packed && <ResultFile path={s.packed} />}
    </div>
  );
}

function ResultFile({ path }: { path: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald/25 bg-emerald/6 px-2.5 py-2">
      <PathText path={path} className="flex-1 text-ink" />
      <button type="button" className="icon-btn size-6" title="Preview" onClick={() => routeDrop("preview", [path])}>
        <ScanEye className="size-3.5" />
      </button>
      <button type="button" className="icon-btn size-6" title="Show in Explorer" onClick={() => void reveal(path)}>
        <ExternalLink className="size-3.5" />
      </button>
    </div>
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

// ---------------------------------------------------------------- converter

const SIZES = [0, 8192, 4096, 2048, 1024, 512, 256];
const FORMATS: { value: ConvertFormat; label: string }[] = [
  { value: "keep", label: "Same as source" },
  { value: "png", label: "PNG" },
  { value: "tga", label: "TGA" },
  { value: "jpg", label: "JPG" },
  { value: "dds", label: "DDS (uncompressed + mips)" },
];

function ConverterPanel() {
  const s = useToolsStore();
  const o = s.convertOptions;
  const items = s.converted;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div>
        <FieldLabel>Inputs</FieldLabel>
        <div className="flex flex-col gap-1 rounded-lg border border-edge bg-panel-raised/40 p-1">
          {s.convertInputs.map((p) => (
            <div key={p} className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-tint/4">
              <PathText path={p} className="flex-1 text-ink-muted" />
              <button type="button" className="icon-btn size-5 opacity-0 group-hover:opacity-100" aria-label="Remove" onClick={() => s.removeConvertInput(p)}>
                <X className="size-3" />
              </button>
            </div>
          ))}
          {s.convertInputs.length === 0 && <div className="px-2 py-2 text-[11.5px] text-ink-faint">Drop textures here, or add files / a folder.</div>}
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <button type="button" className="btn h-6 px-2" onClick={async () => { const p = await pickOne("file", CONVERT_FILTER); if (p) s.addConvertInputs([p]); }}>
            <Plus className="size-3" /> File
          </button>
          <button type="button" className="btn h-6 px-2" onClick={async () => { const p = await pickOne("folder"); if (p) s.addConvertInputs([p]); }}>
            <Plus className="size-3" /> Folder
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col">
          <FieldLabel>Max size</FieldLabel>
          <select className={SELECT} value={o.maxSize ?? 0} onChange={(e) => s.setConvertOptions({ maxSize: Number(e.target.value) || null })}>
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {n ? `${n} px` : "Keep size"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <FieldLabel>Format</FieldLabel>
          <select className={SELECT} value={o.format} onChange={(e) => s.setConvertOptions({ format: e.target.value as ConvertFormat })}>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Checkbox checked={!!o.powerOfTwo} onChange={(v) => s.setConvertOptions({ powerOfTwo: v })} label="Snap to power of two" hint="e.g. 1000 x 300 → 1024 x 256" />
      <Checkbox checked={!!o.flipGreen} onChange={(v) => s.setConvertOptions({ flipGreen: v })} label="Flip green channel" hint="Normal maps: DirectX (UE) ↔ OpenGL (Unity, Blender)" />
      <div className="grid grid-cols-[1fr_90px] gap-2">
        <label className="flex flex-col">
          <FieldLabel>Output folder</FieldLabel>
          <TextField mono value={o.outputDir ?? ""} placeholder="converted" onChange={(e) => s.setConvertOptions({ outputDir: e.target.value })} title="Relative to each source folder, or an absolute path" />
        </label>
        <label className="flex flex-col">
          <FieldLabel>Suffix</FieldLabel>
          <TextField mono value={o.suffix ?? ""} placeholder="_GL" onChange={(e) => s.setConvertOptions({ suffix: e.target.value })} />
        </label>
      </div>
      <Checkbox checked={!!o.overwrite} onChange={(v) => s.setConvertOptions({ overwrite: v })} label="Overwrite existing files" hint="Including the source, when the output is the same file" />
      <div className="flex gap-2">
        <button type="button" className="btn flex-1 justify-center" disabled={!s.convertInputs.length || s.converting} onClick={() => void s.convert(true)}>
          Dry run
        </button>
        <button type="button" className="btn btn-primary flex-1 justify-center" disabled={!s.convertInputs.length || s.converting} onClick={() => void s.convert(false)}>
          {s.converting ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Convert
        </button>
      </div>
      {items && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <PillBadge tone="emerald">{items.filter((i) => i.written || (!i.skipped && !i.error)).length} {items.some((i) => i.written) ? "converted" : "planned"}</PillBadge>
            {items.some((i) => i.skipped) && <PillBadge tone="amber">{items.filter((i) => i.skipped).length} skipped</PillBadge>}
            {items.some((i) => i.error) && <PillBadge tone="rose">{items.filter((i) => i.error).length} failed</PillBadge>}
            <button type="button" className="btn ml-auto h-6 px-2" onClick={() => void exportReport(convertReport(items))}>
              <Download className="size-3" /> Report
            </button>
          </div>
          <div className="rounded-lg border border-edge bg-panel-raised/40 p-1">
            {items.map((i) => (
              <div key={i.source} className="flex items-center gap-2 px-1.5 py-1 text-[11.5px]" title={i.output ?? i.source}>
                <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">{basename(i.source)}</span>
                <span className={cn("shrink-0", i.error ? "text-rose" : i.skipped ? "text-amber" : "text-ink-faint")}>
                  {i.error ? "error" : i.skipped ? "skipped" : i.toSize ? `${i.toSize[0]}×${i.toSize[1]}` : ""}
                </span>
                {i.written && i.output && (
                  <button type="button" className="icon-btn size-5" title="Preview" onClick={() => routeDrop("preview", [i.output!])}>
                    <ScanEye className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- analysis

const RUN_LABEL: Record<ToolsView, string> = { duplicates: "Find duplicates", unused: "Find unused", sets: "Match sets", meshes: "Inspect meshes" };

function useCurrentReport(): ReportDoc | null {
  const { view, folder, duplicates, unused, sets, meshes } = useToolsStore();
  if (view === "duplicates" && duplicates) return duplicatesReport(duplicates, folder);
  if (view === "unused" && unused) return unusedReport(unused, folder);
  if (view === "sets" && sets) return textureSetsReport(sets, folder);
  if (view === "meshes" && meshes) return meshesReport(meshes, folder);
  return null;
}

function AnalysisCard() {
  const { folder, view, running, duplicates, unused, sets, meshes, meshFiles, includeBlend, triBudget, setFolder, setView, setIncludeBlend, setTriBudget, runAnalysis } = useToolsStore();
  const report = useCurrentReport();
  const canRun = !!folder || (view === "meshes" && !!meshFiles);
  return (
    <GlassCard
      className="flex min-w-0 flex-1 flex-col"
      title={
        <Segmented<ToolsView>
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "duplicates", label: "Duplicates" },
            { value: "unused", label: "Unused textures" },
            { value: "sets", label: "Texture sets" },
            { value: "meshes", label: "Meshes" },
          ]}
        />
      }
      actions={
        <button type="button" className="btn h-6 px-2" disabled={!report} onClick={() => report && void exportReport(report)} title="Save as HTML or CSV">
          <Download className="size-3" /> Export
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <FolderOpen className="size-4 shrink-0 text-ink-faint" />
        {view === "meshes" && meshFiles ? (
          <span className="flex-1 truncate text-[12px] text-ink">{meshFiles.length} dropped mesh file(s)</span>
        ) : folder ? (
          <PathText path={folder} className="min-w-0 flex-1 text-ink" />
        ) : (
          <span className="flex-1 text-[12px] text-ink-faint">Drop a project folder or choose one</span>
        )}
        {view === "unused" && <Checkbox checked={includeBlend} onChange={setIncludeBlend} label="Read .blend files" hint="Needs Blender 5.0+; one headless run per file" />}
        {view === "meshes" && (
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            Triangle budget
            <TextField className="w-20" inputMode="numeric" placeholder="none" value={triBudget ?? ""} onChange={(e) => setTriBudget(Number(e.target.value.replace(/\D/g, "")) || null)} />
          </label>
        )}
        <button type="button" className="btn" onClick={async () => { const f = await pickOne("folder"); if (f) setFolder(f); }}>
          Choose…
        </button>
        <button type="button" className="btn btn-primary" disabled={!canRun || running} onClick={() => void runAnalysis()}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {RUN_LABEL[view]}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "duplicates" ? (
          duplicates ? <DuplicatesView /> : <EmptyState icon={<Copy className="size-5" />} title="Byte-identical assets">Files are grouped by size, then hashed with XXH3 in parallel. Only one copy per group is needed.</EmptyState>
        ) : view === "unused" ? (
          unused ? <UnusedView /> : <EmptyState icon={<EyeOff className="size-5" />} title="Textures nothing references">Every FBX, OBJ/MTL, glTF and GLB file is read and compared against the textures on disk. Tick “Read .blend files” to include Blender scenes.</EmptyState>
        ) : view === "sets" ? (
          sets ? <SetsView /> : <EmptyState icon={<Layers className="size-5" />} title="Group textures into material sets">Maps are matched by name (…_BaseColor, …_N, …_Roughness, …). See which maps each material lacks and pack ORM textures for many sets at once.</EmptyState>
        ) : meshes ? (
          <MeshesView stats={meshes} />
        ) : (
          <EmptyState icon={<Box className="size-5" />} title="Mesh statistics">Triangles, vertices, UV sets, materials, normals, size and units of every FBX, OBJ, glTF and GLB — read directly, no viewport needed. Drop mesh files or choose a folder.</EmptyState>
        )}
      </div>
    </GlassCard>
  );
}

function FileLine({ path, root, size }: { path: string; root: string | null; size?: number }) {
  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-tint/4">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-muted" title={path}>
        {relPath(path, root)}
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
  const blendSkipped = u.blendFiles - u.blendInspected;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PillBadge tone={u.textures.length ? "amber" : "emerald"}>
          {u.textures.length} of {u.totalTextures} unreferenced
        </PillBadge>
        <PillBadge tone="accent">{humanSize(u.reclaimableBytes)} reclaimable</PillBadge>
        <span className="text-[11.5px] text-ink-faint">
          {u.referenceFiles} FBX / MTL / glTF file(s){u.blendInspected > 0 && `, ${u.blendInspected} .blend file(s)`} read
        </span>
      </div>
      {blendSkipped > 0 && (
        <div className="flex gap-2 rounded-lg border border-amber/20 bg-amber/6 px-3 py-2 text-[11.5px] text-ink-muted">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
          {blendSkipped} .blend file(s) were not inspected: textures used only by those scenes appear here too. Tick “Read .blend files” and run again, or review before deleting.
        </div>
      )}
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

const SET_COLUMNS: MapKind[] = ["baseColor", "normal", "orm", "roughness", "metallic", "ao"];

function SetsView() {
  const { sets: r, folder, selectedSets, packingSets, format, toggleSet, selectPackable, packSelectedSets, setFormat } = useToolsStore();
  if (!r) return null;
  const packable = r.sets.filter((s) => s.canPackOrm);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PillBadge tone="accent">{r.sets.length} set(s)</PillBadge>
        <PillBadge tone={r.sets.some((s) => s.missing.length) ? "amber" : "emerald"}>{r.sets.filter((s) => s.missing.length).length} incomplete</PillBadge>
        <PillBadge tone="emerald">{packable.length} ready for ORM</PillBadge>
        {r.unmatched.length > 0 && <span className="text-[11.5px] text-ink-faint" title={r.unmatched.join("\n")}>{r.unmatched.length} texture(s) without a map suffix</span>}
      </div>
      {packable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-panel-raised/40 px-3 py-2">
          <Checkbox checked={selectedSets.length === packable.length} onChange={selectPackable} label={`Select all ${packable.length} packable`} />
          <span className="flex-1" />
          <Segmented size="sm" value={format} onChange={setFormat} options={[{ value: "png", label: "PNG" }, { value: "tga", label: "TGA" }]} />
          <button type="button" className="btn btn-primary" disabled={!selectedSets.length || packingSets} onClick={() => void packSelectedSets()}>
            {packingSets ? <Loader2 className="size-3.5 animate-spin" /> : <Combine className="size-3.5" />} Pack {selectedSets.length || ""} ORM
          </button>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-edge">
        <table className="w-full text-[12px]">
          <thead className="bg-panel-raised/60 text-left text-[11px] text-ink-faint uppercase">
            <tr>
              <th className="w-8 px-2 py-1.5" />
              <th className="px-2 py-1.5 font-medium">Set</th>
              {SET_COLUMNS.map((k) => (
                <th key={k} className="px-2 py-1.5 text-center font-medium">
                  {MAP_LABELS[k]}
                </th>
              ))}
              <th className="px-2 py-1.5 font-medium">Missing</th>
            </tr>
          </thead>
          <tbody>
            {r.sets.map((s) => (
              <tr key={s.suggestedOrm} className="border-t border-edge hover:bg-tint/3">
                <td className="px-2 py-1">
                  {s.canPackOrm && <input type="checkbox" className="size-3.5 accent-accent" aria-label={`Pack ${s.name}`} checked={selectedSets.includes(s.suggestedOrm)} onChange={() => toggleSet(s.suggestedOrm)} />}
                </td>
                <td className="max-w-56 px-2 py-1">
                  <div className="truncate text-ink" title={s.dir}>
                    {s.name}
                  </div>
                  <div className="truncate text-[10.5px] text-ink-faint">{relPath(s.dir, folder) || "."}</div>
                </td>
                {SET_COLUMNS.map((k) => {
                  const p = s.maps[k] ?? (k === "roughness" ? s.maps.gloss : undefined);
                  return (
                    <td key={k} className="px-2 py-1 text-center">
                      {p ? (
                        <button type="button" className="text-emerald hover:underline" title={p} onClick={() => routeDrop("preview", [p])}>
                          {k === "roughness" && !s.maps.roughness ? "gloss" : "✓"}
                        </button>
                      ) : (
                        <span className="text-ink-faint">·</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1">
                  {s.missing.map((k) => (
                    <PillBadge key={k} tone="amber" className="mr-1">
                      {MAP_LABELS[k]}
                    </PillBadge>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.sets.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-ink-faint">No texture with a recognisable map suffix.</div>}
      </div>
    </div>
  );
}

const fmtNum = (n: number) => n.toLocaleString("en-US");

function MeshesView({ stats }: { stats: MeshStats[] }) {
  const { folder } = useToolsStore();
  const tris = stats.reduce((n, s) => n + s.triangles, 0);
  const flagged = stats.filter((s) => s.warnings.length || s.error).length;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PillBadge tone="accent">{stats.length} file(s)</PillBadge>
        <PillBadge>{fmtNum(tris)} triangles</PillBadge>
        <PillBadge tone={flagged ? "amber" : "emerald"}>{flagged} with warnings</PillBadge>
        <span className="text-[11.5px] text-ink-faint">Sizes are in file units, before node transforms</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-edge">
        <table className="w-full text-[12px]">
          <thead className="bg-panel-raised/60 text-left text-[11px] text-ink-faint uppercase">
            <tr>
              {["File", "Tris", "Verts", "Mat", "UV", "Size", "Units", ""].map((h, i) => (
                <th key={i} className={cn("px-2 py-1.5 font-medium", i > 0 && i < 5 && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => {
              const size = s.bounds ? s.bounds.max.map((v, i) => +(v - s.bounds!.min[i]).toFixed(2)).join(" × ") : "—";
              return (
                <tr key={s.path} className="group border-t border-edge align-top hover:bg-tint/3">
                  <td className="max-w-64 px-2 py-1">
                    <div className="truncate font-mono text-[11.5px] text-ink" title={s.path}>
                      {relPath(s.path, folder)}
                    </div>
                    <div className="text-[10.5px] text-ink-faint">
                      {s.format}
                      {s.meshes > 1 && ` · ${s.meshes} meshes`}
                      {s.upAxis && ` · ${s.upAxis} up`}
                    </div>
                    {(s.error ? [s.error] : s.warnings).map((w) => (
                      <div key={w} className={cn("flex items-start gap-1 text-[11px]", s.error ? "text-rose" : "text-amber")}>
                        <TriangleAlert className="mt-0.5 size-3 shrink-0" /> {w}
                      </div>
                    ))}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtNum(s.triangles)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtNum(s.vertices)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{s.materials}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{s.uvSets}</td>
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums">{size}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-ink-muted">{s.unitScaleCm === null ? "—" : s.unitScaleCm === 100 ? "m" : s.unitScaleCm === 1 ? "cm" : `${s.unitScaleCm} cm`}</td>
                  <td className="px-1 py-1">
                    <button type="button" className="icon-btn size-6 opacity-0 group-hover:opacity-100" title="Preview" onClick={() => routeDrop("preview", [s.path])}>
                      <ScanEye className="size-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {stats.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-ink-faint">No FBX, OBJ, glTF or GLB file found.</div>}
      </div>
    </div>
  );
}
