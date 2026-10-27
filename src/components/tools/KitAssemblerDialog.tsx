import { AlertTriangle, Box, FileJson, FolderOpen, FolderOutput, Image, Layers, Loader2, Paperclip, PackageCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { inTauri, revealInExplorer } from "../../lib/ipc";
import { basename, humanSize } from "../../lib/pathUtil";
import { relPath } from "../../lib/reports";
import { uiLog } from "../../stores/appStore";
import { openSlots, useKitStore } from "../../stores/kitStore";
import type { KitItem, KitKind, KitNaming, KitStatus } from "../../types/pipeline";
import { Checkbox, FieldLabel, PathText, ProgressBar, Segmented, TextField } from "../ui/Controls";

const KIND: Record<KitKind, { label: string; icon: typeof Box }> = {
  mesh: { label: "Mesh", icon: Box },
  texture: { label: "Texture", icon: Image },
  orm: { label: "ORM", icon: Layers },
  sidecar: { label: "Sidecar", icon: Paperclip },
};
const STATUS: Record<KitStatus, { label: string; cls: string }> = {
  planned: { label: "Will write", cls: "text-accent" },
  written: { label: "Written", cls: "text-emerald" },
  skipped: { label: "Kept", cls: "text-ink-faint" },
  failed: { label: "Failed", cls: "text-rose" },
};
const NAMING_EXAMPLE: Record<KitNaming, string> = {
  ue5: "SM_Wall_Corner_01.fbx · T_Wall_Corner_D.png · T_Wall_Corner_ORM.png",
  unity: "WallCorner01.fbx · WallCorner_BaseColor.png · WallCorner_ORM.png",
  keep: "Original file names",
};

/** Copy the Asset Matcher's picks (or a saved asset_manifest.json) into a clean project layout. */
export function KitAssemblerDialog() {
  const { open, manifest, manifestFile, options, plan, planning, result, running, progress, error, close, setOptions, pickDest, preview, assemble, openManifestFile } = useKitStore();

  // Re-plan (dry run) shortly after the options change. A finished run stays on screen until then.
  useEffect(() => {
    if (!open || running || result) return;
    const t = setTimeout(() => void preview(), 250);
    return () => clearTimeout(t);
  }, [open, manifest, options, preview, running, result]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open || !manifest) return null;
  const pending = openSlots(manifest);
  const count = (s: KitStatus) => plan?.items.filter((i) => i.status === s).length ?? 0;
  const toWrite = count("planned");

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/50 p-4" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kit-title"
        className="flex max-h-[92vh] w-full max-w-4xl animate-pop-in flex-col rounded-xl border border-edge-strong bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-edge px-5 py-3.5">
          <PackageCheck className="mt-0.5 size-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="kit-title" className="text-[14px] font-semibold text-ink">
              Assemble kit
            </h2>
            <div className="truncate text-[12px] text-ink-muted" title={manifestFile ?? manifest.root}>
              {manifest.assets.length} mesh(es) from {manifestFile ? basename(manifestFile) : "the Asset Matcher"} · delivery {manifest.root} (read only)
            </div>
          </div>
          <button type="button" className="btn h-7" onClick={() => void openManifestFile()} disabled={running} title="Use a saved asset_manifest.json instead">
            <FileJson className="size-3.5" /> Open manifest…
          </button>
          <button type="button" className="icon-btn size-7" aria-label="Close" onClick={close} disabled={running}>
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 border-b border-edge px-5 py-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div>
              <FieldLabel>Destination (project folder)</FieldLabel>
              <div className="flex items-center gap-2">
                {options.dest ? <PathText path={options.dest} className="min-w-0 flex-1 text-ink" /> : <span className="flex-1 text-[12px] text-ink-faint">Choose where the kit goes, e.g. your UE5 project's Content/Environment</span>}
                <button type="button" className="btn h-7" onClick={() => void pickDest()} disabled={running}>
                  <FolderOpen className="size-3.5" /> Choose…
                </button>
              </div>
            </div>
            <div>
              <FieldLabel>Naming</FieldLabel>
              <Segmented<KitNaming>
                value={options.naming}
                onChange={(naming) => setOptions({ naming })}
                options={[
                  { value: "ue5", label: "Unreal (UE5)" },
                  { value: "unity", label: "Unity" },
                  { value: "keep", label: "Keep names" },
                ]}
              />
              <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">{NAMING_EXAMPLE[options.naming]}</div>
            </div>
            <div className="flex gap-2">
              <label className="flex-1">
                <FieldLabel>Mesh folder</FieldLabel>
                <TextField mono className="w-full" value={options.meshDir} onChange={(e) => setOptions({ meshDir: e.target.value })} />
              </label>
              <label className="flex-1">
                <FieldLabel>Texture folder</FieldLabel>
                <TextField mono className="w-full" value={options.textureDir} onChange={(e) => setOptions({ textureDir: e.target.value })} />
              </label>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Checkbox checked={options.packOrm} onChange={(packOrm) => setOptions({ packOrm })} label="Pack ORM maps" hint="Roughness / gloss / metallic / AO become one ORM texture; the separate maps are not copied" />
            <Checkbox checked={options.relink} onChange={(relink) => setOptions({ relink })} label="Relink texture paths in meshes" hint="FBX, OBJ-MTL and glTF copies point at the copied textures (relative paths)" />
            <Checkbox checked={options.keepPackages} onChange={(keepPackages) => setOptions({ keepPackages })} label="Keep package folders" hint="Wall Modular/Meshes/… instead of one shared Meshes/ and Textures/" />
            <Checkbox
              checked={options.includeOpen}
              onChange={(includeOpen) => setOptions({ includeOpen })}
              disabled={!pending}
              label={`Include unconfirmed matches${pending ? ` (${pending})` : ""}`}
              hint="Review slots nobody picked yet take the top candidate"
            />
            <Checkbox checked={options.overwrite} onChange={(overwrite) => setOptions({ overwrite })} label="Overwrite files already in the destination" hint="Off: existing files are kept and skipped" />
          </div>
        </div>

        <PlanTable items={plan?.items ?? []} dest={options.dest} planning={planning} hasDest={!!options.dest} />

        {(error || (plan && (plan.warnings.length > 0 || plan.skippedSlots.length > 0))) && (
          <div className="max-h-28 overflow-y-auto border-t border-edge px-5 py-2 text-[11.5px]">
            {error && <div className="text-rose">{error}</div>}
            {plan?.skippedSlots.map((s) => (
              <div key={s} className="text-ink-faint">
                Left out: {s}
              </div>
            ))}
            {plan?.warnings.map((w) => (
              <div key={w} className="flex items-start gap-1.5 text-amber">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-edge px-5 py-3">
          {running ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <ProgressBar value={progress?.done ?? 0} total={progress?.total ?? 0} indeterminate={!progress} />
              <span className="truncate text-[11.5px] text-ink-faint">{progress ? `${progress.done}/${progress.total} · ${progress.message}` : "Starting…"}</span>
            </div>
          ) : result ? (
            <div className="min-w-0 flex-1 text-[12px] text-ink-muted">
              <span className="text-emerald">{result.items.filter((i) => i.status === "written").length} written</span> · {humanSize(result.bytesWritten)} · {result.relinked} texture path(s) relinked ·{" "}
              {result.items.filter((i) => i.status === "skipped").length} kept
              {result.items.some((i) => i.status === "failed") && <span className="text-rose"> · {result.items.filter((i) => i.status === "failed").length} failed</span>}
            </div>
          ) : (
            <div className="min-w-0 flex-1 text-[12px] text-ink-muted">{plan ? `${toWrite} file(s) to write, ${count("skipped")} already there` : "The plan appears here once a destination is chosen."}</div>
          )}
          {result?.kitManifest && (
            <button type="button" className="btn h-8" onClick={() => inTauri && revealInExplorer(result.kitManifest!).catch((e) => uiLog("error", String(e)))}>
              <FolderOutput className="size-3.5" /> Show kit
            </button>
          )}
          <button type="button" className="btn btn-primary h-8" disabled={running || planning || !plan || toWrite === 0} onClick={() => void assemble()}>
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />} {toWrite ? `Assemble ${toWrite} file(s)` : "Nothing to write"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanTable({ items, dest, planning, hasDest }: { items: KitItem[]; dest: string; planning: boolean; hasDest: boolean }) {
  const [kind, setKind] = useState<KitKind | "all">("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);
  const shown = kind === "all" ? items : items.filter((i) => i.kind === kind);

  return (
    <div className="flex min-h-48 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-2">
        <Segmented<KitKind | "all">
          size="sm"
          value={kind}
          onChange={setKind}
          options={(["all", "mesh", "texture", "orm", "sidecar"] as const).map((k) => ({ value: k, label: `${k === "all" ? "All" : KIND[k].label} ${counts[k] ?? 0}` }))}
        />
        {planning && <Loader2 className="size-3.5 animate-spin text-ink-faint" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
        {!hasDest ? (
          <div className="py-8 text-center text-[12px] text-ink-faint">Choose a destination to see what will be copied, renamed and packed.</div>
        ) : (
          <table className="w-full table-fixed text-[12px]">
            <thead className="sticky top-0 bg-panel text-left text-[11px] tracking-wide text-ink-faint uppercase">
              <tr>
                <th className="w-24 py-1 font-medium">Kind</th>
                <th className="py-1 font-medium">In the kit</th>
                <th className="py-1 font-medium">From</th>
                <th className="w-24 py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const K = KIND[i.kind].icon;
                return (
                  <tr key={`${i.kind}:${i.target}`} className="border-t border-edge/50">
                    <td className="py-1 text-ink-muted">
                      <span className="flex items-center gap-1.5">
                        <K className="size-3.5 text-ink-faint" /> {KIND[i.kind].label}
                      </span>
                    </td>
                    <td className="truncate py-1 font-mono text-[11.5px] text-ink" title={i.target}>
                      {relPath(i.target, dest)}
                    </td>
                    <td className="truncate py-1 font-mono text-[11.5px] text-ink-faint" title={i.sources.join("\n")}>
                      {i.sources.map(basename).join(" + ")}
                    </td>
                    <td className={cn("truncate py-1", STATUS[i.status].cls)} title={i.note ?? undefined}>
                      {STATUS[i.status].label}
                      {i.note && i.status !== "skipped" && <span className="text-ink-faint"> · {i.note}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
