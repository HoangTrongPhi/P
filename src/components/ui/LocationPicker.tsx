import { ChevronDown, Cloud, CornerDownLeft, FolderOpen, HardDrive, Info, Loader2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pickOne } from "../../lib/dialogs";
import { cleanPath, looksLikePath, parseDriveLink, type DriveLink } from "../../lib/driveLink";
import { driveMounts, inTauri } from "../../lib/ipc";
import { basename } from "../../lib/pathUtil";
import type { DriveMount } from "../../types/pipeline";

/**
 * "Choose…" plus a Google Drive menu: the Drive for desktop mounts and their shared drives,
 * and a field for a pasted folder path or Drive link.
 */
export function LocationPicker({ onPick }: { onPick: (folder: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mounts, setMounts] = useState<DriveMount[] | null>(null);
  const [text, setText] = useState("");
  const [link, setLink] = useState<DriveLink | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (mounts === null) driveMounts().then(setMounts, () => setMounts([]));
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, mounts]);

  const pick = (folder: string) => {
    setOpen(false);
    setText("");
    setLink(null);
    onPick(folder);
  };

  const submit = () => {
    const l = parseDriveLink(text);
    if (l) return setLink(l);
    if (looksLikePath(text)) pick(cleanPath(text));
  };

  return (
    <div className="relative flex" ref={box}>
      <button type="button" className="btn rounded-r-none" onClick={async () => { const f = await pickOne("folder"); if (f) onPick(f); }}>
        Choose…
      </button>
      <button type="button" className="btn rounded-l-none border-l-0 px-1.5" aria-label="Google Drive and pasted paths" aria-expanded={open} title="Google Drive, or paste a path / link" onClick={() => setOpen(!open)}>
        <Cloud className="size-3.5" />
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-1 w-96 animate-pop-in rounded-lg border border-edge-strong bg-panel-raised p-2 shadow-2xl">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setLink(null);
              }}
              placeholder="Paste a folder path or a Google Drive link"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-edge bg-canvas/70 px-2 font-mono text-[11.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-faint focus:border-accent/60"
            />
            <button type="submit" className="icon-btn size-7" aria-label="Open" disabled={!text.trim()}>
              <CornerDownLeft className="size-3.5" />
            </button>
          </form>
          {text.trim() && !link && !looksLikePath(text) && <p className="mt-1.5 px-1 text-[11.5px] text-ink-faint">Not a folder path or a Drive link.</p>}
          {link && (
            <div className="mt-2 flex gap-2 rounded-md border border-amber/30 bg-amber/5 p-2 text-[11.5px] text-ink-muted">
              <Info className="mt-0.5 size-3.5 shrink-0 text-amber" />
              <div>
                A Drive link can't be opened as a folder: the toolkit reads files through Google Drive for desktop. Open the {link.kind} under a drive below, in <b className="text-ink">Shared drives</b> if it is on one, or add it to <b className="text-ink">My Drive</b> as a shortcut (in the browser: right-click → Organize → Add shortcut) and paste its path from Explorer.
                <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                  {link.kind} id {link.id}
                </div>
              </div>
            </div>
          )}

          <div className="mt-2 border-t border-edge pt-2">
            <div className="px-1 pb-1 text-[11px] tracking-wide text-ink-faint uppercase">Google Drive for desktop</div>
            {mounts === null ? (
              <Loader2 className="m-2 size-4 animate-spin text-ink-faint" />
            ) : mounts.length === 0 ? (
              <p className="px-1 pb-1 text-[11.5px] text-ink-faint">
                {inTauri ? "No Drive for desktop drive found. Install it and sign in; shared drives then appear as a drive letter (G:)." : "Drive mounts are listed in the desktop app."}
              </p>
            ) : (
              <div className="flex max-h-72 flex-col overflow-y-auto">
                {mounts.map((m) => (
                  <div key={m.root} className="flex flex-col">
                    <Row icon={<HardDrive className="size-3.5" />} label={m.root} hint="Drive root" onClick={() => pick(m.root)} />
                    {m.myDrive && <Row indent icon={<FolderOpen className="size-3.5" />} label="My Drive" onClick={() => pick(m.myDrive!)} />}
                    {m.sharedDrives.map((d) => (
                      <Row key={d} indent icon={<Users className="size-3.5" />} label={basename(d)} hint="Shared drive" onClick={() => pick(d)} />
                    ))}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1 px-1 text-[11px] text-ink-faint">Listing folders downloads nothing. Files download only when they are read.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ icon, label, hint, indent, onClick }: { icon: React.ReactNode; label: string; hint?: string; indent?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-ink hover:bg-panel-hover ${indent ? "pl-6" : ""}`} onClick={onClick}>
      <span className="text-ink-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
    </button>
  );
}
