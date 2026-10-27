import { ArrowUpLeft, Box, ChartBar, Download, FileImage, FolderOpen, HardDrive, Image, Layers, Loader2, Package, RefreshCw } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { dirname, humanSize, joinPath } from "../../lib/pathUtil";
import { exportReport, type ReportDoc } from "../../lib/reports";
import { packageRows, ROOT_PACKAGE, TYPES, typeTotals, useDashboardStore, type Metric, type PackageRow, type Totals } from "../../stores/dashboardStore";
import type { AssetCategory } from "../../types/pipeline";
import { EmptyState, PathText, Segmented } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { LocationPicker } from "../ui/LocationPicker";

const TYPE_INFO: Record<AssetCategory, { label: string; color: string }> = {
  mesh: { label: "Meshes", color: "var(--color-viz-mesh)" },
  texture: { label: "Textures", color: "var(--color-viz-texture)" },
  scene: { label: "Scenes", color: "var(--color-viz-scene)" },
  source: { label: "Sources", color: "var(--color-viz-source)" },
  other: { label: "Other", color: "var(--color-ink-faint)" },
};
/** Packages shown as bars; the rest fold into one "Other" row. */
const MAX_PACKAGES = 20;
const SELECT = "h-7 rounded-md border border-edge bg-canvas/70 px-1.5 text-[12px] text-ink outline-none focus:border-accent/60";

const fmt = (v: number, metric: Metric) => (metric === "size" ? humanSize(v) : v.toLocaleString("en-US"));
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");

// ---------------------------------------------------------------- tooltip

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: [string, string][];
  color?: string;
}

function useTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const bind = (content: Omit<Tip, "x" | "y">) => ({
    onMouseMove: (e: React.MouseEvent) => setTip({ ...content, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setTip(null),
  });
  const node = tip && (
    <div
      className="pointer-events-none fixed z-50 min-w-40 rounded-lg border border-edge-strong bg-panel-raised px-2.5 py-2 text-[12px] shadow-xl"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 220), top: tip.y + 14 }}
      role="tooltip"
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium text-ink">
        {tip.color && <span className="size-2.5 rounded-sm" style={{ background: tip.color }} />}
        {tip.title}
      </div>
      {tip.lines.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 text-ink-muted">
          <span>{k}</span>
          <span className="text-ink tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
  return { bind, node };
}

// ---------------------------------------------------------------- tab

export function DashboardTab() {
  const { folder, summary, loading, metric, depth, load, refresh, setMetric, setDepth } = useDashboardStore();
  const rows = useMemo(() => (summary ? packageRows(summary, depth) : []), [summary, depth]);
  const types = useMemo(() => (summary ? typeTotals(summary.files) : null), [summary]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <GlassCard className="relative z-20 flex flex-wrap items-center gap-2 px-4 py-2.5">
        <FolderOpen className="size-4 shrink-0 text-ink-faint" />
        {folder ? <PathText path={folder} className="min-w-0 flex-1 text-ink" /> : <span className="flex-1 text-[12.5px] text-ink-faint">Drop an asset folder — a local drive or a Google Drive path like G:\Shared drives\…</span>}
        {folder && (
          <>
            <button type="button" className="icon-btn" title="Up one folder" aria-label="Up one folder" onClick={() => void load(dirname(folder))}>
              <ArrowUpLeft className="size-3.5" />
            </button>
            <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
            </button>
          </>
        )}
        <LocationPicker onPick={(f) => void load(f)} />
        <Segmented<Metric>
          value={metric}
          onChange={setMetric}
          options={[
            { value: "count", label: "Files" },
            { value: "size", label: "Size" },
          ]}
        />
        <button type="button" className="btn" disabled={!summary} onClick={() => summary && void exportReport(dashboardReport(summary.root, rows, types!))} title="Save as HTML or CSV">
          <Download className="size-3.5" /> Export
        </button>
      </GlassCard>

      {!summary ? (
        <GlassCard className="flex flex-1 items-center justify-center">
          {loading ? (
            <Loader2 className="size-5 animate-spin text-accent" />
          ) : (
            <EmptyState icon={<ChartBar className="size-5" />} title="What is in this delivery?">
              Counts and sizes by asset type and by package (sub-folder). Only file names and sizes are read, so a streamed Google Drive folder is not downloaded.
            </EmptyState>
          )}
        </GlassCard>
      ) : (
        <>
          <StatTiles rows={rows} types={types!} />
          <div className="flex min-h-0 flex-1 gap-3">
            <TypeCard types={types!} metric={metric} />
            <PackageCard rows={rows} metric={metric} depth={depth} setDepth={setDepth} onOpen={(name) => void load(joinPath(summary.root, ...name.split("/")))} />
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-36 flex-1 items-center gap-3 rounded-xl border border-edge bg-panel/80 px-4 py-3">
      <div className="grid size-9 place-items-center rounded-lg bg-white/5 text-ink-faint">{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</div>
        <div className="text-[20px] leading-tight font-semibold text-ink tabular-nums">{value}</div>
        {sub && <div className="truncate text-[11px] text-ink-faint">{sub}</div>}
      </div>
    </div>
  );
}

function StatTiles({ rows, types }: { rows: PackageRow[]; types: ReturnType<typeof typeTotals> }) {
  const total = TYPES.reduce((n, t) => n + types[t].count, 0);
  const size = TYPES.reduce((n, t) => n + types[t].size, 0);
  const packages = rows.filter((r) => r.name !== ROOT_PACKAGE).length;
  return (
    <div className="flex flex-wrap gap-3">
      <Tile icon={<Layers className="size-4" />} label="Assets" value={total.toLocaleString("en-US")} />
      <Tile icon={<HardDrive className="size-4" />} label="Total size" value={humanSize(size)} />
      <Tile icon={<Package className="size-4" />} label="Packages" value={packages.toLocaleString("en-US")} sub={rows.some((r) => r.name === ROOT_PACKAGE) ? "+ files in the root" : undefined} />
      <Tile icon={<Box className="size-4" />} label="Meshes" value={types.mesh.count.toLocaleString("en-US")} sub={humanSize(types.mesh.size)} />
      <Tile icon={<Image className="size-4" />} label="Textures" value={types.texture.count.toLocaleString("en-US")} sub={humanSize(types.texture.size)} />
    </div>
  );
}

// ---------------------------------------------------------------- by type

function TypeCard({ types, metric }: { types: ReturnType<typeof typeTotals>; metric: Metric }) {
  const { bind, node } = useTooltip();
  const val = (t: Totals) => (metric === "size" ? t.size : t.count);
  const grand = TYPES.reduce((n, t) => n + val(types[t]), 0);
  const max = Math.max(1, ...TYPES.map((t) => val(types[t])));
  const exts = TYPES.flatMap((t) => [...types[t].exts].map(([ext, tot]) => ({ ext, type: t, tot }))).sort((a, b) => val(b.tot) - val(a.tot));
  const extMax = Math.max(1, ...exts.map((e) => val(e.tot)));
  return (
    <GlassCard title={<span className="flex items-center gap-2"><FileImage className="size-3.5" /> By asset type</span>} className="flex w-[400px] shrink-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-col gap-2.5">
          {TYPES.map((t) => {
            const v = val(types[t]);
            return (
              <div key={t} className="grid grid-cols-[72px_1fr] items-center gap-2" {...bind({ title: TYPE_INFO[t].label, color: TYPE_INFO[t].color, lines: [["Files", types[t].count.toLocaleString("en-US")], ["Size", humanSize(types[t].size)], ["Share", pct(v, grand)], ["Formats", [...types[t].exts.keys()].join(", ") || "—"]] })}>
                <span className="text-[12px] text-ink-muted">{TYPE_INFO[t].label}</span>
                <div className="flex h-6 items-center gap-2">
                  {v > 0 && <div className="h-3.5 rounded-r-[4px]" style={{ width: `${(v / max) * 82}%`, minWidth: 3, background: TYPE_INFO[t].color }} />}
                  <span className="text-[12px] whitespace-nowrap text-ink tabular-nums">
                    {fmt(v, metric)} <span className="text-ink-faint">{pct(v, grand)}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div>
          <div className="mb-2 text-[11px] font-medium tracking-wide text-ink-faint uppercase">By format</div>
          <div className="flex flex-col gap-1">
            {exts.slice(0, 14).map((e) => {
              const v = val(e.tot);
              return (
                <div key={`${e.type}.${e.ext}`} className="grid grid-cols-[72px_1fr] items-center gap-2" {...bind({ title: `.${e.ext}`, color: TYPE_INFO[e.type].color, lines: [["Type", TYPE_INFO[e.type].label], ["Files", e.tot.count.toLocaleString("en-US")], ["Size", humanSize(e.tot.size)]] })}>
                  <span className="font-mono text-[11.5px] text-ink-muted">.{e.ext}</span>
                  <div className="flex h-5 items-center gap-2">
                    <div className="h-2.5 rounded-r-[4px]" style={{ width: `${(v / extMax) * 78}%`, minWidth: 3, background: TYPE_INFO[e.type].color }} />
                    <span className="text-[11.5px] whitespace-nowrap text-ink-muted tabular-nums">{fmt(v, metric)}</span>
                  </div>
                </div>
              );
            })}
            {exts.length > 14 && <div className="text-[11px] text-ink-faint">+ {exts.length - 14} more format(s) in the export</div>}
          </div>
        </div>
      </div>
      {node}
    </GlassCard>
  );
}

// ---------------------------------------------------------------- by package

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {TYPES.map((t) => (
        <span key={t} className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
          <span className="size-2.5 rounded-sm" style={{ background: TYPE_INFO[t].color }} />
          {TYPE_INFO[t].label}
        </span>
      ))}
    </div>
  );
}

function foldRows(rows: PackageRow[], metric: Metric): PackageRow[] {
  const val = (r: PackageRow) => (metric === "size" ? r.total.size : r.total.count);
  const sorted = [...rows].sort((a, b) => val(b) - val(a));
  if (sorted.length <= MAX_PACKAGES) return sorted;
  const rest = sorted.slice(MAX_PACKAGES - 1);
  const other: PackageRow = { name: `Other (${rest.length} packages)`, total: { count: 0, size: 0 }, byType: Object.fromEntries(TYPES.concat("other").map((t) => [t, { count: 0, size: 0 }])) as PackageRow["byType"] };
  for (const r of rest) {
    other.total.count += r.total.count;
    other.total.size += r.total.size;
    for (const t of TYPES) {
      other.byType[t].count += r.byType[t].count;
      other.byType[t].size += r.byType[t].size;
    }
  }
  return [...sorted.slice(0, MAX_PACKAGES - 1), other];
}

function PackageCard({ rows, metric, depth, setDepth, onOpen }: { rows: PackageRow[]; metric: Metric; depth: number; setDepth: (d: number) => void; onOpen: (name: string) => void }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const { bind, node } = useTooltip();
  const shown = foldRows(rows, metric);
  const val = (t: Totals) => (metric === "size" ? t.size : t.count);
  const max = Math.max(1, ...shown.map((r) => val(r.total)));
  const openable = (name: string) => name !== ROOT_PACKAGE && !name.startsWith("Other (");
  return (
    <GlassCard
      title={<span className="flex items-center gap-2"><Package className="size-3.5" /> By package</span>}
      actions={
        <>
          <select className={SELECT} value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Package level" title="Folder levels that make a package">
            {[1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "Top folders" : `${d} folder levels`}
              </option>
            ))}
          </select>
          <Segmented size="sm" value={view} onChange={setView} options={[{ value: "chart", label: "Chart" }, { value: "table", label: "Table" }]} />
        </>
      }
      className="flex min-w-0 flex-1 flex-col"
    >
      {view === "chart" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex items-center justify-between gap-3">
            <Legend />
            <span className="text-[11px] text-ink-faint">Click a package to open it</span>
          </div>
          <div className="flex flex-col gap-1">
            {shown.map((r) => {
              const total = val(r.total);
              const segs = TYPES.filter((t) => val(r.byType[t]) > 0);
              return (
                <div key={r.name} className="grid grid-cols-[minmax(120px,220px)_1fr] items-center gap-3">
                  <button
                    type="button"
                    disabled={!openable(r.name)}
                    onClick={() => onOpen(r.name)}
                    className={cn("truncate text-left text-[12px] text-ink-muted", openable(r.name) && "hover:text-accent hover:underline")}
                    title={r.name}
                  >
                    {r.name}
                  </button>
                  <div className="flex h-7 items-center gap-2">
                    <div className="flex h-4 gap-[2px]" style={{ width: `${(total / max) * 80}%`, minWidth: segs.length * 3 }}>
                      {segs.map((t, i) => (
                        <div
                          key={t}
                          className={cn("h-full", i === segs.length - 1 && "rounded-r-[4px]")}
                          style={{ flexGrow: val(r.byType[t]), flexBasis: 0, minWidth: 2, background: TYPE_INFO[t].color }}
                          {...bind({
                            title: `${r.name} · ${TYPE_INFO[t].label}`,
                            color: TYPE_INFO[t].color,
                            lines: [
                              ["Files", r.byType[t].count.toLocaleString("en-US")],
                              ["Size", humanSize(r.byType[t].size)],
                              [`Share of package`, pct(val(r.byType[t]), total)],
                            ],
                          })}
                        />
                      ))}
                    </div>
                    <span className="text-[11.5px] whitespace-nowrap text-ink-muted tabular-nums">{fmt(total, metric)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-panel-raised text-left text-[11px] text-ink-faint uppercase">
              <tr>
                <th className="px-3 py-1.5 font-medium">Package</th>
                {TYPES.map((t) => (
                  <th key={t} className="px-3 py-1.5 text-right font-medium">
                    {TYPE_INFO[t].label}
                  </th>
                ))}
                <th className="px-3 py-1.5 text-right font-medium">Files</th>
                <th className="px-3 py-1.5 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].sort((a, b) => val(b.total) - val(a.total)).map((r) => (
                <tr key={r.name} className="border-t border-edge hover:bg-white/3">
                  <td className="max-w-72 truncate px-3 py-1 text-ink" title={r.name}>
                    {openable(r.name) ? (
                      <button type="button" className="hover:text-accent hover:underline" onClick={() => onOpen(r.name)}>
                        {r.name}
                      </button>
                    ) : (
                      r.name
                    )}
                  </td>
                  {TYPES.map((t) => (
                    <td key={t} className="px-3 py-1 text-right text-ink-muted tabular-nums">
                      {r.byType[t].count || "·"}
                    </td>
                  ))}
                  <td className="px-3 py-1 text-right text-ink tabular-nums">{r.total.count.toLocaleString("en-US")}</td>
                  <td className="px-3 py-1 text-right text-ink-muted tabular-nums">{humanSize(r.total.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {node}
    </GlassCard>
  );
}

function dashboardReport(root: string, rows: PackageRow[], types: ReturnType<typeof typeTotals>): ReportDoc {
  const sorted = [...rows].sort((a, b) => b.total.size - a.total.size);
  return {
    title: "Asset dashboard",
    subject: root,
    summary: [
      ["Assets", TYPES.reduce((n, t) => n + types[t].count, 0)],
      ["Total size", humanSize(TYPES.reduce((n, t) => n + types[t].size, 0))],
      ["Packages", rows.filter((r) => r.name !== ROOT_PACKAGE).length],
    ],
    sections: [
      {
        heading: "By asset type and format",
        columns: ["Type", "Format", "Files", "Size (bytes)"],
        rows: TYPES.flatMap((t) => [...types[t].exts].sort((a, b) => b[1].size - a[1].size).map(([ext, v]) => [TYPE_INFO[t].label, ext, v.count, v.size])),
      },
      {
        heading: "By package",
        columns: ["Package", ...TYPES.map((t) => `${TYPE_INFO[t].label} (files)`), "Files", "Size (bytes)"],
        rows: sorted.map((r) => [r.name, ...TYPES.map((t) => r.byType[t].count), r.total.count, r.total.size]),
      },
    ],
  };
}
