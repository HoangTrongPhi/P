import { ArrowUpRight, Briefcase, Code2, Copy, FileText, Globe, Mail, MapPin, Palette, PlayCircle, Users, X, type LucideIcon } from "lucide-react";
import { useEffect, type CSSProperties } from "react";
import { AUTHOR, type AuthorLinkKind } from "../../lib/author";
import { inTauri, openUrl } from "../../lib/ipc";
import { uiLog, useAppStore } from "../../stores/appStore";
import { useUpdateStore } from "../../stores/updateStore";

const LINK_ICON: Record<AuthorLinkKind, LucideIcon> = {
  linkedin: Briefcase,
  artstation: Palette,
  github: Code2,
  youtube: PlayCircle,
  facebook: Users,
  web: Globe,
  cv: FileText,
};

function open(url: string) {
  if (inTauri) openUrl(url).catch((e) => uiLog("error", String(e)));
  else window.open(url, "_blank", "noopener");
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => uiLog("info", `Copied ${what}`),
    (e) => uiLog("error", String(e)),
  );
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

// ---------------------------------------------------------------- wireframe room

/** Isometric projection of a room-space point (x, y on the floor, z up; 0..1). */
function iso(x: number, y: number, z: number): [number, number] {
  const s = 92;
  return [100 + (x - y) * 0.866 * s, 70 + (x + y) * 0.5 * s - z * s * 0.95];
}

function poly(...pts: [number, number, number][]): string {
  return pts.map((p, i) => `${i ? "L" : "M"}${iso(...p).map((v) => v.toFixed(1)).join(" ")}`).join(" ");
}

/** Floor, two walls, a window, a shelf, a desk with a monitor, and a chair: a nod to the portfolio's room. */
const ROOM: string[] = [
  poly([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0]),
  poly([1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 1], [0, 1, 0]),
  poly([0, 0, 0], [0, 0, 1]),
  poly([0, 0.3, 0.45], [0, 0.72, 0.45], [0, 0.72, 0.82], [0, 0.3, 0.82], [0, 0.3, 0.45]),
  poly([0, 0.51, 0.45], [0, 0.51, 0.82]),
  poly([0.55, 0, 0.66], [0.9, 0, 0.66], [0.9, 0.12, 0.66], [0.55, 0.12, 0.66]),
  // Desk top and legs.
  poly([0.12, 0, 0.34], [0.62, 0, 0.34], [0.62, 0.26, 0.34], [0.12, 0.26, 0.34], [0.12, 0, 0.34]),
  poly([0.12, 0.26, 0.34], [0.12, 0.26, 0]),
  poly([0.62, 0.26, 0.34], [0.62, 0.26, 0]),
  poly([0.62, 0, 0.34], [0.62, 0, 0]),
  // Monitor.
  poly([0.22, 0.04, 0.38], [0.5, 0.04, 0.38], [0.5, 0.04, 0.56], [0.22, 0.04, 0.56], [0.22, 0.04, 0.38]),
  poly([0.36, 0.06, 0.34], [0.36, 0.06, 0.38]),
  // Chair seat, back and stem.
  poly([0.28, 0.36, 0.2], [0.46, 0.36, 0.2], [0.46, 0.54, 0.2], [0.28, 0.54, 0.2], [0.28, 0.36, 0.2]),
  poly([0.28, 0.54, 0.2], [0.28, 0.54, 0.44], [0.46, 0.54, 0.44], [0.46, 0.54, 0.2]),
  poly([0.37, 0.45, 0.2], [0.37, 0.45, 0.02]),
];

function Wireframe() {
  return (
    <svg viewBox="0 0 200 190" className="h-full w-full" aria-hidden="true">
      <g fill="none" stroke="var(--color-blueprint)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 4px var(--color-blueprint))" }}>
        {ROOM.map((d, i) => (
          <path key={i} d={d} pathLength={1} className="blueprint-draw" style={{ animationDelay: `${i * 70}ms` } as CSSProperties} />
        ))}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- dialog

/** About Project P and its author, styled after the author's blueprint portfolio. */
export function AboutDialog() {
  const openState = useAppStore((s) => s.aboutOpen);
  const setOpen = useAppStore((s) => s.setAboutOpen);
  const appInfo = useAppStore((s) => s.appInfo);

  useEffect(() => {
    if (!openState) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openState, setOpen]);

  if (!openState) return null;
  const linkedin = AUTHOR.links.find((l) => l.kind === "linkedin");

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/60 p-4 backdrop-blur-[2px]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="w-full max-w-2xl animate-pop-in overflow-hidden rounded-2xl border border-blueprint/25 bg-panel shadow-[0_0_60px_-12px] shadow-blueprint/30"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Hero */}
        <div className="blueprint-grid relative flex items-center gap-2 border-b border-blueprint/20 px-6 py-5">
          <button type="button" className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-blueprint/70 hover:bg-white/5 hover:text-blueprint" aria-label="Close" onClick={() => setOpen(false)}>
            <X className="size-4" />
          </button>
          <div className="h-44 w-48 shrink-0">
            <Wireframe />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10.5px] tracking-[0.25em] text-blueprint/60">// about · contact</div>
            <h2 id="about-title" className="blueprint-glow mt-1 text-[26px] leading-tight font-semibold text-white">
              {AUTHOR.name}
            </h2>
            <div className="mt-1 text-[11.5px] font-medium tracking-[0.3em] text-blueprint uppercase">{AUTHOR.role}</div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-muted">
              <span className="flex items-center gap-1">
                <MapPin className="size-3.5 text-blueprint/70" /> {AUTHOR.location}
              </span>
              <span className="flex items-center gap-1.5 rounded-full border border-emerald/30 bg-emerald/10 px-2 py-0.5 text-[11.5px] text-emerald">
                <span className="blueprint-pulse size-1.5 rounded-full bg-emerald" /> {AUTHOR.availability}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-lg bg-blueprint px-3 text-[12.5px] font-semibold text-blueprint-deep shadow-[0_0_18px_-4px] shadow-blueprint transition hover:brightness-110"
                onClick={() => open(AUTHOR.website)}
                title={AUTHOR.website}
              >
                <Globe className="size-3.5" /> Visit portfolio <ArrowUpRight className="size-3.5" />
              </button>
              {linkedin && (
                <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-blueprint/40 px-3 text-[12.5px] text-blueprint hover:bg-blueprint/10" onClick={() => open(linkedin.url)}>
                  <Briefcase className="size-3.5" /> Message on LinkedIn
                </button>
              )}
              <button type="button" className="grid size-8 place-items-center rounded-lg border border-blueprint/25 text-blueprint/70 hover:bg-blueprint/10 hover:text-blueprint" title="Copy portfolio link" aria-label="Copy portfolio link" onClick={() => copy(AUTHOR.website, "portfolio link")}>
                <Copy className="size-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="grid gap-5 px-6 py-5 md:grid-cols-[1fr_auto]">
          <div className="flex min-w-0 flex-col gap-4">
            {AUTHOR.bio && <p className="text-[13px] leading-relaxed text-ink-muted">{AUTHOR.bio}</p>}
            {AUTHOR.highlights.length > 0 && (
              <div>
                <div className="mb-1.5 font-mono text-[10.5px] tracking-[0.2em] text-ink-faint uppercase">Selected work</div>
                <ul className="flex flex-col gap-1">
                  {AUTHOR.highlights.map((h) => (
                    <li key={h.title} className="flex items-baseline gap-2 text-[12.5px]">
                      <span className="size-1 shrink-0 translate-y-[-2px] rounded-full bg-blueprint" />
                      <span className="font-medium text-ink">{h.title}</span>
                      <span className="truncate text-ink-faint">
                        {h.studio} · {h.years}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {AUTHOR.skills.map((s) => (
                <span key={s} className="rounded-md border border-edge bg-panel-raised/60 px-2 py-0.5 text-[11.5px] text-ink-muted">
                  {s}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 md:w-48">
            <div className="mb-0.5 font-mono text-[10.5px] tracking-[0.2em] text-ink-faint uppercase">Find me on</div>
            {AUTHOR.links.map((l) => {
              const Icon = LINK_ICON[l.kind];
              return (
                <button key={l.url} type="button" className="group flex items-center gap-2 rounded-lg border border-edge bg-panel-raised/50 px-2.5 py-1.5 text-left hover:border-blueprint/40 hover:bg-blueprint/5" onClick={() => open(l.url)} title={host(l.url)}>
                  <Icon className="size-3.5 text-ink-faint group-hover:text-blueprint" />
                  <span className="flex-1 text-[12.5px] text-ink">{l.label}</span>
                  <ArrowUpRight className="size-3 text-ink-faint opacity-0 group-hover:opacity-100" />
                </button>
              );
            })}
            {AUTHOR.cv && (
              <button type="button" className="group flex items-center gap-2 rounded-lg border border-edge bg-panel-raised/50 px-2.5 py-1.5 text-left hover:border-blueprint/40 hover:bg-blueprint/5" onClick={() => open(AUTHOR.cv)}>
                <FileText className="size-3.5 text-ink-faint group-hover:text-blueprint" />
                <span className="flex-1 text-[12.5px] text-ink">Full portfolio (PDF)</span>
                <ArrowUpRight className="size-3 text-ink-faint opacity-0 group-hover:opacity-100" />
              </button>
            )}
            {AUTHOR.email && (
              <button type="button" className="group flex items-center gap-2 rounded-lg border border-edge bg-panel-raised/50 px-2.5 py-1.5 text-left hover:border-blueprint/40" onClick={() => open(`mailto:${AUTHOR.email}`)}>
                <Mail className="size-3.5 text-ink-faint group-hover:text-blueprint" />
                <span className="flex-1 truncate text-[12.5px] text-ink">{AUTHOR.email}</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-edge px-6 py-3 text-[11.5px] text-ink-faint">
          <span>
            Project P — 3D Asset Toolkit {appInfo ? `v${appInfo.version}` : ""} · built by {AUTHOR.handle}
          </span>
          <span className="flex items-center gap-3">
            <button type="button" className="text-blueprint/80 hover:text-blueprint" onClick={() => void useUpdateStore.getState().checkForUpdates()}>
              Check for updates
            </button>
            <span className="font-mono">Tauri 2 · Rust · React</span>
          </span>
        </div>
      </div>
    </div>
  );
}
