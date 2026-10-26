import { ArrowDown, ArrowRight, ArrowUp, FolderOpen, Files, Loader2, Plus, RotateCcw, TextCursorInput, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { pickPaths } from "../../lib/dialogs";
import { useRenamerStore, type AssetFilter, type RuleItem } from "../../stores/renamerStore";
import type { CaseStyle, RenameRow, RenameRuleSpec } from "../../types/pipeline";
import { Checkbox, EmptyState, PathText, Segmented, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge, type PillTone } from "../ui/PillBadge";

const MAX_ROWS = 1500;

const STATUS_TONE: Record<RenameRow["status"], PillTone> = { OK: "emerald", Skipped: "neutral", Collision: "amber", Invalid: "rose" };

const NEW_RULES: { label: string; spec: RenameRuleSpec }[] = [
  { label: "Preset: Unreal Engine 5", spec: { kind: "preset", preset: "ue5" } },
  { label: "Preset: Unity", spec: { kind: "preset", preset: "unity" } },
  { label: "Search & replace", spec: { kind: "searchReplace", find: "", replace: "", regex: false, caseSensitive: true } },
  { label: "Prefix", spec: { kind: "prefix", prefix: "", skipIfPresent: true } },
  { label: "Suffix", spec: { kind: "suffix", suffix: "", skipIfPresent: true } },
  { label: "Change case", spec: { kind: "case", style: "snake" } },
];

const CASES: { value: CaseStyle; label: string }[] = [
  { value: "snake", label: "snake_case" },
  { value: "camel", label: "camelCase" },
  { value: "pascal", label: "PascalCase" },
  { value: "upper", label: "UPPER_CASE" },
  { value: "lower", label: "lowercase" },
  { value: "kebab", label: "kebab-case" },
];

export function RenamerTab() {
  const s = useRenamerStore();
  const { folder, files, recursive, filter, rules, refresh } = s;

  // Live dry run: re-plan shortly after any input changes.
  useEffect(() => {
    if (!folder) return;
    const t = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(t);
  }, [folder, files, recursive, filter, rules, refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <SourceBar />
      <div className="flex min-h-0 flex-1 gap-3">
        <RulesPanel />
        <PreviewPanel />
      </div>
    </div>
  );
}

function SourceBar() {
  const { folder, files, recursive, filter, setRecursive, setFilter } = useRenamerStore();
  return (
    <GlassCard className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-ink-faint" />
        {folder ? (
          <>
            <PathText path={folder} className="text-ink" />
            {files && <PillBadge tone="accent">{files.length} selected file(s)</PillBadge>}
          </>
        ) : (
          <span className="text-[12.5px] text-ink-faint">Drop a folder (or files) here, or open one to start renaming.</span>
        )}
      </div>
      <Segmented<AssetFilter>
        size="sm"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "mesh", label: "Meshes" },
          { value: "texture", label: "Textures" },
          { value: "source", label: "PSD" },
        ]}
      />
      <Checkbox checked={recursive} onChange={setRecursive} label="Subfolders" disabled={!!files} />
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={() => pickPaths("folder")}>
          <FolderOpen className="size-3.5" /> Open folder
        </button>
        <button type="button" className="btn" onClick={() => pickPaths("files")}>
          <Files className="size-3.5" /> Files
        </button>
      </div>
    </GlassCard>
  );
}

function RulesPanel() {
  const { rules, addRule } = useRenamerStore();
  const [menu, setMenu] = useState(false);
  return (
    <GlassCard
      title="Rules"
      className="flex w-[340px] shrink-0 flex-col"
      actions={
        <div className="relative">
          <button type="button" className="btn h-6 px-2" onClick={() => setMenu((m) => !m)}>
            <Plus className="size-3.5" /> Add
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-edge-strong bg-panel-raised p-1 shadow-xl animate-pop-in">
                {NEW_RULES.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => {
                      addRule(structuredClone(r.spec));
                      setMenu(false);
                    }}
                    className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-muted hover:bg-white/6 hover:text-ink"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {rules.length === 0 && <div className="py-6 text-center text-[12px] text-ink-faint">No rules — names stay unchanged.</div>}
        {rules.map((r, i) => (
          <RuleCard key={r.id} rule={r} index={i} last={i === rules.length - 1} />
        ))}
        <div className="mt-auto pt-2 text-[11px] leading-relaxed text-ink-faint">
          Rules run top to bottom on the file name without its extension. Regex replacements use <code className="text-ink-muted">$1</code> or{" "}
          <code className="text-ink-muted">{"${1}"}</code>.
        </div>
      </div>
    </GlassCard>
  );
}

function ruleTitle(spec: RenameRuleSpec): string {
  switch (spec.kind) {
    case "preset":
      return spec.preset === "ue5" ? "Unreal Engine 5 preset" : "Unity preset";
    case "searchReplace":
      return spec.regex ? "Regex replace" : "Search & replace";
    case "prefix":
      return "Prefix";
    case "suffix":
      return "Suffix";
    case "case":
      return "Change case";
  }
}

function RuleCard({ rule, index, last }: { rule: RuleItem; index: number; last: boolean }) {
  const { updateRule, removeRule, moveRule } = useRenamerStore();
  const spec = rule.spec;
  const patch = (p: Partial<RenameRuleSpec>) => updateRule(rule.id, { spec: { ...spec, ...p } as RenameRuleSpec });

  return (
    <div className={cn("rounded-lg border border-edge bg-panel-raised/60", !rule.enabled && "opacity-50")}>
      <div className="flex h-8 items-center gap-2 border-b border-edge px-2.5">
        <input type="checkbox" className="size-3.5 accent-accent" checked={rule.enabled} onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })} title="Enable rule" />
        <span className="flex-1 truncate text-[12px] font-medium text-ink">
          <span className="mr-1.5 text-ink-faint">{index + 1}.</span>
          {ruleTitle(spec)}
        </span>
        <button type="button" className="icon-btn size-6" disabled={index === 0} onClick={() => moveRule(rule.id, -1)} aria-label="Move up">
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" className="icon-btn size-6" disabled={last} onClick={() => moveRule(rule.id, 1)} aria-label="Move down">
          <ArrowDown className="size-3.5" />
        </button>
        <button type="button" className="icon-btn size-6 hover:text-rose" onClick={() => removeRule(rule.id)} aria-label="Remove rule">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        {spec.kind === "preset" && (
          <>
            <Segmented
              size="sm"
              value={spec.preset}
              onChange={(preset) => patch({ preset })}
              options={[
                { value: "ue5", label: "Unreal Engine 5" },
                { value: "unity", label: "Unity" },
              ]}
            />
            <div className="text-[11px] text-ink-faint">
              {spec.preset === "ue5" ? "SM_ / SK_ meshes, T_Name_D|N|R|M|ORM textures" : "PascalCase, _Albedo / _Normal / _MaskMap textures"}
            </div>
          </>
        )}
        {spec.kind === "searchReplace" && (
          <>
            <div className="grid grid-cols-[52px_1fr] items-center gap-x-2 gap-y-1.5">
              <span className="text-[11.5px] text-ink-faint">Find</span>
              <TextField mono value={spec.find} onChange={(e) => patch({ find: e.target.value })} placeholder={spec.regex ? "(\\d+)" : "old"} />
              <span className="text-[11.5px] text-ink-faint">Replace</span>
              <TextField mono value={spec.replace ?? ""} onChange={(e) => patch({ replace: e.target.value })} placeholder={spec.regex ? "_$1" : "new"} />
            </div>
            <div className="flex gap-4">
              <Checkbox checked={!!spec.regex} onChange={(regex) => patch({ regex })} label="Regex" />
              <Checkbox checked={spec.caseSensitive !== false} onChange={(caseSensitive) => patch({ caseSensitive })} label="Match case" />
            </div>
          </>
        )}
        {(spec.kind === "prefix" || spec.kind === "suffix") && (
          <>
            <TextField
              mono
              value={spec.kind === "prefix" ? spec.prefix : spec.suffix}
              onChange={(e) => patch(spec.kind === "prefix" ? { prefix: e.target.value } : { suffix: e.target.value })}
              placeholder={spec.kind === "prefix" ? "T_" : "_v2"}
            />
            <Checkbox checked={spec.skipIfPresent !== false} onChange={(skipIfPresent) => patch({ skipIfPresent })} label="Skip names that already have it" />
          </>
        )}
        {spec.kind === "case" && (
          <select
            value={spec.style}
            onChange={(e) => patch({ style: e.target.value as CaseStyle })}
            className="h-7 rounded-md border border-edge bg-canvas/70 px-2 text-[12px] text-ink outline-none focus:border-accent/60"
          >
            {CASES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function PreviewPanel() {
  const { folder, rows, loading, busy, error, history, apply, undo } = useRenamerStore();
  const [changedOnly, setChangedOnly] = useState(true);
  const counts = useMemo(() => {
    const c = { OK: 0, Skipped: 0, Collision: 0, Invalid: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);
  const visible = useMemo(() => (changedOnly ? rows.filter((r) => r.status !== "Skipped") : rows), [rows, changedOnly]);

  return (
    <GlassCard
      className="flex min-w-0 flex-1 flex-col"
      title={
        <span className="flex items-center gap-2">
          Preview {loading && <Loader2 className="size-3.5 animate-spin text-accent" />}
        </span>
      }
      actions={
        <>
          <PillBadge tone="emerald">{counts.OK} ready</PillBadge>
          {counts.Collision > 0 && <PillBadge tone="amber">{counts.Collision} collision</PillBadge>}
          {counts.Invalid > 0 && <PillBadge tone="rose">{counts.Invalid} invalid</PillBadge>}
          <PillBadge>{counts.Skipped} unchanged</PillBadge>
        </>
      }
    >
      <div className="flex items-center gap-3 border-b border-edge px-4 py-2">
        <Checkbox checked={changedOnly} onChange={setChangedOnly} label="Hide unchanged" />
        <div className="flex-1" />
        <button type="button" className="btn" disabled={!history.length || busy} onClick={() => void undo()} title={history[0] ? `Undo ${history[0].count} rename(s) from ${new Date(history[0].timestamp * 1000).toLocaleString()}` : "Nothing to undo"}>
          <RotateCcw className="size-3.5" /> Undo{history.length > 0 && ` (${history.length})`}
        </button>
        <button type="button" className="btn btn-primary" disabled={!counts.OK || busy || loading} onClick={() => void apply()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
          Rename {counts.OK} file{counts.OK === 1 ? "" : "s"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && <div className="m-3 rounded-lg border border-rose/30 bg-rose/8 px-3 py-2 text-[12px] text-rose select-text">{error}</div>}
        {!folder ? (
          <EmptyState icon={<TextCursorInput className="size-5" />} title="Nothing loaded">
            Drop a folder of meshes and textures onto the window. The table previews every new name before anything touches the disk.
          </EmptyState>
        ) : visible.length === 0 && !loading ? (
          <EmptyState icon={<TextCursorInput className="size-5" />} title={rows.length ? "All names already match the rules" : "No matching assets"} />
        ) : (
          <table className="w-full table-fixed border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] tracking-wide text-ink-faint uppercase">
              <tr className="border-b border-edge">
                <th className="w-24 px-4 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Current name</th>
                <th className="w-6" />
                <th className="px-2 py-2 font-medium">New name</th>
                <th className="w-[28%] px-2 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, MAX_ROWS).map((r) => (
                <tr key={r.originalPath} className="border-b border-edge/60 hover:bg-white/[0.02]">
                  <td className="px-4 py-1.5">
                    <PillBadge tone={STATUS_TONE[r.status]}>{r.status}</PillBadge>
                  </td>
                  <td className="truncate px-2 py-1.5 font-mono text-[11.5px] text-ink-muted" title={r.originalPath}>
                    {r.originalName}
                  </td>
                  <td>
                    <ArrowRight className="size-3 text-ink-faint" />
                  </td>
                  <td className={cn("truncate px-2 py-1.5 font-mono text-[11.5px]", r.status === "OK" ? "text-ink" : "text-ink-faint")} title={r.newName}>
                    {r.newName}
                  </td>
                  <td className="truncate px-2 py-1.5 text-ink-faint" title={r.reason}>
                    {r.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {visible.length > MAX_ROWS && <div className="px-4 py-2 text-[11.5px] text-ink-faint">Showing the first {MAX_ROWS} of {visible.length} rows. All of them are renamed.</div>}
      </div>
    </GlassCard>
  );
}
