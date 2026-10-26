import { Loader2, Maximize, Scan } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { uiLog } from "../../stores/appStore";
import { usePreviewStore } from "../../stores/previewStore";
import { Segmented } from "../ui/Controls";
import { FloatingPanel, HudButton, Slider, StatRow } from "./FloatingControls";
import { TextureViewer as Engine, type Channel, type TextureInfo } from "./textureEngine";
import { useFileWatch } from "./useFileWatch";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "rgba", label: "RGBA" },
  { value: "rgb", label: "RGB" },
  { value: "alpha", label: "A" },
  { value: "r", label: "R" },
  { value: "g", label: "G" },
  { value: "b", label: "B" },
];

/** 2D texture / HDR inspector with exposure, gamma and channel isolation. */
export function TextureViewer({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [info, setInfo] = useState<TextureInfo | null>(null);
  const [zoom, setZoom] = useState(1);
  const [exposure, setExposure] = useState(0);
  const [gamma, setGamma] = useState(2.2);
  const [channel, setChannel] = useState<Channel>("rgba");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const engine = new Engine(hostRef.current!);
    engine.onZoom = setZoom;
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const reloadToken = usePreviewStore((s) => s.reloadToken);
  const autoReload = usePreviewStore((s) => s.autoReload);
  const loaded = useRef<{ path: string; token: number } | null>(null);
  useFileWatch([path], usePreviewStore.getState().reload, autoReload);

  useEffect(() => {
    let cancelled = false;
    // Same file with a new token = a reload: keep pan and zoom (StrictMode mounts twice).
    const keepView = loaded.current?.path === path && loaded.current.token !== reloadToken;
    setLoading(!keepView);
    setError(null);
    engineRef.current!
      .load(path, { keepView })
      .then((i) => {
        if (cancelled) return;
        loaded.current = { path, token: reloadToken };
        setInfo(i);
      })
      .catch((err) => {
        if (cancelled) return;
        setInfo(null);
        setError(String(err));
        uiLog("error", `Cannot open ${path}: ${err}`);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, reloadToken]);

  useEffect(() => engineRef.current?.setParams({ exposure, gamma, channel }), [exposure, gamma, channel]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-edge">
      <div ref={hostRef} className="absolute inset-0" />

      <FloatingPanel className="top-3 left-3 flex flex-col gap-2 px-3 py-2.5">
        <Segmented size="sm" value={channel} onChange={setChannel} options={CHANNELS} />
        <Slider label="Exposure" value={exposure} min={-5} max={5} step={0.1} onChange={setExposure} onReset={() => setExposure(0)} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} />
        <Slider label="Gamma" value={gamma} min={0.2} max={3} step={0.05} onChange={setGamma} onReset={() => setGamma(2.2)} format={(v) => v.toFixed(2)} />
      </FloatingPanel>

      <FloatingPanel className="top-3 right-3 flex items-center gap-0.5 p-1">
        <HudButton title="Fit to view" onClick={() => engineRef.current?.fit()}>
          <Maximize className="size-4" />
        </HudButton>
        <HudButton title="Actual size (100%)" onClick={() => engineRef.current?.actualSize()}>
          <Scan className="size-4" />
        </HudButton>
        <span className="w-14 text-center font-mono text-[11.5px] text-ink-muted tabular-nums">{Math.round(zoom * 100)}%</span>
      </FloatingPanel>

      {info && (
        <FloatingPanel className="bottom-3 left-3 flex w-44 flex-col gap-1 px-3 py-2">
          <StatRow label="Format" value={info.format} />
          <StatRow label="Size" value={`${info.width} × ${info.height}`} />
          <StatRow label="Data" value={info.isFloat ? "float (linear)" : "8-bit sRGB"} />
        </FloatingPanel>
      )}

      {(loading || error) && (
        <div className="absolute inset-0 grid place-items-center">
          {loading ? (
            <div className="flex items-center gap-2 rounded-lg bg-panel/80 px-3 py-2 text-[12px] text-ink-muted">
              <Loader2 className="size-4 animate-spin text-accent" /> Decoding…
            </div>
          ) : (
            <div className="max-w-md rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-[12px] text-rose select-text">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
