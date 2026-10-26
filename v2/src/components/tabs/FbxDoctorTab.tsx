import { ArchiveRestore, ArrowRight, CircleCheck, Eye, FileWarning, FolderOpen, Files, Loader2, RefreshCw, Stethoscope, TriangleAlert, Wrench, X } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { pickOne, pickPaths } from "../../lib/dialogs";
import { basename } from "../../lib/pathUtil";
import { useFbxStore } from "../../stores/fbxStore";
import type { FbxFixMode, FbxFixResult, FbxPathKind, FbxResolution } from "../../types/pipeline";
import { Checkbox, EmptyState, FieldLabel, PathText, Segmented, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge, type PillTone } from "../ui/PillBadge";

const KIND: Record<FbxPathKind, [string, PillTone]> = {
  ABSOLUTE_LOCAL: ["Absolute", "rose"],
  UNC_NETWORK: ["UNC", "amber"],
  RELATIVE_PORTABLE: ["Relative", "emerald"],
  EMPTY: ["Empty", "neutral"],
};

const RESOLUTION: Record<FbxResolution, [string, PillTone]> = {
  found: ["Found", "emerald"],
  found_by_name: ["By name", "amber"],
  missing: ["Missing", "rose"],
  embedded: ["Embedded", "accent"],
};

const MODES: { value: FbxFixMode; label: string; hint: string }[] = [
  { value: "relative", label: "Relative", hint: "Path from the FBX to where the texture really is" },
  { value: "strip", label: "Strip", hint: "Keep only the file name" },
  { value: "collect", label: "Collect", hint: "Copy textures next to the FBX and point there" },
];

export function FbxDoctorTab() {
  const sources = useFbxStore((s) => s.sources);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <SourceBar />
      {sources.length === 0 ? (
        <GlassCard className="flex flex-1 items-center justify-center">
          <EmptyState icon={<Stethoscope className="size-5" />} title="Drop FBX files or folders">
            Binary (7.x, 32 and 64-bit) and ASCII FBX are scanned for texture paths. Absolute and broken paths are fixed in place, with a
            .fbx.bak backup of every file.
          </EmptyState>
        </GlassCard>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <FileList />
          <EntriesPanel />
          <FixPanel />
        </div>
      )}
    </div>
  );
}

function SourceBar() {
  const { sources, files, scanning, rescan, clear } = useFbxStore();
  const issues = files.filter((f) => f.hasIssues).length;
  return (
    <GlassCard className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Stethoscope className="size-4 shrink-0 text-ink-faint" />
        {sources.length ? (
          <>
            <PathText path={sources.length === 1 ? sources[0] : `${sources.length} items`} className="text-ink" />
            <PillBadge>{files.length} FBX</PillBadge>
            {issues > 0 ? <PillBadge tone="rose">{issues} with issues</PillBadge> : files.length > 0 && <PillBadge tone="emerald">all portable</PillBadge>}
          </>
        ) : (
          <span className="text-[12.5px] text-ink-faint">No FBX loaded.</span>
        )}
      </div>
      <div className="flex gap-2">
        {sources.length > 0 && (
          <>
            <button type="button" className="btn" onClick={() => void rescan()} disabled={scanning}>
              <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} /> Rescan
            </button>
            <button type="button" className="icon-btn" onClick={clear} aria-label="Clear" title="Clear">
              <X className="size-3.5" />
            </button>
          </>
        )}
        <button type="button" className="btn" onClick={() => pickPaths("folder")}>
          <FolderOpen className="size-3.5" /> Open folder
        </button>
        <button type="button" className="btn" onClick={() => pickPaths("files", [{ name: "FBX", extensions: ["fbx"] }])}>
          <Files className="size-3.5" /> Open FBX
        </button>
      </div>
    </GlassCard>
  );
}

function FileList() {
  const { files, selected, select, scanning } = useFbxStore();
  return (
    <GlassCard title={<span className="flex items-center gap-2">Files {scanning && <Loader2 className="size-3.5 animate-spin text-accent" />}</span>} className="flex w-64 shrink-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={() => select(f.path)}
            title={f.path}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
              f.path === selected ? "bg-accent/12 ring-1 ring-accent/25" : "hover:bg-white/4",
            )}
          >
            {f.error ? (
              <TriangleAlert className="size-4 shrink-0 text-rose" />
            ) : f.hasIssues ? (
              <FileWarning className="size-4 shrink-0 text-amber" />
            ) : (
              <CircleCheck className="size-4 shrink-0 text-emerald" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-ink">{basename(f.path)}</span>
              <span className="block truncate text-[11px] text-ink-faint">{f.error ? "Unreadable" : `${f.isBinary ? "Binary" : "ASCII"} ${f.version} · ${f.entries.length} path(s)`}</span>
            </span>
            {f.problemCount > 0 && <PillBadge tone="rose">{f.problemCount}</PillBadge>}
          </button>
        ))}
        {!files.length && !scanning && <div className="px-3 py-6 text-center text-[12px] text-ink-faint">No .fbx files found.</div>}
      </div>
    </GlassCard>
  );
}

function EntriesPanel() {
  const { files, selected, restore } = useFbxStore();
  const file = files.find((f) => f.path === selected);
  return (
    <GlassCard
      className="flex min-w-0 flex-1 flex-col"
      title={file ? basename(file.path) : "Texture paths"}
      actions={
        file && (
          <button type="button" className="btn h-6 px-2" onClick={() => void restore(file.path)} title="Restore this file from its .fbx.bak">
            <ArchiveRestore className="size-3.5" /> Restore backup
          </button>
        )
      }
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {!file ? (
          <EmptyState icon={<Stethoscope className="size-5" />} title="Select a file" />
        ) : file.error ? (
          <div className="m-3 rounded-lg border border-rose/30 bg-rose/8 px-3 py-2 text-[12px] text-rose select-text">{file.error}</div>
        ) : file.entries.length === 0 ? (
          <EmptyState icon={<CircleCheck className="size-5" />} title="No texture paths in this file" />
        ) : (
          <table className="w-full table-fixed border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] tracking-wide text-ink-faint uppercase">
              <tr className="border-b border-edge">
                <th className="w-[22%] px-3 py-2 font-medium">Object / field</th>
                <th className="px-2 py-2 font-medium">Path in file</th>
                <th className="w-20 px-2 py-2 font-medium">Kind</th>
                <th className="w-24 px-2 py-2 font-medium">On disk</th>
              </tr>
            </thead>
            <tbody>
              {file.entries.map((e, i) => (
                <tr key={i} className={cn("border-b border-edge/60 align-top", e.isProblem && "bg-rose/[0.03]")}>
                  <td className="px-3 py-1.5">
                    <div className="truncate text-ink" title={e.nodeName}>
                      {e.nodeName}
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-faint">{e.propertyName}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="truncate font-mono text-[11.5px] text-ink-muted select-text" title={e.originalPath}>
                      {e.originalPath || <span className="text-ink-faint">(empty)</span>}
                    </div>
                    {e.resolvedPath && e.resolution !== "found" && (
                      <div className="truncate font-mono text-[11px] text-ink-faint" title={e.resolvedPath}>
                        → {e.resolvedPath}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <PillBadge tone={KIND[e.kind][1]}>{KIND[e.kind][0]}</PillBadge>
                  </td>
                  <td className="px-2 py-1.5">{e.kind !== "EMPTY" && <PillBadge tone={RESOLUTION[e.resolution][1]}>{RESOLUTION[e.resolution][0]}</PillBadge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </GlassCard>
  );
}

function FixPanel() {
  const s = useFbxStore();
  const targets = useMemo(
    () => (s.scope === "selected" ? s.files.filter((f) => f.path === s.selected) : s.files.filter((f) => !f.error && (s.fixAll || f.hasIssues))),
    [s.files, s.selected, s.scope, s.fixAll],
  );
  const shown = s.preview ?? s.lastResult;

  return (
    <GlassCard title="Fix" className="flex w-[300px] shrink-0 flex-col">
      <div className="flex flex-col gap-3 border-b border-edge p-3">
        <div>
          <FieldLabel>Mode</FieldLabel>
          <Segmented value={s.mode} onChange={(mode) => s.setOptions({ mode })} options={MODES} />
          <div className="mt-1 text-[11px] text-ink-faint">{MODES.find((m) => m.value === s.mode)?.hint}</div>
        </div>
        {s.mode !== "strip" && (
          <div>
            <FieldLabel>{s.mode === "collect" ? "Texture subfolder" : "Fallback subfolder (missing textures)"}</FieldLabel>
            <TextField mono className="w-full" value={s.subfolder} onChange={(e) => s.setOptions({ subfolder: e.target.value })} />
          </div>
        )}
        {s.mode === "relative" && (
          <div>
            <FieldLabel>Rebase to folder (optional)</FieldLabel>
            <div className="flex gap-1.5">
              <TextField mono className="flex-1" value={s.rebaseDir ?? ""} placeholder="Use each texture's found location" onChange={(e) => s.setOptions({ rebaseDir: e.target.value || null })} />
              <button type="button" className="btn px-2" onClick={async () => { const d = await pickOne("folder"); if (d) s.setOptions({ rebaseDir: d }); }} aria-label="Browse">
                <FolderOpen className="size-3.5" />
              </button>
            </div>
          </div>
        )}
        <Segmented
          size="sm"
          value={s.scope}
          onChange={(scope) => s.setOptions({ scope })}
          options={[
            { value: "issues", label: "All files" },
            { value: "selected", label: "Selected file" },
          ]}
        />
        <Checkbox checked={s.fixAll} onChange={(fixAll) => s.setOptions({ fixAll })} label="Rewrite every path" hint="Not only absolute or broken ones" />
        <Checkbox checked={s.backup} onChange={(backup) => s.setOptions({ backup })} label="Keep .fbx.bak backup" />
        <div className="flex gap-2">
          <button type="button" className="btn flex-1 justify-center" disabled={!targets.length || s.fixing} onClick={() => void s.runFix(true)}>
            <Eye className="size-3.5" /> Preview
          </button>
          <button type="button" className="btn btn-primary flex-1 justify-center" disabled={!targets.length || s.fixing} onClick={() => void s.runFix(false)}>
            {s.fixing ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
            Fix {targets.length} file{targets.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {shown ? <FixResultView result={shown} isPreview={shown === s.preview} /> : <div className="text-[11.5px] text-ink-faint">Preview shows every path change before files are written.</div>}
      </div>
    </GlassCard>
  );
}

function FixResultView({ result, isPreview }: { result: FbxFixResult; isPreview: boolean }) {
  const changed = result.reports.filter((r) => r.changes.length || r.copied.length || r.warnings.length);
  const total = result.reports.reduce((n, r) => n + r.changes.length, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] font-medium text-ink">
        {isPreview ? `Would rewrite ${total} path(s)` : `Rewrote ${total} path(s)`} in {changed.length} file(s)
      </div>
      {result.errors.map((e) => (
        <div key={e.path} className="rounded-md border border-rose/30 bg-rose/8 px-2 py-1.5 text-[11.5px] text-rose">
          {basename(e.path)}: {e.error}
        </div>
      ))}
      {changed.map((r) => (
        <ReportCard key={r.path} report={r} />
      ))}
    </div>
  );
}

function ReportCard({ report }: { report: FbxFixResult["reports"][number] }) {
  const unique = [...new Map(report.changes.map((c) => [`${c.old}→${c.new}`, c])).values()];
  return (
    <div className="rounded-lg border border-edge bg-panel-raised/50 p-2">
      <div className="mb-1 truncate text-[12px] font-medium text-ink" title={report.path}>
        {basename(report.path)}
      </div>
      {unique.map((c) => (
        <div key={`${c.old}→${c.new}`} className="mb-1 font-mono text-[11px] leading-snug">
          <div className="truncate text-ink-faint line-through" title={c.old}>
            {c.old}
          </div>
          <div className="flex items-center gap-1 truncate text-emerald" title={c.new}>
            <ArrowRight className="size-3 shrink-0" />
            {c.new}
          </div>
        </div>
      ))}
      {report.copied.length > 0 && <div className="text-[11px] text-accent">{report.copied.length} texture(s) copied</div>}
      {report.warnings.map((w) => (
        <div key={w} className="mt-1 flex gap-1 text-[11px] text-amber">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          {w}
        </div>
      ))}
    </div>
  );
}
