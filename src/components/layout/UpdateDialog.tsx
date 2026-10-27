import { CheckCircle2, Download, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useUpdateStore } from "../../stores/updateStore";
import { ProgressBar } from "../ui/Controls";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Check for updates: current vs new version, release notes, download progress, install & restart. */
export function UpdateDialog() {
  const open = useUpdateStore((s) => s.dialogOpen);
  const setOpen = useUpdateStore((s) => s.setDialogOpen);
  const { phase, available, downloaded, total, error, checkForUpdates, installAndRestart } = useUpdateStore();
  const appInfo = useAppStore((s) => s.appInfo);
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/60 p-4 backdrop-blur-[2px]" onMouseDown={() => !busy && setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        className="w-full max-w-md animate-pop-in overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <RefreshCw className="size-4 text-accent" />
          <h2 id="update-title" className="flex-1 text-[14px] font-semibold text-ink">
            Check for updates
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4 text-[12.5px] text-ink-muted">
          <div>
            Installed version: <span className="font-mono text-ink">{appInfo ? `v${appInfo.version}` : "—"}</span>
          </div>

          {phase === "checking" && (
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-accent" /> Looking for a newer release…
            </div>
          )}

          {phase === "upToDate" && (
            <div className="flex items-center gap-2 text-emerald">
              <CheckCircle2 className="size-4" /> You have the latest version.
            </div>
          )}

          {available && (phase === "available" || phase === "downloading" || phase === "installing") && (
            <>
              <div className="flex items-center gap-2 text-ink">
                <Download className="size-4 text-accent" />
                <span>
                  Version <span className="font-mono font-semibold">v{available.version}</span> is available
                  {available.date && <span className="text-ink-faint"> · {available.date.slice(0, 10)}</span>}
                </span>
              </div>
              {available.notes && (
                <pre className="max-h-48 overflow-y-auto rounded-md border border-edge bg-canvas/70 p-2.5 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                  {available.notes}
                </pre>
              )}
            </>
          )}

          {phase === "downloading" && (
            <div className="flex flex-col gap-1.5">
              <ProgressBar value={downloaded} total={total} indeterminate={total === 0} />
              <div className="text-[11.5px] text-ink-faint">{total > 0 ? `${mb(downloaded)} / ${mb(total)}` : mb(downloaded)}</div>
            </div>
          )}

          {phase === "installing" && (
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-accent" /> Installing, Poseidon will restart…
            </div>
          )}

          {phase === "error" && (
            <div className="flex items-start gap-2 text-amber">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
          {phase === "available" ? (
            <>
              <button type="button" className="btn h-8" onClick={() => setOpen(false)}>
                Later
              </button>
              <button type="button" className="btn btn-primary h-8" onClick={() => void installAndRestart()}>
                <Download className="size-3.5" /> Install &amp; restart
              </button>
            </>
          ) : (
            <button type="button" className="btn h-8" disabled={busy} onClick={() => void checkForUpdates()}>
              <RefreshCw className="size-3.5" /> Check again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
