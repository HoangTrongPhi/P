import { getCachedThumb, putThumb, thumbKey } from "../../lib/thumbCache";
import type { AssetFile } from "../../types/pipeline";
import { fbxTextureMap } from "./fbxTextures";
import { MESH_EXTS, ModelViewer } from "./modelEngine";
import { TextureViewer } from "./textureEngine";

const SIZE = 160;

/** One hidden viewer per kind, reused for every thumbnail (WebGL contexts are scarce). */
let host: HTMLDivElement | null = null;
let models: ModelViewer | null = null;
let textures: TextureViewer | null = null;

function offscreenHost(): HTMLDivElement {
  const el = document.createElement("div");
  // Laid out (ResizeObserver needs a size) but off screen.
  Object.assign(el.style, { position: "fixed", left: "-10000px", top: "0", width: `${SIZE}px`, height: `${SIZE}px`, pointerEvents: "none" });
  host ??= Object.assign(document.createElement("div"), { ariaHidden: "true" });
  if (!host.isConnected) document.body.appendChild(host);
  host.appendChild(el);
  return el;
}

async function render(path: string): Promise<Blob | null> {
  const ext = path.split(".").pop()!.toLowerCase();
  let canvas: HTMLCanvasElement;
  if (MESH_EXTS.includes(ext)) {
    models ??= new ModelViewer(offscreenHost());
    models.setGrid(false);
    // Thumbnail-sized maps: full-size textures for a whole folder would exhaust GPU memory.
    await models.load(path, await fbxTextureMap(path), { maxTextureSize: 128 });
    await models.whenSettled();
    canvas = models.capture({ pixelRatio: 1, transparent: true });
  } else {
    textures ??= new TextureViewer(offscreenHost());
    await textures.load(path);
    canvas = textures.capture();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
}

interface Job {
  asset: AssetFile;
  resolve: (url: string | null) => void;
}

const queue: Job[] = [];
/** Files that failed once this session; not retried until the cache is cleared. */
const failed = new Set<string>();
let running = false;

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    // Newest request first: that is what just scrolled into view.
    const job = queue.pop()!;
    const key = thumbKey(job.asset);
    try {
      const blob = await render(job.asset.path);
      job.resolve(blob ? await putThumb(key, job.asset.path, blob) : null);
    } catch {
      failed.add(key);
      job.resolve(null);
    }
  }
  running = false;
}

/** Cached thumbnail URL, or render one in the background. `cancel` drops a queued request. */
export function requestThumb(asset: AssetFile): { promise: Promise<string | null>; cancel: () => void } {
  let job: Job | null = null;
  const promise = (async () => {
    const key = thumbKey(asset);
    const cached = await getCachedThumb(key);
    if (cached || failed.has(key)) return cached;
    return new Promise<string | null>((resolve) => {
      job = { asset, resolve };
      queue.push(job);
      void pump();
    });
  })();
  const cancel = () => {
    const i = job ? queue.indexOf(job) : -1;
    if (i >= 0) {
      queue.splice(i, 1);
      job!.resolve(null);
    }
  };
  return { promise, cancel };
}

/** Drop pending work and the hidden viewers (Clear in the asset list). */
export function resetThumbnails() {
  queue.splice(0).forEach((j) => j.resolve(null));
  failed.clear();
  models?.dispose();
  textures?.dispose();
  models = textures = null;
  host?.remove();
  host = null;
}
