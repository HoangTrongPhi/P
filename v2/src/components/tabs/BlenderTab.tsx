import { Ban, CircleCheck, FileArchive, FolderOpen, Loader2, Package, Play, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../../lib/cn";
import { pickOne, pickPaths, pickSavePath } from "../../lib/dialogs";
import { inTauri } from "../../lib/ipc";
import { basename } from "../../lib/pathUtil";
import { useBlenderStore } from "../../stores/blenderStore";
import type { BlenderDependency } from "../../types/pipeline";
import { Checkbox, EmptyState, FieldLabel, PathText, ProgressBar, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge } from "../ui/PillBadge";

export function BlenderTab() {
  const { discovered, discovering, discover } = useBlenderStore();
  useEffect(() => {
    if (inTauri && !discovered && !discovering) void discover();
  }, [discovered, discovering, discover]);

  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <div className="flex w-[360px] shrink-0 flex-col gap-3">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <InstallCard />
          <JobCard />
        </div>
        <RunBar />
      </div>
      <ResultPanel />
    </div>
  );
}

function InstallCard() {
  const { installs, blenderPath, discovering, discover, setBlender } = useBlenderStore();
  const custom = blenderPath && !installs.some((b) => b.executable === blenderPath);
  return (
    <GlassCard
      title="Blender"
      actions={
        <button type="button" className="icon-btn size-6" onClick={() => void discover()} disabled={discovering} title="Search again">
          <RefreshCw className={cn("size-3.5", discovering && "animate-spin")} />
        </button>
      }
    >
      <div className="flex flex-col gap-2 p-3">
        {installs.length === 0 && !discovering && (
          <div className="flex gap-2 rounded-lg border border-amber/25 bg-amber/6 px-2.5 py-2 text-[11.5px] text-ink-muted">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
            No Blender found. Set BLENDER_PATH or browse to blender.exe.
          </div>
        )}
        <select
          value={blenderPath ?? ""}
          onChange={(e) => setBlender(e.target.value)}
          className="h-8 rounded-md border border-edge bg-canvas/70 px-2 text-[12px] text-ink outline-none focus:border-accent/60"
        >
          {installs.map((b) => (
            <option key={b.executable} value={b.executable} disabled={!b.supported}>
              Blender {b.versionString}
              {!b.supported && " (needs 5.0+)"}
            </option>
          ))}
          {custom && <option value={blenderPath}>{blenderPath}</option>}
          {!blenderPath && <option value="">—</option>}
        </select>
        <div className="flex items-center gap-2">
          {blenderPath && <PathText path={blenderPath} className="flex-1 text-ink-faint" />}
          <button
            type="button"
            className="btn ml-auto h-6 px-2"
            onClick={async () => {
              const exe = await pickOne("file", [{ name: "Blender", extensions: ["exe"] }]);
              if (exe) setBlender(exe);
            }}
          >
            Browse…
          </button>
        </div>
      </div>
    </GlassCard>
  );
}

function JobCard() {
  const { blendFile, form, setForm } = useBlenderStore();
  const writes = !form.analyseOnly;
  return (
    <GlassCard title="Pack job" className="flex flex-col">
      <div className="flex flex-col gap-3 p-3">
        <div>
          <FieldLabel>.blend file</FieldLabel>
          <div className="flex items-center gap-2">
            {blendFile ? <PathText path={blendFile} className="flex-1 text-ink" /> : <span className="flex-1 text-[12px] text-ink-faint">Drop a .blend file or open one</span>}
            <button type="button" className="btn h-7 px-2" onClick={() => pickPaths("files", [{ name: "Blender scene", extensions: ["blend"] }])}>
              <FolderOpen className="size-3.5" /> Open
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel>Operations</FieldLabel>
          <Checkbox checked={form.analyseOnly} onChange={(analyseOnly) => setForm({ analyseOnly })} label="Analyse only" hint="Report dependencies without changing anything" />
          <Checkbox checked={form.consolidate} disabled={!writes} onChange={(consolidate) => setForm({ consolidate })} label="Consolidate" hint="Copy external files into //textures and remap" />
          <Checkbox checked={form.unpack} disabled={!writes} onChange={(unpack) => setForm({ unpack })} label="Unpack embedded files" hint="Write packed images out to //textures" />
          <Checkbox checked={form.makeRelative} disabled={!writes} onChange={(makeRelative) => setForm({ makeRelative })} label="Make paths relative" />
          <Checkbox checked={form.packAll} disabled={!writes} onChange={(packAll) => setForm({ packAll })} label="Pack everything into the .blend" />
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel>Output</FieldLabel>
          <Checkbox checked={form.saveAsNew} disabled={!writes} onChange={(saveAsNew) => setForm({ saveAsNew })} label="Save as a new file" hint={form.saveAsNew ? undefined : "Overwrites the original; Blender keeps a .blend1"} />
          {form.saveAsNew && writes && (
            <SavePathField value={form.outputPath} onChange={(outputPath) => setForm({ outputPath })} filters={[{ name: "Blender scene", extensions: ["blend"] }]} />
          )}
          <Checkbox checked={form.makeZip} disabled={!writes} onChange={(makeZip) => setForm({ makeZip })} label="Bundle a zip" hint="The .blend plus textures/ and assets/" />
          {form.makeZip && writes && <SavePathField value={form.zipPath} onChange={(zipPath) => setForm({ zipPath })} filters={[{ name: "Zip", extensions: ["zip"] }]} />}
        </div>

      </div>
    </GlassCard>
  );
}

/** Progress and the run / cancel button, pinned below the scrolling form. */
function RunBar() {
  const { blendFile, blenderPath, form, running, progress, run, cancel } = useBlenderStore();
  return (
    <GlassCard className="flex shrink-0 flex-col gap-2 p-3">
      {running && (
        <div className="flex flex-col gap-1.5">
          <ProgressBar value={progress?.done ?? 0} total={progress?.total ?? 0} indeterminate={!progress} />
          <div className="truncate text-[11.5px] text-ink-muted">{progress ? `${progress.done}/${progress.total} · ${progress.message}` : "Starting Blender…"}</div>
        </div>
      )}
      {running ? (
        <button type="button" className="btn h-8 justify-center" onClick={() => void cancel()}>
          <Ban className="size-3.5" /> Cancel
        </button>
      ) : (
        <button type="button" className="btn btn-primary h-8 justify-center" disabled={!blendFile || !blenderPath} onClick={() => void run()}>
          <Play className="size-3.5" /> {form.analyseOnly ? "Analyse" : "Run pack"}
        </button>
      )}
    </GlassCard>
  );
}

function SavePathField({ value, onChange, filters }: { value: string; onChange: (v: string) => void; filters: { name: string; extensions: string[] }[] }) {
  return (
    <div className="flex gap-1.5 pl-5">
      <TextField mono className="flex-1" value={value} onChange={(e) => onChange(e.target.value)} />
      <button
        type="button"
        className="btn px-2"
        aria-label="Browse"
        onClick={async () => {
          const p = await pickSavePath(value || undefined, filters);
          if (p) onChange(p);
        }}
      >
        <FolderOpen className="size-3.5" />
      </button>
    </div>
  );
}

function ResultPanel() {
  const { result, running, blendFile } = useBlenderStore();
  const report = result?.report;
  const deps = report?.after ?? report?.before ?? [];

  return (
    <GlassCard
      className="flex min-w-0 flex-1 flex-col"
      title="Report"
      actions={
        result &&
        (result.ok ? (
          <PillBadge tone="emerald">
            <CircleCheck className="size-3" /> OK
          </PillBadge>
        ) : (
          <PillBadge tone="rose">{result.cancelled ? "Cancelled" : "Failed"}</PillBadge>
        ))
      }
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {!result ? (
          <EmptyState icon={running ? <Loader2 className="size-5 animate-spin" /> : <Package className="size-5" />} title={running ? "Blender is working…" : blendFile ? `Ready to process ${basename(blendFile)}` : "No job yet"}>
            Blender runs headless in the background; the log drawer shows its output live.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3 p-3">
            {result.error && <div className="rounded-lg border border-rose/30 bg-rose/8 px-3 py-2 text-[12px] text-rose select-text">{result.error}</div>}
            {report && (
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <PillBadge>Blender {report.blender_version}</PillBadge>
                <PillBadge tone={report.missing?.length ? "rose" : "emerald"}>{report.missing?.length ?? 0} missing</PillBadge>
                <PillBadge>{deps.length} dependencies</PillBadge>
                {report.blend && <PathText path={report.blend} className="text-ink-faint" />}
              </div>
            )}
            {result.archive && (
              <div className="flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/6 px-3 py-2 text-[12px]">
                <FileArchive className="size-4 text-accent" />
                <PathText path={result.archive} className="text-ink" />
              </div>
            )}
            {deps.length > 0 && <DependencyTable deps={deps} />}
            {report?.steps && report.steps.length > 0 && (
              <div>
                <FieldLabel>Steps</FieldLabel>
                <ul className="list-inside list-disc text-[12px] text-ink-muted">
                  {report.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function DependencyTable({ deps }: { deps: BlenderDependency[] }) {
  return (
    <table className="w-full table-fixed border-collapse text-[12px]">
      <thead className="text-left text-[11px] tracking-wide text-ink-faint uppercase">
        <tr className="border-b border-edge">
          <th className="w-[22%] py-2 pr-2 font-medium">Data-block</th>
          <th className="py-2 pr-2 font-medium">Path</th>
          <th className="w-40 py-2 font-medium">State</th>
        </tr>
      </thead>
      <tbody>
        {deps.map((d) => (
          <tr key={`${d.type}:${d.name}`} className="border-b border-edge/60 align-top">
            <td className="py-1.5 pr-2">
              <div className="truncate text-ink">{d.name}</div>
              <div className="text-[11px] text-ink-faint">{d.type}</div>
            </td>
            <td className="truncate py-1.5 pr-2 font-mono text-[11.5px] text-ink-muted" title={d.abspath}>
              {d.filepath || "(none)"}
            </td>
            <td className="py-1.5">
              <div className="flex flex-wrap gap-1">
                {d.packed ? <PillBadge tone="accent">packed</PillBadge> : d.exists ? <PillBadge tone="emerald">found</PillBadge> : <PillBadge tone="rose">missing</PillBadge>}
                <PillBadge tone={d.relative ? "emerald" : "amber"}>{d.relative ? "relative" : "absolute"}</PillBadge>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
