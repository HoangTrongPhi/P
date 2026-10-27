import { ArrowDown, ArrowUp, CircleCheck, CircleSlash, Copy, Download, FileJson, FolderOpen, ListChecks, Loader2, Play, Plus, Save, Terminal, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { pickOne } from "../../lib/dialogs";
import { recipeRunReport } from "../../lib/reportBuilders";
import { exportReport } from "../../lib/reports";
import { uiLog } from "../../stores/appStore";
import { cliCommand, STEP_INFO, TEMPLATES, useRecipeStore, type StepItem } from "../../stores/recipeStore";
import type { ConvertFormat, FbxFixMode, RecipeStep, RecipeStepKind, RenameRuleSpec, StepOutcome } from "../../types/pipeline";
import { Checkbox, EmptyState, FieldLabel, PathText, ProgressBar, Segmented, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge } from "../ui/PillBadge";

const SELECT = "h-7 rounded-md border border-edge bg-canvas/70 px-1.5 text-[12px] text-ink outline-none focus:border-accent/60";
const KINDS = Object.keys(STEP_INFO) as RecipeStepKind[];

export function RecipesTab() {
  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <EditorCard />
      <RunCard />
    </div>
  );
}

// ---------------------------------------------------------------- editor

function EditorCard() {
  const s = useRecipeStore();
  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          <ListChecks className="size-3.5" /> Recipe
        </span>
      }
      actions={
        <>
          <select className={SELECT} value="" onChange={(e) => e.target.value && s.applyTemplate(e.target.value)} aria-label="Start from a template">
            <option value="">Templates…</option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.recipe.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn h-7" onClick={() => void s.open()}>
            <FileJson className="size-3.5" /> Open
          </button>
          <button type="button" className="btn h-7" onClick={() => void s.save()} disabled={!s.steps.length}>
            <Save className="size-3.5" /> Save
          </button>
        </>
      }
      className="flex w-[480px] shrink-0 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div>
          <FieldLabel>Name</FieldLabel>
          <TextField className="w-full" value={s.name} onChange={(e) => s.setName(e.target.value)} placeholder="My import recipe" />
          {s.file && <PathText path={s.file} className="mt-1 block text-ink-faint" />}
        </div>
        {s.steps.map((it, i) => (
          <StepCard key={it.id} item={it} index={i} last={i === s.steps.length - 1} />
        ))}
        {s.steps.length === 0 && <div className="rounded-lg border border-dashed border-edge px-3 py-6 text-center text-[12px] text-ink-faint">No steps yet. Add one below or start from a template.</div>}
        <label className="flex items-center gap-2">
          <Plus className="size-3.5 text-ink-faint" />
          <select className={cn(SELECT, "flex-1")} value="" onChange={(e) => e.target.value && s.addStep(e.target.value as RecipeStepKind)} aria-label="Add a step">
            <option value="">Add step…</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {STEP_INFO[k].title} — {STEP_INFO[k].description}
              </option>
            ))}
          </select>
        </label>
      </div>
    </GlassCard>
  );
}

function StepCard({ item, index, last }: { item: StepItem; index: number; last: boolean }) {
  const { moveStep, removeStep } = useRecipeStore();
  const info = STEP_INFO[item.step.kind];
  return (
    <div className="rounded-lg border border-edge bg-panel-raised/50">
      <div className="flex items-center gap-2 border-b border-edge px-2.5 py-1.5">
        <span className="grid size-5 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-ink">{info.title}</div>
          <div className="truncate text-[11px] text-ink-faint">{info.description}</div>
        </div>
        <button type="button" className="icon-btn size-6" aria-label="Move up" disabled={index === 0} onClick={() => moveStep(item.id, -1)}>
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" className="icon-btn size-6" aria-label="Move down" disabled={last} onClick={() => moveStep(item.id, 1)}>
          <ArrowDown className="size-3.5" />
        </button>
        <button type="button" className="icon-btn size-6 hover:text-rose" aria-label="Remove step" onClick={() => removeStep(item.id)}>
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        <StepEditor item={item} />
      </div>
    </div>
  );
}

function describeRule(r: RenameRuleSpec): string {
  switch (r.kind) {
    case "preset":
      return `${r.preset === "ue5" ? "UE5" : "Unity"} naming preset`;
    case "prefix":
      return `prefix “${r.prefix}”`;
    case "suffix":
      return `suffix “${r.suffix}”`;
    case "case":
      return `${r.style} case`;
    case "searchReplace":
      return `replace “${r.find}” → “${r.replace ?? ""}”${r.regex ? " (regex)" : ""}`;
  }
}

const SIZES = [0, 8192, 4096, 2048, 1024, 512];
const FORMATS: ConvertFormat[] = ["keep", "png", "tga", "jpg", "dds"];

function StepEditor({ item }: { item: StepItem }) {
  const { updateStep, importRenamerRules } = useRecipeStore();
  const step = item.step;
  const update = (s: RecipeStep) => updateStep(item.id, s);
  switch (step.kind) {
    case "rename": {
      const preset = step.rules.length === 1 && step.rules[0].kind === "preset" ? step.rules[0].preset : "custom";
      return (
        <>
          <div className="flex items-center gap-2">
            <Segmented
              size="sm"
              value={preset}
              onChange={(v) => v !== "custom" && update({ ...step, rules: [{ kind: "preset", preset: v }] })}
              options={[
                { value: "ue5", label: "UE5 preset" },
                { value: "unity", label: "Unity preset" },
                ...(preset === "custom" ? [{ value: "custom" as const, label: "Custom" }] : []),
              ]}
            />
            <button type="button" className="btn ml-auto h-6 px-2" onClick={() => importRenamerRules(item.id)} title="Copy the enabled rules from the Renamer tab">
              Use Renamer rules
            </button>
          </div>
          <div className="text-[11.5px] text-ink-muted">{step.rules.map(describeRule).join(" → ")}</div>
          <Checkbox checked={step.recursive !== false} onChange={(v) => update({ ...step, recursive: v })} label="Include subfolders" />
        </>
      );
    }
    case "fbxFix": {
      const o = step.options ?? {};
      return (
        <>
          <Segmented<FbxFixMode>
            size="sm"
            value={o.mode ?? "relative"}
            onChange={(mode) => update({ ...step, options: { ...o, mode } })}
            options={[
              { value: "relative", label: "Relative", hint: "Path from the FBX to the texture" },
              { value: "strip", label: "Strip", hint: "File name only" },
              { value: "collect", label: "Collect", hint: "Copy textures next to the FBX" },
            ]}
          />
          {o.mode === "collect" && (
            <label className="flex items-center gap-2 text-[12px] text-ink-muted">
              Subfolder
              <TextField mono className="flex-1" value={o.subfolder ?? "textures"} onChange={(e) => update({ ...step, options: { ...o, subfolder: e.target.value } })} />
            </label>
          )}
          <Checkbox checked={!!o.guessMissing} onChange={(v) => update({ ...step, options: { ...o, guessMissing: v } })} label="Rewrite textures that cannot be found" hint="To <subfolder>/<name>; off leaves them as they are" />
        </>
      );
    }
    case "packOrm":
      return (
        <div className="flex items-center gap-3">
          <Segmented size="sm" value={step.format ?? "png"} onChange={(format) => update({ ...step, format })} options={[{ value: "png", label: "PNG" }, { value: "tga", label: "TGA" }]} />
          <Checkbox checked={!!step.overwrite} onChange={(v) => update({ ...step, overwrite: v })} label="Replace existing ORM files" />
        </div>
      );
    case "convertTextures": {
      const o = step.options ?? {};
      const set = (patch: typeof o) => update({ ...step, options: { ...o, ...patch } });
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <select className={SELECT} value={o.maxSize ?? 0} onChange={(e) => set({ maxSize: Number(e.target.value) || null })} aria-label="Max size">
              {SIZES.map((n) => (
                <option key={n} value={n}>
                  {n ? `Max ${n} px` : "Keep size"}
                </option>
              ))}
            </select>
            <select className={SELECT} value={o.format ?? "keep"} onChange={(e) => set({ format: e.target.value as ConvertFormat })} aria-label="Format">
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f === "keep" ? "Same format" : f.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Checkbox checked={!!o.powerOfTwo} onChange={(v) => set({ powerOfTwo: v })} label="Power of two" />
            <Checkbox checked={!!o.flipGreen} onChange={(v) => set({ flipGreen: v })} label="Flip green (normal DX ↔ GL)" />
            <Checkbox checked={!!o.overwrite} onChange={(v) => set({ overwrite: v })} label="Overwrite" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col text-[11px] text-ink-faint">
              Name contains
              <TextField mono value={step.nameContains ?? ""} placeholder="any" onChange={(e) => update({ ...step, nameContains: e.target.value })} />
            </label>
            <label className="flex flex-col text-[11px] text-ink-faint">
              Output folder
              <TextField mono value={o.outputDir ?? "converted"} onChange={(e) => set({ outputDir: e.target.value })} />
            </label>
            <label className="flex flex-col text-[11px] text-ink-faint">
              Suffix
              <TextField mono value={o.suffix ?? ""} placeholder="none" onChange={(e) => set({ suffix: e.target.value })} />
            </label>
          </div>
        </>
      );
    }
    case "inspectMeshes":
      return (
        <label className="flex items-center gap-2 text-[12px] text-ink-muted">
          Triangle budget per file
          <TextField className="w-28" inputMode="numeric" placeholder="none" value={step.triBudget ?? ""} onChange={(e) => update({ ...step, triBudget: Number(e.target.value.replace(/\D/g, "")) || null })} />
        </label>
      );
    case "findUnused":
      return <Checkbox checked={!!step.includeBlend} onChange={(v) => update({ ...step, includeBlend: v })} label="Also read .blend files" hint="Needs Blender 5.0+; one headless run per file" />;
    case "findDuplicates":
      return <div className="text-[11.5px] text-ink-faint">Byte-identical files under the folder (XXH3-128).</div>;
  }
}

// ---------------------------------------------------------------- run

function RunCard() {
  const s = useRecipeStore();
  const cmd = cliCommand(s.file, s.folder, s.dryRun);
  return (
    <GlassCard
      title="Run"
      actions={
        <button type="button" className="btn h-6 px-2" disabled={!s.result} onClick={() => s.result && void exportReport(recipeRunReport(s.result))} title="Save as HTML or CSV">
          <Download className="size-3" /> Export
        </button>
      }
      className="flex min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <FolderOpen className="size-4 shrink-0 text-ink-faint" />
        {s.folder ? <PathText path={s.folder} className="min-w-0 flex-1 text-ink" /> : <span className="flex-1 text-[12px] text-ink-faint">Drop the asset folder to process, or choose one</span>}
        <button type="button" className="btn" onClick={async () => { const f = await pickOne("folder"); if (f) s.setFolder(f); }}>
          Choose…
        </button>
        <Checkbox checked={s.dryRun} onChange={s.setDryRun} label="Dry run" hint="Show what would change; nothing is written" />
        <button type="button" className={cn("btn", s.dryRun ? "btn-primary" : "border-amber/40 bg-amber/15 text-amber hover:bg-amber/25")} disabled={!s.folder || !s.steps.length || s.running} onClick={() => void s.run()}>
          {s.running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {s.dryRun ? "Preview run" : "Run for real"}
        </button>
      </div>
      {s.running && s.progress && (
        <div className="flex flex-col gap-1.5 border-b border-edge px-4 py-2">
          <div className="text-[12px] text-ink-muted">
            Step {Math.min(s.progress.done + 1, s.progress.total)} of {s.progress.total}: {s.progress.message}
          </div>
          <ProgressBar value={s.progress.done} total={s.progress.total} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {s.result ? (
          <div className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <PillBadge tone={s.result.ok ? "emerald" : "rose"}>{s.result.ok ? "All steps OK" : "Stopped after a failed step"}</PillBadge>
              {s.result.dryRun && <PillBadge tone="accent">Dry run: nothing changed</PillBadge>}
              <span className="text-[11.5px] text-ink-faint">{s.result.elapsedMs} ms</span>
            </div>
            {s.result.steps.map((o, i) => (
              <OutcomeRow key={i} index={i} outcome={o} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<ListChecks className="size-5" />} title="Run a recipe on a folder">
            Steps run in order and each one sees what the previous step changed. Start with a dry run: it lists every rename, path fix and new texture without touching your files.
          </EmptyState>
        )}
      </div>
      <CliHint command={cmd} saved={!!s.file} />
    </GlassCard>
  );
}

function OutcomeRow({ index, outcome: o }: { index: number; outcome: StepOutcome }) {
  const [open, setOpen] = useState(!o.ok && !o.skipped);
  const Icon = o.ok ? CircleCheck : o.skipped ? CircleSlash : TriangleAlert;
  return (
    <div className="rounded-lg border border-edge bg-panel-raised/40">
      <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left" onClick={() => setOpen((v) => !v)} disabled={!o.details.length}>
        <Icon className={cn("mt-0.5 size-4 shrink-0", o.ok ? "text-emerald" : o.skipped ? "text-ink-faint" : "text-rose")} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-ink">
            {index + 1}. {o.title}
          </span>
          <span className={cn("block text-[12px]", o.ok ? "text-ink-muted" : o.skipped ? "text-ink-faint" : "text-rose")}>{o.summary}</span>
        </span>
        <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
          {o.details.length > 0 && `${o.details.length} line(s) · `}
          {o.elapsedMs} ms
        </span>
      </button>
      {open && o.details.length > 0 && (
        <div className="max-h-64 overflow-y-auto border-t border-edge px-3 py-2 font-mono text-[11px] leading-[17px] text-ink-muted select-text">
          {o.details.map((d, i) => (
            <div key={i} className={cn("break-all", d.trimStart().startsWith("!") && "text-amber")}>
              {d}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CliHint({ command, saved }: { command: string; saved: boolean }) {
  return (
    <div className="flex items-center gap-2 border-t border-edge px-4 py-2">
      <Terminal className="size-3.5 shrink-0 text-ink-faint" />
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted select-text" title={command}>
        {command}
      </code>
      {!saved && <span className="shrink-0 text-[11px] text-ink-faint">save the recipe first</span>}
      <button
        type="button"
        className="icon-btn size-6"
        title="Copy command line"
        onClick={() => navigator.clipboard.writeText(command).then(() => uiLog("info", "Command copied"), (e) => uiLog("error", String(e)))}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}
