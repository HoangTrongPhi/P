import { AlertTriangle, ArrowUpLeft, Box, Check, CheckCheck, CircleSlash, Cloud, Database, Download, FileJson, FolderOpen, Layers, Link2, Loader2, PackageCheck, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { inTauri, revealInExplorer } from "../../lib/ipc";
import { basename, dirname, humanSize } from "../../lib/pathUtil";
import { MAP_LABELS } from "../../lib/reportBuilders";
import { exportReport, relPath, type ReportDoc } from "../../lib/reports";
import { uiLog } from "../../stores/appStore";
import { useKitStore } from "../../stores/kitStore";
import { choiceFor, needsDecision, slotKey, useMatcherStore, type MatchFilter, type Override } from "../../stores/matcherStore";
import type { MapKind, MatchReport, MatchStatus, RecipeProgress, SlotMatch } from "../../types/pipeline";
import { EmptyState, PathText, ProgressBar, Segmented } from "../ui/Controls";
import { LocationPicker } from "../ui/LocationPicker";
import { GlassCard } from "../ui/GlassCard";

const STATUS: Record<MatchStatus, { label: string; hint: string; icon: typeof Check; cls: string }> = {
  exact: { label: "Exact", hint: "The mesh file references this texture set", icon: CheckCheck, cls: "text-emerald bg-emerald/10 ring-emerald/25" },
  likely: { label: "Likely", hint: "Clear winner by material / mesh name", icon: Check, cls: "text-accent bg-accent/10 ring-accent/25" },
  review: { label: "Review", hint: "Close call or weak evidence: pick one", icon: AlertTriangle, cls: "text-amber bg-amber/10 ring-amber/25" },
  none: { label: "No match", hint: "No texture set scored high enough", icon: CircleSlash, cls: "text-ink-faint bg-tint/5 ring-edge" },
};
const SELECT = "h-7 min-w-0 rounded-md border border-edge bg-canvas/70 px-1.5 text-[12px] text-ink outline-none focus:border-accent/60";
const NO_TEXTURE = "none";

function StatusBadge({ status, open }: { status: MatchStatus; open?: boolean }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium ring-1", s.cls, open === false && status === "review" && "opacity-60")} title={s.hint}>
      <Icon className="size-3" /> {s.label}
    </span>
  );
}

function ScoreBar({ score }: { score: number | null }) {
  return (
    <div className="flex w-20 shrink-0 items-center gap-1.5" title={score === null ? "Chosen by hand" : `Confidence ${score}/100`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tint/5">{score !== null && <div className="h-full rounded-full bg-accent" style={{ width: `${score}%` }} />}</div>
      <span className="w-6 text-right text-[11px] text-ink-muted tabular-nums">{score ?? "–"}</span>
    </div>
  );
}

/** Set names, with their folder when two sets share a name. */
function useSetLabels(report: MatchReport): string[] {
  return useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of report.sets) seen.set(s.name.toLowerCase(), (seen.get(s.name.toLowerCase()) ?? 0) + 1);
    return report.sets.map((s) => (seen.get(s.name.toLowerCase())! > 1 ? `${s.name} — ${relPath(s.dir, report.root) || "(root)"}` : s.name));
  }, [report]);
}

function matches(report: MatchReport, mi: number, slot: SlotMatch, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const set = slot.candidates[0] && report.sets[slot.candidates[0].set];
  return [report.meshes[mi].path, slot.name, set?.name ?? ""].some((s) => s.toLowerCase().includes(q));
}

// ---------------------------------------------------------------- tab

export function MatcherTab() {
  const { folder, report, loading, filter, query, overrides, load, refresh, setFilter, setQuery, acceptAllBest, saveManifest, confirm, progress, confirmRead, dismissConfirm, cancel, clearCache } = useMatcherStore();
  const selected = useMatcherStore((s) => s.selected);
  const { openFromMatcher, openManifestFile } = useKitStore();

  const counts = useMemo(() => {
    const c = { exact: 0, likely: 0, review: 0, none: 0, open: 0, openReview: 0, slots: 0, missingRefs: 0 };
    report?.meshes.forEach((m, mi) => {
      c.missingRefs += m.missingReferences.length;
      m.slots.forEach((s, si) => {
        c[s.status]++;
        c.slots++;
        if (needsDecision(s, overrides[slotKey(mi, si)])) {
          c.open++;
          if (s.status === "review") c.openReview++;
        }
      });
    });
    return c;
  }, [report, overrides]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <GlassCard className="relative z-20 flex flex-wrap items-center gap-2 px-4 py-2.5">
        <FolderOpen className="size-4 shrink-0 text-ink-faint" />
        {folder ? <PathText path={folder} className="min-w-0 flex-1 text-ink" /> : <span className="flex-1 text-[12.5px] text-ink-faint">Drop an artist delivery folder — local or G:\Shared drives\…</span>}
        {folder && (
          <>
            <button type="button" className="icon-btn" title="Up one folder" aria-label="Up one folder" onClick={() => void load(dirname(folder))}>
              <ArrowUpLeft className="size-3.5" />
            </button>
            <button type="button" className="btn" onClick={() => void refresh()} disabled={loading} title="Match again, keeping your picks">
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
            </button>
          </>
        )}
        <LocationPicker onPick={(f) => void load(f)} />
        <button type="button" className="btn" disabled={!report} onClick={() => report && void exportReport(matcherReport(report, overrides))} title="Save as HTML or CSV">
          <Download className="size-3.5" /> Export
        </button>
        <button type="button" className="btn" disabled={!report} onClick={() => void saveManifest()} title="asset_manifest.json: every mesh slot with its texture set">
          <FileJson className="size-3.5" /> Save manifest
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => (report ? openFromMatcher() : void openManifestFile())}
          title={report ? "Copy the matched meshes and textures into a clean project layout" : "Assemble from a saved asset_manifest.json"}
        >
          <PackageCheck className="size-3.5" /> {report ? "Assemble kit…" : "Assemble from manifest…"}
        </button>
      </GlassCard>

      {confirm && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber/30 bg-amber/5 px-4 py-2.5 text-[12.5px] text-ink-muted" role="alert">
          <Cloud className="size-4 shrink-0 text-amber" />
          <div className="min-w-0 flex-1">
            <span className="text-ink">This folder is on Google Drive.</span> Matching reads {confirm.meshes - confirm.cachedMeshes} mesh file(s): about{" "}
            <b className="text-ink">{humanSize(confirm.bytes - confirm.cachedBytes)}</b> will download
            {confirm.cachedMeshes > 0 && ` (${confirm.cachedMeshes} file(s), ${humanSize(confirm.cachedBytes)} already cached)`}. Textures are only listed. Tip: pick a single package folder to read less.
          </div>
          <button type="button" className="btn" onClick={dismissConfirm}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirmRead()}>
            <Download className="size-3.5" /> Read meshes
          </button>
        </div>
      )}

      {loading && report && <MatchProgress progress={progress} onCancel={cancel} />}

      {!report ? (
        <GlassCard className="flex flex-1 items-center justify-center">
          {loading ? (
            <div className="w-full max-w-md px-6">
              <MatchProgress progress={progress} onCancel={cancel} />
            </div>
          ) : (
            <EmptyState icon={<Link2 className="size-5" />} title="Which texture goes with which mesh?">
              Matches every mesh and material slot to a texture set: texture paths inside FBX / OBJ-MTL / glTF first, then material and file names, then folders. Close calls are flagged for you to pick instead of guessed. Mesh files are read (small); textures only by name.
            </EmptyState>
          )}
        </GlassCard>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<MatchFilter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All ${counts.slots}` },
                { value: "todo", label: `To decide ${counts.open}`, hint: "Review slots you have not picked yet, and slots with no match" },
                { value: "review", label: `Review ${counts.review}` },
                { value: "none", label: `No match ${counts.none}` },
              ]}
            />
            <div className="flex items-center gap-3 px-1 text-[11.5px] text-ink-muted">
              <span><StatusBadge status="exact" /> {counts.exact}</span>
              <span><StatusBadge status="likely" /> {counts.likely}</span>
              <span title="Texture sets no mesh slot picked">{report.orphanSets.length} unused set(s)</span>
              <span className="flex items-center gap-1" title="Mesh files read this time vs. reused from the cache (unchanged since last read)">
                <Database className="size-3" /> {report.readFiles} read · {report.cachedFiles} cached
                <button type="button" className="ml-0.5 text-ink-faint underline-offset-2 hover:text-ink hover:underline" onClick={() => void clearCache()} title="Forget cached meshes: the next match reads (downloads) them again">
                  clear
                </button>
              </span>
              {counts.missingRefs > 0 && <span className="text-amber" title="Texture names referenced by meshes but not in the folder">{counts.missingRefs} missing reference(s)</span>}
            </div>
            <div className="flex-1" />
            <label className="relative">
              <Search className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-ink-faint" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter mesh, material, set" className="h-7 w-56 rounded-md border border-edge bg-canvas/70 pr-2 pl-7 text-[12px] text-ink outline-none focus:border-accent/60" />
            </label>
            <button type="button" className="btn" disabled={!counts.openReview} onClick={acceptAllBest} title="Take the top candidate for every Review slot you have not picked">
              <Check className="size-3.5" /> Accept best for reviews
            </button>
          </div>
          <div className="flex min-h-0 flex-1 gap-3">
            <SlotList report={report} />
            <DetailPanel report={report} selected={selected} />
          </div>
        </>
      )}
    </div>
  );
}

function MatchProgress({ progress, onCancel }: { progress: RecipeProgress | null; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-panel/80 px-4 py-2.5">
      <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ProgressBar value={progress?.done ?? 0} total={progress?.total ?? 0} indeterminate={!progress} />
        <span className="truncate text-[11.5px] text-ink-faint">{progress ? `Reading meshes ${progress.done}/${progress.total} · ${progress.message}` : "Listing meshes and grouping textures…"}</span>
      </div>
      <button type="button" className="btn h-7" onClick={onCancel} title="Stop; meshes read so far stay cached">
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- list

function SlotList({ report }: { report: MatchReport }) {
  const { filter, query, overrides, selected, select, choose } = useMatcherStore();
  const labels = useSetLabels(report);
  const byName = useMemo(() => labels.map((n, i) => [i, n] as const).sort((a, b) => a[1].localeCompare(b[1])), [labels]);

  const groups = report.meshes
    .map((m, mi) => ({
      m,
      mi,
      slots: m.slots
        .map((s, si) => ({ s, si, key: slotKey(mi, si) }))
        .filter(({ s, key }) => {
          if (!matches(report, mi, s, query)) return false;
          if (filter === "todo") return needsDecision(s, overrides[key]);
          if (filter === "review") return s.status === "review";
          if (filter === "none") return s.status === "none";
          return true;
        }),
    }))
    .filter((g) => g.slots.length);

  return (
    <GlassCard className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2 text-[11px] tracking-wide text-ink-faint uppercase">
        <span className="w-24 shrink-0">Status</span>
        <span className="min-w-0 flex-1 truncate">Mesh / material slot</span>
        <span className="w-40 shrink-0 xl:w-64">Texture set</span>
        <span className="w-20 shrink-0">Confidence</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!groups.length && <div className="p-6 text-center text-[12.5px] text-ink-faint">{report.meshes.length ? "Nothing matches this filter." : "No FBX / OBJ / glTF meshes in this folder."}</div>}
        {groups.map(({ m, slots }) => (
          <div key={m.path} className="border-b border-edge/60">
            <div className="flex items-center gap-2 bg-tint/[0.02] px-4 py-1.5">
              <Box className="size-3.5 shrink-0 text-viz-mesh" />
              <span className="min-w-0 truncate font-mono text-[12px] text-ink" title={m.path}>
                {relPath(m.path, report.root)}
              </span>
              {m.references.length > 0 && <span className="shrink-0 text-[11px] text-ink-faint">{m.references.length} texture path(s) inside</span>}
              {m.missingReferences.length > 0 && (
                <span className="shrink-0 text-[11px] text-amber" title={m.missingReferences.join("\n")}>
                  {m.missingReferences.length} missing
                </span>
              )}
              {m.error && (
                <span className="shrink-0 truncate text-[11px] text-rose" title={m.error}>
                  read error
                </span>
              )}
            </div>
            {slots.map(({ s, key }) => {
              const ov = overrides[key];
              const c = choiceFor(s, ov);
              const value = c.set === null ? NO_TEXTURE : String(c.set);
              const inCandidates = new Set(s.candidates.map((x) => x.set));
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => select(key)}
                  onKeyDown={(e) => e.key === "Enter" && select(key)}
                  className={cn("flex cursor-pointer items-center gap-2 px-4 py-1.5 hover:bg-panel-hover/60", selected === key && "bg-accent/10 hover:bg-accent/10")}
                >
                  <span className="flex w-24 shrink-0 items-center gap-1">
                    <StatusBadge status={s.status} open={c.decision === "open"} />
                    {c.decision === "manual" && <span className="text-[10.5px] text-ink-faint" title="Picked by hand">✎</span>}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 text-[12.5px] xl:pl-4">
                    <Layers className={cn("size-3 shrink-0", s.isMaterial ? "text-ink-faint" : "text-ink-faint/50")} />
                    <span className={cn("truncate", s.isMaterial ? "text-ink" : "text-ink-muted italic")} title={s.isMaterial ? "Material slot" : "No materials in the file: matched by mesh name"}>
                      {s.name}
                    </span>
                  </span>
                  <select
                    className={cn(SELECT, "w-40 shrink-0 xl:w-64", c.decision === "open" && "border-amber/40")}
                    value={value}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => choose(key, e.target.value === NO_TEXTURE ? null : Number(e.target.value))}
                    aria-label={`Texture set for ${s.name}`}
                  >
                    {s.candidates.length > 0 && (
                      <optgroup label="Candidates">
                        {s.candidates.map((x) => (
                          <option key={x.set} value={x.set}>
                            {labels[x.set]} ({x.score})
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Other sets">
                      {byName.filter(([i]) => !inCandidates.has(i)).map(([i, n]) => (
                        <option key={i} value={i}>
                          {n}
                        </option>
                      ))}
                    </optgroup>
                    <option value={NO_TEXTURE}>— No texture —</option>
                  </select>
                  <ScoreBar score={c.score} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

// ---------------------------------------------------------------- details

function reveal(path: string) {
  if (inTauri) revealInExplorer(path).catch((e) => uiLog("error", String(e)));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] tracking-wide text-ink-faint uppercase">{title}</div>
      {children}
    </div>
  );
}

function DetailPanel({ report, selected }: { report: MatchReport; selected: string | null }) {
  const { overrides, choose, reset, select } = useMatcherStore();
  const labels = useSetLabels(report);
  const [mi, si] = selected ? selected.split(":").map(Number) : [-1, -1];
  const mesh = report.meshes[mi];
  const slot = mesh?.slots[si];

  if (!mesh || !slot) return <UnusedPanel report={report} />;
  const key = selected!;
  const ov: Override | undefined = overrides[key];
  const c = choiceFor(slot, ov);
  const set = c.set === null ? null : report.sets[c.set];

  return (
    <GlassCard className="flex min-h-0 w-72 shrink-0 flex-col xl:w-96">
      <div className="flex items-start gap-2 border-b border-edge px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{slot.name}</div>
          <div className="truncate font-mono text-[11px] text-ink-faint" title={mesh.path}>
            {relPath(mesh.path, report.root)}
          </div>
        </div>
        <StatusBadge status={slot.status} />
        <button type="button" className="icon-btn size-6" aria-label="Close details" onClick={() => select(null)}>
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Section title="Candidates">
          {!slot.candidates.length && <div className="text-[12px] text-ink-faint">No texture set shares a name or a reference with this slot. Pick one from the list, or leave it without texture.</div>}
          {slot.candidates.map((x) => {
            // An open Review slot has no pick yet, even though the top candidate is preselected in the list.
            const active = c.set === x.set && c.decision !== "open";
            return (
              <div key={x.set} className={cn("rounded-lg border px-3 py-2", active ? "border-accent/50 bg-accent/5" : "border-edge bg-panel-raised/40")}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink" title={report.sets[x.set].dir}>
                    {labels[x.set]}
                  </span>
                  <ScoreBar score={x.score} />
                  {active ? (
                    <Check className="size-4 text-accent" aria-label="Chosen" />
                  ) : (
                    <button type="button" className="btn h-6 px-2 text-[11.5px]" onClick={() => choose(key, x.set)}>
                      Use
                    </button>
                  )}
                </div>
                <ul className="mt-1 list-disc pl-4 text-[11.5px] text-ink-muted">
                  {x.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="flex gap-2">
            <button type="button" className="btn h-7" disabled={c.set === null && ov !== undefined} onClick={() => choose(key, null)}>
              <CircleSlash className="size-3.5" /> No texture
            </button>
            {ov !== undefined && (
              <button type="button" className="btn h-7" onClick={() => reset(key)} title="Back to the matcher's pick">
                <RotateCcw className="size-3.5" /> Auto
              </button>
            )}
          </div>
        </Section>

        {set && (
          <Section title={`Maps in ${set.name}`}>
            {Object.entries(set.maps).map(([k, p]) => (
              <button key={k} type="button" className="flex items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-panel-hover/60" onClick={() => reveal(p)} title={p}>
                <span className="w-20 shrink-0 text-[11.5px] text-ink-faint">{MAP_LABELS[k as MapKind]}</span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-ink">{basename(p)}</span>
              </button>
            ))}
            {set.missing.length > 0 && <div className="text-[11.5px] text-amber">Missing: {set.missing.map((k) => MAP_LABELS[k]).join(", ")}</div>}
            <div className="truncate font-mono text-[11px] text-ink-faint" title={set.dir}>
              {relPath(set.dir, report.root) || "(root)"}
            </div>
          </Section>
        )}

        {(mesh.references.length > 0 || mesh.error) && (
          <Section title="Texture paths inside the mesh file">
            {mesh.error && <div className="text-[11.5px] text-rose">{mesh.error}</div>}
            {mesh.references.map((r) => (
              <div key={r} className={cn("truncate font-mono text-[11.5px]", mesh.missingReferences.includes(r) ? "text-amber" : "text-ink-muted")}>
                {r}
                {mesh.missingReferences.includes(r) && " — not in this folder"}
              </div>
            ))}
          </Section>
        )}
      </div>
    </GlassCard>
  );
}

function UnusedPanel({ report }: { report: MatchReport }) {
  return (
    <GlassCard className="flex min-h-0 w-72 shrink-0 flex-col xl:w-96">
      <div className="border-b border-edge px-4 py-3 text-[12.5px] text-ink-muted">Select a slot to see why it matched and to change it.</div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Section title={`Texture sets no mesh uses (${report.orphanSets.length})`}>
          {!report.orphanSets.length && <div className="text-[12px] text-ink-faint">Every texture set is someone's best match.</div>}
          {report.orphanSets.map((i) => {
            const s = report.sets[i];
            return (
              <div key={i} className="flex items-center gap-2 text-[12px]" title={s.dir}>
                <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
                <span className="shrink-0 truncate text-[11px] text-ink-faint">{relPath(s.dir, report.root) || "(root)"}</span>
              </div>
            );
          })}
        </Section>
        {report.looseTextures.length > 0 && (
          <Section title={`Textures without a map suffix (${report.looseTextures.length})`}>
            {report.looseTextures.map((p) => (
              <div key={p} className="truncate font-mono text-[11.5px] text-ink-muted" title={p}>
                {relPath(p, report.root)}
              </div>
            ))}
          </Section>
        )}
      </div>
    </GlassCard>
  );
}

// ---------------------------------------------------------------- export

function matcherReport(report: MatchReport, overrides: Record<string, Override>): ReportDoc {
  const rows = report.meshes.flatMap((m, mi) =>
    m.slots.map((s, si) => {
      const c = choiceFor(s, overrides[slotKey(mi, si)]);
      return [relPath(m.path, report.root), s.name, c.set === null ? "" : report.sets[c.set].name, c.score, STATUS[s.status].label, c.decision, s.candidates[0]?.reasons.join("; ") ?? ""];
    }),
  );
  const count = (st: MatchStatus) => report.meshes.reduce((n, m) => n + m.slots.filter((s) => s.status === st).length, 0);
  return {
    title: "Asset matches",
    subject: report.root,
    summary: [
      ["Meshes", report.meshes.length],
      ["Exact", count("exact")],
      ["Likely", count("likely")],
      ["Review", count("review")],
      ["No match", count("none")],
      ["Unused texture sets", report.orphanSets.length],
    ],
    sections: [
      { heading: "Mesh slots", columns: ["Mesh", "Slot", "Texture set", "Confidence", "Status", "Decision", "Why"], rows },
      { heading: "Unused texture sets", columns: ["Set", "Folder"], rows: report.orphanSets.map((i) => [report.sets[i].name, relPath(report.sets[i].dir, report.root)]) },
      { heading: "Textures without a map suffix", columns: ["File"], rows: report.looseTextures.map((p) => [relPath(p, report.root)]) },
    ],
  };
}
