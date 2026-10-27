import { Copy, ExternalLink, Mail, MapPin, X } from "lucide-react";
import { useEffect } from "react";
import { AUTHOR } from "../../lib/author";
import { inTauri, openUrl } from "../../lib/ipc";
import { uiLog, useAppStore } from "../../stores/appStore";

function open(url: string) {
  if (inTauri) openUrl(url).catch((e) => uiLog("error", String(e)));
  else window.open(url, "_blank", "noopener");
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => uiLog("info", `Copied ${text}`),
    (e) => uiLog("error", String(e)),
  );
}

/** About Project P + the author's contact details (from `lib/author.ts`). */
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
  const initials = AUTHOR.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join("");
  const hasContact = AUTHOR.email || AUTHOR.links.length;

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/50 p-4" onMouseDown={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="about-title" className="w-full max-w-md animate-pop-in rounded-xl border border-edge-strong bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-edge p-5">
          <div className="grid size-12 shrink-0 place-items-center rounded-full bg-accent/15 text-[16px] font-semibold text-accent ring-1 ring-accent/30">{initials || "?"}</div>
          <div className="min-w-0 flex-1">
            <h2 id="about-title" className="text-[15px] font-semibold text-ink">
              {AUTHOR.name}
            </h2>
            {AUTHOR.role && <div className="text-[12.5px] text-ink-muted">{AUTHOR.role}</div>}
            {AUTHOR.location && (
              <div className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-faint">
                <MapPin className="size-3" /> {AUTHOR.location}
              </div>
            )}
          </div>
          <button type="button" className="icon-btn size-7" aria-label="Close" onClick={() => setOpen(false)}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-5">
          {AUTHOR.bio && <p className="text-[12.5px] leading-relaxed text-ink-muted">{AUTHOR.bio}</p>}
          {AUTHOR.email && (
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel-raised/60 px-3 py-2">
              <Mail className="size-4 shrink-0 text-ink-faint" />
              <button type="button" className="min-w-0 flex-1 truncate text-left text-[12.5px] text-ink hover:text-accent" onClick={() => open(`mailto:${AUTHOR.email}`)}>
                {AUTHOR.email}
              </button>
              <button type="button" className="icon-btn size-6" title="Copy address" onClick={() => copy(AUTHOR.email)}>
                <Copy className="size-3.5" />
              </button>
            </div>
          )}
          {AUTHOR.links.map((l) => (
            <button key={l.url} type="button" className="flex items-center gap-2 rounded-lg border border-edge bg-panel-raised/60 px-3 py-2 text-left hover:border-edge-strong" onClick={() => open(l.url)}>
              <ExternalLink className="size-4 shrink-0 text-ink-faint" />
              <span className="text-[12.5px] text-ink">{l.label}</span>
              <span className="ml-auto truncate text-[11.5px] text-ink-faint">{l.url.replace(/^(https?:\/\/|mailto:)/, "")}</span>
            </button>
          ))}
          {!hasContact && <p className="text-[12px] text-ink-faint">No contact details yet: fill them in at src/lib/author.ts.</p>}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-5 py-3 text-[11.5px] text-ink-faint">
          <span>Project P — 3D Asset Toolkit {appInfo ? `v${appInfo.version}` : ""}</span>
          <span>Tauri 2 · Rust · React</span>
        </div>
      </div>
    </div>
  );
}
