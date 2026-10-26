import { writeFile } from "@tauri-apps/plugin-fs";
import { Bone, Box, Camera, Grid3x3, Loader2, Maximize, Move3d, Orbit, Palette, Pause, Play, Rotate3d, Shapes, Sun, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { pickOne, pickSavePath } from "../../lib/dialogs";
import { routeDrop } from "../../lib/dropRouter";
import { inTauri } from "../../lib/ipc";
import { basename, dirname, joinPath, stem } from "../../lib/pathUtil";
import { uiLog } from "../../stores/appStore";
import { usePreviewStore } from "../../stores/previewStore";
import { Checkbox } from "../ui/Controls";
import { fbxTextureMap } from "./fbxTextures";
import { FloatingPanel, HudButton, Slider, StatRow } from "./FloatingControls";
import { DEFAULT_LIGHTING, type EnvSource } from "./lighting";
import { ModelViewer, type MaterialInfo, type ModelStats, type ViewMode } from "./modelEngine";
import { useFileWatch } from "./useFileWatch";

const MODES: { mode: ViewMode; title: string; icon: typeof Box }[] = [
  { mode: "shaded", title: "Shaded", icon: Box },
  { mode: "wireframe", title: "Wireframe", icon: Shapes },
  { mode: "uv", title: "UV checker", icon: Grid3x3 },
  { mode: "normals", title: "Normals", icon: Rotate3d },
];

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

/** Paths from the engine use `/`; show and open them like the model's own path. */
const nativeLike = (p: string, like: string) => (like.includes("\\") ? p.replace(/\//g, "\\") : p);

/** Materials with their texture slots; a found texture opens in the texture inspector. */
function MaterialPanel({ materials, modelPath }: { materials: MaterialInfo[] | null; modelPath: string }) {
  const openTexture = usePreviewStore((s) => s.openTexture);
  if (!materials)
    return (
      <div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
        <Loader2 className="size-3.5 animate-spin text-accent" /> Waiting for textures…
      </div>
    );
  if (!materials.length) return <div className="text-[11.5px] text-ink-faint">No materials</div>;
  return (
    <div className="flex flex-col gap-2.5">
      {materials.map((m, i) => {
        const missing = m.slots.filter((s) => s.status === "missing").length;
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="size-3 shrink-0 rounded-sm border border-edge-strong" style={{ background: m.color ?? "transparent" }} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={m.name}>
                {m.name}
              </span>
              {missing > 0 && <TriangleAlert className="size-3.5 shrink-0 text-amber" aria-label={`${missing} missing`} />}
              <span className="shrink-0 text-[10.5px] text-ink-faint">
                {m.type} · {m.meshes} mesh{m.meshes === 1 ? "" : "es"}
              </span>
            </div>
            {m.slots.length === 0 && <div className="pl-5 text-[11px] text-ink-faint">No textures</div>}
            {m.slots.map((s) => (
              <div key={s.slot} className="flex items-center gap-2 pl-5 text-[11.5px]">
                <span className="w-24 shrink-0 text-ink-faint">{s.label}</span>
                {s.status === "ok" && s.path ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-accent hover:underline"
                    title={`Open ${nativeLike(s.path, modelPath)}`}
                    onClick={() => openTexture(nativeLike(s.path!, modelPath))}
                  >
                    {s.file}
                  </button>
                ) : (
                  <span
                    className={cn("min-w-0 flex-1 truncate", s.status === "missing" ? "text-amber" : "text-ink-muted")}
                    title={s.status === "missing" ? `Not found: ${s.path ? nativeLike(s.path, modelPath) : s.file}` : "Embedded in the model file"}
                  >
                    {s.status === "missing" ? `${s.file} (missing)` : `${s.file} (embedded)`}
                  </span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const HDRI_EXTS = ["hdr", "exr"];
const signed = (v: number, digits = 1) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

function LightingPanel() {
  const { lighting, environment, assets, setLighting, setEnvironment } = usePreviewStore();
  const hdris = useMemo(() => {
    const list = assets.filter((a) => HDRI_EXTS.includes(a.name.split(".").pop()!.toLowerCase())).map((a) => a.path);
    if (environment.kind === "hdri" && !list.includes(environment.path)) list.unshift(environment.path);
    return list;
  }, [assets, environment]);
  const value = environment.kind === "hdri" ? `hdri:${environment.path}` : environment.kind;

  const pick = async (v: string) => {
    if (v === "browse") {
      const p = await pickOne("file", [{ name: "HDRI", extensions: HDRI_EXTS }]);
      if (p) setEnvironment({ kind: "hdri", path: p });
    } else setEnvironment(v.startsWith("hdri:") ? { kind: "hdri", path: v.slice(5) } : ({ kind: v } as EnvSource));
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[11.5px] text-ink-muted">
        <span className="w-16 shrink-0">Environment</span>
        <select
          value={value}
          onChange={(e) => void pick(e.target.value)}
          className="h-7 min-w-0 flex-1 truncate rounded-md border border-edge bg-canvas/70 px-1.5 text-[11.5px] text-ink outline-none focus:border-accent/60"
        >
          <option value="studio">Studio (built-in)</option>
          <option value="none">None (lights only)</option>
          {hdris.map((p) => (
            <option key={p} value={`hdri:${p}`}>
              {basename(p)}
            </option>
          ))}
          {inTauri && <option value="browse">Browse for HDR / EXR…</option>}
        </select>
      </label>
      <Slider label="Exposure" value={lighting.exposure} min={-3} max={3} step={0.1} onChange={(exposure) => setLighting({ exposure })} onReset={() => setLighting({ exposure: 0 })} format={(v) => signed(v)} />
      <Slider label="Env strength" value={lighting.envIntensity} min={0} max={3} step={0.05} onChange={(envIntensity) => setLighting({ envIntensity })} onReset={() => setLighting({ envIntensity: 1 })} format={(v) => v.toFixed(2)} />
      <div className="mt-1 border-t border-edge pt-2 text-[10.5px] tracking-wide text-ink-faint uppercase">Key light</div>
      <Slider label="Direction" value={lighting.azimuth} min={-180} max={180} step={1} onChange={(azimuth) => setLighting({ azimuth })} onReset={() => setLighting({ azimuth: DEFAULT_LIGHTING.azimuth })} format={(v) => `${v.toFixed(0)}°`} />
      <Slider label="Height" value={lighting.elevation} min={-10} max={90} step={1} onChange={(elevation) => setLighting({ elevation })} onReset={() => setLighting({ elevation: DEFAULT_LIGHTING.elevation })} format={(v) => `${v.toFixed(0)}°`} />
      <Slider label="Intensity" value={lighting.intensity} min={0} max={6} step={0.1} onChange={(intensity) => setLighting({ intensity })} onReset={() => setLighting({ intensity: DEFAULT_LIGHTING.intensity })} format={(v) => v.toFixed(1)} />
      <Checkbox checked={lighting.follow} onChange={(follow) => setLighting({ follow })} label="Light follows the camera" />
      <Checkbox checked={lighting.background} onChange={(background) => setLighting({ background })} label="Show environment as background" />
      <div className="flex items-center justify-between gap-2 border-t border-edge pt-2">
        <span className="text-[10.5px] leading-snug text-ink-faint">FBX / OBJ (Phong) materials ignore the environment; only glTF PBR picks it up.</span>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-white/8 hover:text-ink"
          onClick={() => {
            setLighting(DEFAULT_LIGHTING);
            setEnvironment({ kind: "studio" });
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

const FBX_UNITS: Record<string, string> = { "1": "cm", "100": "m", "0.1": "mm", "2.54": "inch", "30.48": "ft" };
const unitLabel = (f: number) => FBX_UNITS[String(+f.toPrecision(4))] ?? `${f} cm`;

async function saveCapture(viewer: ModelViewer, modelPath: string) {
  const canvas = viewer.capture({ pixelRatio: 2, transparent: true });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  const name = `${stem(modelPath)}_preview.png`;
  if (!inTauri) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  const target = await pickSavePath(joinPath(dirname(modelPath), name), [{ name: "PNG image", extensions: ["png"] }]);
  if (!target) return;
  await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
  uiLog("info", `Saved viewport capture (${canvas.width} × ${canvas.height}, transparent) to ${target}`);
}

const fmt = (n: number) => n.toLocaleString();
const dim = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

/** Three.js viewport for FBX / OBJ / glTF / GLB with a floating HUD. */
export function Viewport3D({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ModelViewer | null>(null);
  /** What is on screen: a load of the same path with a newer token is a reload. */
  const loaded = useRef<{ path: string; token: number } | null>(null);
  const [mode, setMode] = useState<ViewMode>("shaded");
  const [grid, setGrid] = useState(true);
  const [axes, setAxes] = useState(false);
  const [skeleton, setSkeleton] = useState(false);
  const [panel, setPanel] = useState<"materials" | "lighting" | null>(null);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [materials, setMaterials] = useState<MaterialInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lighting, environment, reloadToken, autoReload } = usePreviewStore();

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
    // Same file again with a new token = a reload after a change on disk: keep the camera.
    // (Not merely the same path: StrictMode runs this effect twice on mount.)
    const keepView = loaded.current?.path === path && loaded.current.token !== reloadToken;
    setLoading(true);
    setError(null);
    if (!keepView) {
      setStats(null);
      setMaterials(null);
    }
    // Start on the next tick: StrictMode's throw-away mount is cancelled before it loads anything
    // (a big model loaded twice at once can exhaust GPU memory).
    new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => (cancelled ? Promise.reject(new Error("superseded")) : fbxTextureMap(path)))
      .then((map) => (cancelled ? Promise.reject(new Error("superseded")) : viewer.load(path, map, { keepView })))
      .then((s) => {
        if (cancelled) return;
        loaded.current = { path, token: reloadToken };
        setStats(s);
        if (s.missingTextures.length) uiLog("warn", `${s.missingTextures.length} texture(s) not found for ${path}: ${s.missingTextures.join(", ")}`);
        for (const w of s.warnings) uiLog("warn", `${basename(path)}: ${w}`);
        return viewer.materials().then((m) => !cancelled && setMaterials(m));
      })
      .catch((err) => {
        if (cancelled) return; // also swallows the "superseded" rejection
        setStats(null);
        setError(String(err));
        uiLog("error", `Cannot load ${path}: ${err}`);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, reloadToken]);

  useEffect(() => viewerRef.current?.setMode(mode), [mode]);
  useEffect(() => viewerRef.current?.setGrid(grid), [grid]);
  useEffect(() => viewerRef.current?.setHelpers({ axes, skeleton }), [axes, skeleton]);
  useEffect(() => viewerRef.current?.setLighting(lighting), [lighting]);
  useEffect(() => {
    viewerRef.current?.setEnvironment(environment).catch((err) => {
      uiLog("error", `Cannot use ${environment.kind === "hdri" ? environment.path : environment.kind} as environment: ${err}`);
      usePreviewStore.getState().setEnvironment({ kind: "studio" });
    });
  }, [environment]);

  // The model and every texture it loaded from disk.
  const watched = useMemo(() => [path, ...new Set((materials ?? []).flatMap((m) => m.slots.flatMap((s) => (s.path ? [nativeLike(s.path, path)] : []))))], [path, materials]);
  useFileWatch(watched, usePreviewStore.getState().reload, autoReload);

  const togglePanel = (p: "materials" | "lighting") => setPanel((cur) => (cur === p ? null : p));
  const capture = () => {
    if (viewerRef.current) saveCapture(viewerRef.current, path).catch((err) => uiLog("error", `Capture failed: ${err}`));
  };
  const missingSlots = materials?.reduce((n, m) => n + m.slots.filter((s) => s.status === "missing").length, 0) ?? 0;

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
        <HudButton title="Pivot and axes (X red, Y green, Z blue)" active={axes} onClick={() => setAxes((a) => !a)}>
          <Move3d className="size-4" />
        </HudButton>
        {!!stats?.bones && (
          <HudButton title={`Skeleton (${stats.bones} bones)`} active={skeleton} onClick={() => setSkeleton((s) => !s)}>
            <Bone className="size-4" />
          </HudButton>
        )}
        <div className="mx-1 h-5 w-px bg-edge-strong" />
        <HudButton title="Materials and textures" active={panel === "materials"} onClick={() => togglePanel("materials")}>
          <span className="relative">
            <Palette className="size-4" />
            {missingSlots > 0 && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber" />}
          </span>
        </HudButton>
        <HudButton title="Lighting and environment" active={panel === "lighting"} onClick={() => togglePanel("lighting")}>
          <Sun className="size-4" />
        </HudButton>
        <div className="mx-1 h-5 w-px bg-edge-strong" />
        <HudButton title="Reset camera" onClick={() => viewerRef.current?.resetView()}>
          <Maximize className="size-4" />
        </HudButton>
        <HudButton title="Save view as PNG (transparent background)" onClick={capture}>
          <Camera className="size-4" />
        </HudButton>
      </FloatingPanel>

      {panel && (
        <FloatingPanel className="top-14 left-3 flex max-h-[calc(100%-8rem)] w-80 flex-col">
          <div className="border-b border-edge px-3 py-2 text-[11.5px] font-medium text-ink">{panel === "materials" ? `Materials${materials ? ` (${materials.length})` : ""}` : "Lighting"}</div>
          <div className="min-h-0 overflow-y-auto px-3 py-2.5">{panel === "materials" ? <MaterialPanel materials={materials} modelPath={path} /> : <LightingPanel />}</div>
        </FloatingPanel>
      )}

      {stats && (
        <FloatingPanel className="top-14 right-3 flex w-60 flex-col gap-1 px-3 py-2.5">
          <StatRow label="Triangles" value={fmt(stats.triangles)} />
          <StatRow label="Vertices" value={fmt(stats.vertices)} />
          <StatRow label="Meshes" value={fmt(stats.meshes)} />
          <StatRow label="Materials" value={fmt(stats.materials)} />
          <StatRow label="UV sets" value={stats.uvSets} />
          {stats.skinned > 0 && <StatRow label="Skinned" value={stats.skinned} />}
          {stats.bones > 0 && <StatRow label="Bones" value={stats.bones} />}
          {stats.animations > 0 && <StatRow label="Animations" value={stats.animations} />}
          <div className="mt-1 border-t border-edge pt-1.5">
            <StatRow label="Size (units)" value={stats.size.map(dim).join(" × ")} />
            {stats.unitScale !== null && <StatRow label="File unit" value={unitLabel(stats.unitScale)} />}
          </div>
          {stats.warnings.map((w) => (
            <div key={w} className="mt-1 flex gap-1.5 text-[11px] leading-snug text-amber">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {w}
            </div>
          ))}
          {stats.missingTextures.length > 0 && (
            <div className="mt-1 flex gap-1.5 text-[11px] leading-snug text-amber" title={stats.missingTextures.join("\n")}>
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span>
                {stats.missingTextures.length} texture(s) missing
                {path.toLowerCase().endsWith(".fbx") ? (
                  <>
                    {" — "}
                    <button type="button" className="underline hover:text-ink" onClick={() => routeDrop("fbx", [path])}>
                      open in FBX Doctor
                    </button>
                  </>
                ) : (
                  " — see Materials"
                )}
              </span>
            </div>
          )}
        </FloatingPanel>
      )}

      {/* Keyed by path so each model starts on its first clip, playing at 1×. */}
      {stats && stats.animations > 0 && viewerRef.current && <AnimationBar key={`${path}#${reloadToken}`} viewer={viewerRef.current} clips={viewerRef.current.getClips()} />}

      {(loading || error) && (
        <div className={cn("absolute inset-0 grid place-items-center", stats && "pointer-events-none")}>
          {loading ? (
            !stats && (
              <div className="flex items-center gap-2 rounded-lg bg-panel/80 px-3 py-2 text-[12px] text-ink-muted">
                <Loader2 className="size-4 animate-spin text-accent" /> Loading model…
              </div>
            )
          ) : (
            <div className="max-w-md rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-[12px] text-rose select-text">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
