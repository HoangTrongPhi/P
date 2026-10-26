import { Box, FolderOpen, Files, Image, Layers, Loader2, Package, ScanEye, Search, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { pickPaths } from "../../lib/dialogs";
import { basename, humanSize } from "../../lib/pathUtil";
import { PREVIEW_EXTS, usePreviewStore } from "../../stores/previewStore";
import { MESH_EXTS } from "../previewer/modelEngine";
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
  const selected = usePreviewStore((s) => s.selected);
  const folder = usePreviewStore((s) => s.folder);
  const ext = selected ? extOf(selected) : null;

  return (
    <div className="flex h-full min-h-0 gap-3 p-4">
      <AssetList />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {selected && (
          <div className="flex items-center gap-2 px-1">
            <PathText path={selected} className="text-ink" />
            <PillBadge tone="accent">{ext!.toUpperCase()}</PillBadge>
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

function AssetList() {
  const { folder, assets, selected, scanning, filter, select, setFilter, clear } = usePreviewStore();
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? assets.filter((a) => a.name.toLowerCase().includes(q)) : assets;
  }, [assets, filter]);

  return (
    <GlassCard
      className="flex w-64 shrink-0 flex-col"
      title={<span className="flex items-center gap-2">Assets {scanning && <Loader2 className="size-3.5 animate-spin text-accent" />}</span>}
      actions={
        <>
          <button type="button" className="icon-btn size-6" title="Open folder" onClick={() => pickPaths("folder")}>
            <FolderOpen className="size-3.5" />
          </button>
          <button type="button" className="icon-btn size-6" title="Open file" onClick={() => pickPaths("files", [{ name: "Assets", extensions: PREVIEW_EXTS }])}>
            <Files className="size-3.5" />
          </button>
          <button type="button" className="icon-btn size-6" title="Clear list and cached previews" disabled={!folder} onClick={clear}>
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
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.map((a) => {
          const Icon = iconFor(a.path);
          return (
            <button
              key={a.path}
              type="button"
              onClick={() => select(a.path)}
              title={a.path}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left", a.path === selected ? "bg-accent/12 ring-1 ring-accent/25" : "hover:bg-white/4")}
            >
              <Icon className={cn("size-3.5 shrink-0", MESH_EXTS.includes(extOf(a.path)) ? "text-accent" : "text-ink-faint")} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{basename(a.path)}</span>
              <span className="shrink-0 text-[10.5px] text-ink-faint tabular-nums">{humanSize(a.size)}</span>
            </button>
          );
        })}
        {folder && !scanning && shown.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-faint">No matching assets</div>}
      </div>
    </GlassCard>
  );
}
