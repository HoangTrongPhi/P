import { ArrowLeft, Box, FolderOpen, Files, Image, LayoutGrid, Layers, List, Loader2, Package, RefreshCw, ScanEye, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { pickPaths } from "../../lib/dialogs";
import { inTauri } from "../../lib/ipc";
import { basename, humanSize } from "../../lib/pathUtil";
import { PREVIEW_EXTS, usePreviewStore } from "../../stores/previewStore";
import type { AssetFile } from "../../types/pipeline";
import { MESH_EXTS } from "../previewer/modelEngine";
import { requestThumb } from "../previewer/thumbnailRenderer";
import { TextureViewer } from "../previewer/TextureViewer";
import { Viewport3D } from "../previewer/Viewport3D";
import { EmptyState, PathText, TextField } from "../ui/Controls";
import { GlassCard } from "../ui/GlassCard";
import { PillBadge } from "../ui/PillBadge";

const extOf = (p: string) => p.split(".").pop()!.toLowerCase();

function iconFor(path: string) {
  const ext = extOf(path);
  if (MESH_EXTS.includes(ext)) return Box;
  if (ext === "psd") return Layers;
  return Image;
}

export function PreviewTab() {
  const { selected, folder, returnTo, autoReload, select, setAutoReload, reload } = usePreviewStore();
  const ext = selected ? extOf(selected) : null;

  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <AssetList />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {selected && (
          <div className="flex items-center gap-2 px-1">
            {returnTo && returnTo !== selected && (
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 rounded-md border border-edge px-2 py-0.5 text-[11.5px] text-ink-muted hover:bg-white/6 hover:text-ink"
                title={`Back to ${returnTo}`}
                onClick={() => select(returnTo)}
              >
                <ArrowLeft className="size-3.5" /> {basename(returnTo)}
              </button>
            )}
            <PathText path={selected} className="min-w-0 text-ink" />
            <PillBadge tone="accent">{ext!.toUpperCase()}</PillBadge>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {inTauri && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted" title="Reload the file (and the model's textures) when it changes on disk">
                  <input type="checkbox" className="size-3.5 accent-accent" checked={autoReload} onChange={(e) => setAutoReload(e.target.checked)} />
                  Auto-reload
                </label>
              )}
              <button type="button" className="icon-btn size-6" title="Reload from disk" onClick={() => reload([selected])}>
                <RefreshCw className="size-3.5" />
              </button>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {!selected ? (
            <GlassCard className="flex h-full items-center justify-center">
              <EmptyState icon={<ScanEye className="size-5" />} title={folder ? "No previewable assets here" : "Drop a mesh, texture or folder"}>
                3D: FBX, OBJ (+MTL), glTF, GLB. 2D: PNG, JPG, TGA, DDS, WebP, TIFF, PSD composite, and HDR / EXR with exposure control.
              </EmptyState>
            </GlassCard>
          ) : MESH_EXTS.includes(ext!) ? (
            <Viewport3D key="mesh" path={selected} />
          ) : PREVIEW_EXTS.includes(ext!) ? (
            <TextureViewer key="tex" path={selected} />
          ) : (
            <GlassCard className="flex h-full items-center justify-center">
              <EmptyState icon={<Package className="size-5" />} title="Not previewable">
                .blend scenes are handled by the Blender Packer tab.
              </EmptyState>
            </GlassCard>
          )}
        </div>
      </div>
    </div>
  );
}

/** Thumbnail that renders (or comes from the cache) once it scrolls into view. */
function Thumb({ asset }: { asset: AssetFile }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  useEffect(() => {
    let request: ReturnType<typeof requestThumb> | null = null;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || request) return;
        observer.disconnect();
        setState("loading");
        request = requestThumb(asset);
        void request.promise.then((u) => {
          if (cancelled) return;
          setUrl(u);
          setState(u ? "idle" : "failed");
        });
      },
      { rootMargin: "200px" },
    );
    observer.observe(ref.current!);
    return () => {
      cancelled = true;
      observer.disconnect();
      request?.cancel();
    };
    // A new size or modification time is a new thumbnail.
  }, [asset]);

  const Icon = iconFor(asset.path);
  return (
    <div ref={ref} className="relative grid aspect-square place-items-center overflow-hidden rounded-md bg-canvas/60">
      {url ? (
        <img src={url} alt="" className="size-full object-contain" draggable={false} />
      ) : state === "loading" ? (
        <Loader2 className="size-4 animate-spin text-ink-faint" />
      ) : (
        <Icon className={cn("size-6", state === "failed" ? "text-ink-faint/50" : "text-ink-faint")} />
      )}
      <span className="absolute top-1 right-1 rounded bg-canvas/80 px-1 text-[9px] leading-tight font-medium text-ink-muted uppercase">{extOf(asset.path)}</span>
    </div>
  );
}

function AssetList() {
  const { folder, assets, selected, scanning, filter, listView, select, setFilter, setListView, clear } = usePreviewStore();
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? assets.filter((a) => a.name.toLowerCase().includes(q)) : assets;
  }, [assets, filter]);
  const grid = listView === "grid";

  return (
    <GlassCard
      className={cn("flex shrink-0 flex-col", grid ? "w-80" : "w-64")}
      title={<span className="flex items-center gap-2">Assets {scanning && <Loader2 className="size-3.5 animate-spin text-accent" />}</span>}
      actions={
        <>
          <button type="button" className="icon-btn size-6" title={grid ? "Show as list" : "Show thumbnails"} onClick={() => setListView(grid ? "list" : "grid")}>
            {grid ? <List className="size-3.5" /> : <LayoutGrid className="size-3.5" />}
          </button>
          <button type="button" className="icon-btn size-6" title="Open folder" onClick={() => pickPaths("folder")}>
            <FolderOpen className="size-3.5" />
          </button>
          <button type="button" className="icon-btn size-6" title="Open file" onClick={() => pickPaths("files", [{ name: "Assets", extensions: PREVIEW_EXTS }])}>
            <Files className="size-3.5" />
          </button>
          <button type="button" className="icon-btn size-6" title="Clear list, cached previews and thumbnails" disabled={!folder} onClick={clear}>
            <Trash2 className="size-3.5" />
          </button>
        </>
      }
    >
      {folder && (
        <div className="flex flex-col gap-2 border-b border-edge p-2">
          <PathText path={folder} className="px-1 text-ink-faint" />
          <div className="relative">
            <Search className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-ink-faint" />
            <TextField className="w-full pl-7" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </div>
      )}
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-1.5", grid && "grid auto-rows-min grid-cols-3 gap-1.5")}>
        {shown.map((a) =>
          grid ? (
            <button
              key={a.path}
              type="button"
              onClick={() => select(a.path)}
              title={`${a.path}\n${humanSize(a.size)}`}
              className={cn("flex min-w-0 flex-col gap-1 rounded-lg p-1 text-left", a.path === selected ? "bg-accent/12 ring-1 ring-accent/30" : "hover:bg-white/4")}
            >
              <Thumb asset={a} />
              <span className="truncate px-0.5 text-[11px] text-ink">{basename(a.path)}</span>
            </button>
          ) : (
            <ListRow key={a.path} asset={a} active={a.path === selected} onClick={() => select(a.path)} />
          ),
        )}
        {folder && !scanning && shown.length === 0 && <div className="col-span-3 px-3 py-6 text-center text-[12px] text-ink-faint">No matching assets</div>}
      </div>
    </GlassCard>
  );
}

function ListRow({ asset, active, onClick }: { asset: AssetFile; active: boolean; onClick: () => void }) {
  const Icon = iconFor(asset.path);
  return (
    <button
      type="button"
      onClick={onClick}
      title={asset.path}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left", active ? "bg-accent/12 ring-1 ring-accent/25" : "hover:bg-white/4")}
    >
      <Icon className={cn("size-3.5 shrink-0", MESH_EXTS.includes(extOf(asset.path)) ? "text-accent" : "text-ink-faint")} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{basename(asset.path)}</span>
      <span className="shrink-0 text-[10.5px] text-ink-faint tabular-nums">{humanSize(asset.size)}</span>
    </button>
  );
}
