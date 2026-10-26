import { Box, Grid3x3, Loader2, Maximize, Orbit, Pause, Play, Rotate3d, Shapes, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { uiLog } from "../../stores/appStore";
import { FloatingPanel, HudButton, StatRow } from "./FloatingControls";
import { inTauri, scanFbxFiles } from "../../lib/ipc";
import { basename } from "../../lib/pathUtil";
import { ModelViewer, type ModelStats, type TextureMap, type ViewMode } from "./modelEngine";

const MODES: { mode: ViewMode; title: string; icon: typeof Box }[] = [
  { mode: "shaded", title: "Shaded", icon: Box },
  { mode: "wireframe", title: "Wireframe", icon: Shapes },
  { mode: "uv", title: "UV checker", icon: Grid3x3 },
  { mode: "normals", title: "Normals", icon: Rotate3d },
];

/**
 * Where an FBX's textures really are. FBXLoader only looks next to the model, so ask the Rust
 * doctor, which (like FBX Doctor's default) also searches the parent folder (`FBX/` + `Textures/`).
 */
async function fbxTextureMap(path: string): Promise<TextureMap | undefined> {
  if (!path.toLowerCase().endsWith(".fbx") || !inTauri) return undefined;
  try {
    const [info] = await scanFbxFiles([path]);
    const map: TextureMap = new Map();
    for (const e of info?.entries ?? []) {
      if (e.resolvedPath) map.set(basename(e.originalPath).toLowerCase(), e.resolvedPath);
    }
    return map;
  } catch (err) {
    uiLog("warn", `Texture lookup failed for ${path}: ${err}`);
    return undefined;
  }
}

const SPEEDS = [0.25, 0.5, 1, 2];

/** Clip picker, play/pause, scrubber and speed for the loaded model's animations. */
function AnimationBar({ viewer, clips }: { viewer: ModelViewer; clips: { name: string; duration: number }[] }) {
  const [clip, setClip] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const duration = clips[clip]?.duration ?? 0;

  useEffect(() => {
    viewer.onAnimationTime = setTime;
    return () => {
      viewer.onAnimationTime = undefined;
    };
  }, [viewer]);
  useEffect(() => viewer.setPlaying(playing), [viewer, playing]);
  useEffect(() => viewer.setSpeed(speed), [viewer, speed]);

  const pickClip = (i: number) => {
    setClip(i);
    viewer.selectClip(i);
  };
  const scrub = (t: number) => {
    setPlaying(false);
    viewer.seek(t);
  };

  return (
    <FloatingPanel className="bottom-3 left-1/2 flex w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 items-center gap-2 px-2 py-1.5">
      <HudButton title={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </HudButton>
      {clips.length > 1 && (
        <select
          value={clip}
          onChange={(e) => pickClip(Number(e.target.value))}
          title="Animation clip"
          className="h-7 max-w-40 truncate rounded-md border border-edge bg-canvas/70 px-1.5 text-[11.5px] text-ink outline-none focus:border-accent/60"
        >
          {clips.map((c, i) => (
            <option key={i} value={i}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <input
        type="range"
        min={0}
        max={duration}
        step={duration / 1000 || 0.001}
        value={Math.min(time, duration)}
        onChange={(e) => scrub(Number(e.target.value))}
        aria-label="Animation time"
        className="min-w-0 flex-1 accent-accent"
      />
      <span className="shrink-0 font-mono text-[11px] text-ink-muted tabular-nums">
        {time.toFixed(2)} / {duration.toFixed(2)}s
      </span>
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        title="Playback speed"
        className="h-7 rounded-md border border-edge bg-canvas/70 px-1 text-[11.5px] text-ink outline-none focus:border-accent/60"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </FloatingPanel>
  );
}

const fmt = (n: number) => n.toLocaleString();
const dim = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

/** Three.js viewport for FBX / OBJ / glTF / GLB with a floating HUD. */
export function Viewport3D({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ModelViewer | null>(null);
  const [mode, setMode] = useState<ViewMode>("shaded");
  const [grid, setGrid] = useState(true);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const viewer = new ModelViewer(hostRef.current!);
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current!;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStats(null);
    fbxTextureMap(path)
      .then((map) => (cancelled ? Promise.reject(new Error("superseded")) : viewer.load(path, map)))
      .then((s) => {
        if (cancelled) return;
        setStats(s);
        if (s.missingTextures.length) uiLog("warn", `${s.missingTextures.length} texture(s) not found for ${path}: ${s.missingTextures.join(", ")}`);
      })
      .catch((err) => {
        if (cancelled) return; // also swallows the "superseded" rejection
        setError(String(err));
        uiLog("error", `Cannot load ${path}: ${err}`);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => viewerRef.current?.setMode(mode), [mode]);
  useEffect(() => viewerRef.current?.setGrid(grid), [grid]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-edge">
      <div ref={hostRef} className="absolute inset-0" />

      <FloatingPanel className="top-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 p-1">
        {MODES.map((m) => (
          <HudButton key={m.mode} title={m.title} active={mode === m.mode} onClick={() => setMode(m.mode)}>
            <m.icon className="size-4" />
          </HudButton>
        ))}
        <div className="mx-1 h-5 w-px bg-edge-strong" />
        <HudButton title="Ground grid" active={grid} onClick={() => setGrid((g) => !g)}>
          <Orbit className="size-4" />
        </HudButton>
        <HudButton title="Reset camera" onClick={() => viewerRef.current?.resetView()}>
          <Maximize className="size-4" />
        </HudButton>
      </FloatingPanel>

      {stats && (
        <FloatingPanel className="top-3 right-3 flex w-56 flex-col gap-1 px-3 py-2.5">
          <StatRow label="Triangles" value={fmt(stats.triangles)} />
          <StatRow label="Vertices" value={fmt(stats.vertices)} />
          <StatRow label="Meshes" value={fmt(stats.meshes)} />
          <StatRow label="Materials" value={fmt(stats.materials)} />
          <StatRow label="UV sets" value={stats.uvSets} />
          {stats.skinned > 0 && <StatRow label="Skinned" value={stats.skinned} />}
          {stats.animations > 0 && <StatRow label="Animations" value={stats.animations} />}
          <div className="mt-1 border-t border-edge pt-1.5">
            <StatRow label="Size (units)" value={stats.size.map(dim).join(" × ")} />
          </div>
          {stats.missingTextures.length > 0 && (
            <div className="mt-1 flex gap-1.5 text-[11px] text-amber" title={stats.missingTextures.join("\n")}>
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {stats.missingTextures.length} texture(s) missing — check the file in FBX Doctor
            </div>
          )}
        </FloatingPanel>
      )}

      {/* Keyed by path so each model starts on its first clip, playing at 1×. */}
      {stats && stats.animations > 0 && viewerRef.current && <AnimationBar key={path} viewer={viewerRef.current} clips={viewerRef.current.getClips()} />}

      {(loading || error) && (
        <div className="absolute inset-0 grid place-items-center">
          {loading ? (
            <div className="flex items-center gap-2 rounded-lg bg-panel/80 px-3 py-2 text-[12px] text-ink-muted">
              <Loader2 className="size-4 animate-spin text-accent" /> Loading model…
            </div>
          ) : (
            <div className="max-w-md rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-[12px] text-rose select-text">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
