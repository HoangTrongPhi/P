import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { assetUrl } from "../../lib/assetUrl";
import { basename, dirname } from "../../lib/pathUtil";
import { DEFAULT_LIGHTING, type EnvSource, type LightingParams } from "./lighting";

export type ViewMode = "shaded" | "wireframe" | "uv" | "normals";

export interface ModelStats {
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  skinned: number;
  bones: number;
  uvSets: number;
  animations: number;
  size: [number, number, number];
  /** FBX `UnitScaleFactor` (centimetres per file unit), when the file has one. */
  unitScale: number | null;
  /** Export problems worth a look: odd scale, pivot far from the geometry. */
  warnings: string[];
  /** Texture files the model references that could not be loaded. */
  missingTextures: string[];
}

export interface TextureSlot {
  /** Material property, e.g. `normalMap`. */
  slot: string;
  label: string;
  file: string;
  /** File on disk; null for embedded or unresolvable textures. */
  path: string | null;
  status: "ok" | "missing" | "embedded";
}

export interface MaterialInfo {
  name: string;
  type: string;
  meshes: number;
  /** Base color as `#rrggbb`, when the material has one. */
  color: string | null;
  slots: TextureSlot[];
}

export const MESH_EXTS = ["fbx", "obj", "gltf", "glb"];

/** Prefix that marks loader-requested resources so the URL modifier can map them to files. */
const RES = "ppfile:///";
const BACKDROP = 0x13161c;

/** A stray `%` in a file name makes decoding throw; keep the raw text then. */
function safeDecode(s: string, decode: (s: string) => string = decodeURI): string {
  try {
    return decode(s);
  } catch {
    return s;
  }
}

/** Absolute form without the cache-busting query, so loader URLs and `img.src` compare equal. */
function urlKey(url: string): string {
  try {
    const u = new URL(url, location.href);
    u.search = "";
    return u.href;
  } catch {
    return url;
  }
}

/** Lower-cased texture file name -> file on disk (from the Rust FBX doctor). */
export type TextureMap = Map<string, string>;

/**
 * The file behind a URL a loader requests (`<RES><model dir>/<relative or absolute path>`), or
 * null for data:, blob: and http(s): URLs. FBXLoader drops every directory and asks for
 * `<model dir>/<file name>`, so for FBX the doctor's resolved locations (`textureMap`) win.
 */
export function resolvePath(url: string, textureMap?: TextureMap): string | null {
  if (!url.startsWith(RES)) return null;
  let p = safeDecode(url.slice(RES.length)).replace(/\\/g, "/");
  const known = textureMap?.get(basename(p).toLowerCase());
  if (known) return known;
  const drive = [...p.matchAll(/[A-Za-z]:\//g)].pop();
  if (drive && drive.index! > 0) p = p.slice(drive.index); // embedded absolute Windows path
  const unc = p.indexOf("//", 1);
  if (unc > 0 && !/^[A-Za-z]:\//.test(p.slice(unc - 2))) p = p.slice(unc); // embedded UNC path
  // Normalize "a/b/../c".
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Map a loader URL to an asset URL (see `resolvePath`). */
export function resolveResource(url: string, textureMap?: TextureMap): string {
  const p = resolvePath(url, textureMap);
  return p === null ? url : assetUrl(p);
}

const SLOT_LABELS: Record<string, string> = {
  map: "Base color",
  normalMap: "Normal",
  roughnessMap: "Roughness",
  metalnessMap: "Metalness",
  aoMap: "Ambient occlusion",
  emissiveMap: "Emissive",
  bumpMap: "Bump",
  displacementMap: "Displacement",
  alphaMap: "Opacity",
  specularMap: "Specular",
  lightMap: "Lightmap",
};

const slotLabel = (key: string) => SLOT_LABELS[key] ?? key.replace(/Map$/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

function makeChecker(): THREE.Texture {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const n = 8;
  const cell = size / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? "#2b2f38" : "#d8dbe2";
      g.fillRect(x * cell, y * cell, cell, cell);
      g.fillStyle = (x + y) % 2 ? "#9aa1b0" : "#3b82f6";
      g.font = "bold 22px sans-serif";
      g.fillText(`${String.fromCharCode(65 + x)}${n - y}`, x * cell + 8, y * cell + 28);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Shrink a texture's image so its longest side is at most `max` pixels. Big asset libraries carry
 * dozens of 4K maps; at full size they exhaust the WebView's GPU process, which takes the whole
 * app down. Runs before the first upload, so only the small copy ever reaches the GPU.
 */
function capTexture(t: THREE.Texture, max: number) {
  const img = t.image as (CanvasImageSource & { width: number; height: number }) | null;
  if (!img || !(img instanceof HTMLImageElement || img instanceof ImageBitmap || img instanceof HTMLCanvasElement)) return;
  const scale = max / Math.max(img.width, img.height);
  if (!(scale < 1)) return;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  // A CPU-backed canvas: a GPU one would upload the full-size source to resize it, and keep its
  // own copy in GPU memory next to the texture.
  c.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0, c.width, c.height);
  if (img instanceof ImageBitmap) img.close();
  t.userData.originalSize = [img.width, img.height];
  t.image = c;
  t.needsUpdate = true;
}

/**
 * Run a synchronous parse with every TextureLoader texture tagged with the URL it requested
 * (`userData.sourceUrl`; a failed image keeps no `src`, and the inspector still wants its name)
 * and capped to `maxSize` pixels once its image arrives.
 */
function tagTextureUrls<T>(manager: THREE.LoadingManager, maxSize: number, parse: () => T): T {
  const original = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (this: THREE.TextureLoader, url, onLoad, ...rest) {
    if (this.manager !== manager) return original.call(this, url, onLoad, ...rest);
    const t = original.call(
      this,
      url,
      (tex) => {
        capTexture(tex, maxSize);
        onLoad?.(tex);
      },
      ...rest,
    );
    t.userData.sourceUrl = manager.resolveURL((this.path ?? "") + url);
    return t;
  };
  try {
    return parse();
  } finally {
    THREE.TextureLoader.prototype.load = original;
  }
}

/** Free a model's GPU and image resources. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

const fmtUnits = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2));

/** Three.js scene with orbit controls, studio lighting and on-demand rendering. */
export class ModelViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  private controls: OrbitControls;
  private grid: THREE.GridHelper;
  private key = new THREE.DirectionalLight(0xffffff, DEFAULT_LIGHTING.intensity);
  private lighting: LightingParams = { ...DEFAULT_LIGHTING };
  private studioEnv: THREE.Texture;
  private hdri: { path: string; equirect: THREE.Texture; env: THREE.Texture } | null = null;
  private envKind: EnvSource["kind"] = "studio";
  private model: THREE.Object3D | null = null;
  private ext = "";
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private overrides: Partial<Record<ViewMode, THREE.Material>> = {};
  private mode: ViewMode = "shaded";
  private skeleton: THREE.SkeletonHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private showSkeleton = false;
  private showAxes = false;
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private action: THREE.AnimationAction | null = null;
  private playing = false;
  private lastTick = 0;
  /** Bumped by every load so a slow, superseded load does not publish its results. */
  private generation = 0;
  private settled: Promise<void> = Promise.resolve();
  private report: MaterialInfo[] = [];
  /** Where a loaded texture came from (set per load; the source format decides how). */
  private sourceOf: (t: THREE.Texture) => { path: string | null; embedded: boolean } = () => ({ path: null, embedded: false });
  /** Called every animation frame while playing, and after a seek or clip change. */
  onAnimationTime?: (time: number) => void;

  constructor(private host: HTMLElement) {
    // alpha so a capture can have a transparent background; the backdrop is the clear color.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor(BACKDROP, 1);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.studioEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.studioEnv;
    // Phong/Lambert (FBX, OBJ) ignore the environment map, so the lights must carry them alone.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50555f, 1.2));
    // Key light rides with the camera by default so whatever is in view is lit.
    this.scene.add(this.camera);
    this.applyKeyLight();
    // Fixed rim light from behind for the silhouette.
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(-3, 4, -5);
    this.scene.add(rim);
    this.grid = new THREE.GridHelper(10, 20, 0x4a505c, 0x2c3038);
    this.scene.add(this.grid);

    this.camera.position.set(3, 2, 4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (this.playing) return; // the animation loop draws every frame anyway
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }

  private tick = () => {
    const now = performance.now();
    this.mixer?.update((now - this.lastTick) / 1000);
    this.lastTick = now;
    this.renderer.render(this.scene, this.camera);
    if (this.action) this.onAnimationTime?.(this.action.time);
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Name and length (seconds) of each playable clip of the loaded model. */
  getClips(): { name: string; duration: number }[] {
    return this.clips.map((c, i) => ({ name: c.name || `Clip ${i + 1}`, duration: c.duration }));
  }

  /** Switch to a clip, posed at its first frame; keeps the play/pause state. */
  selectClip(index: number) {
    const clip = this.clips[index];
    if (!this.mixer || !clip) return;
    this.mixer.stopAllAction();
    this.action = this.mixer.clipAction(clip).reset().play();
    this.mixer.update(0);
    this.onAnimationTime?.(0);
    this.render();
  }

  setPlaying(on: boolean) {
    if (!this.action) on = false;
    if (on === this.playing) return;
    this.playing = on;
    cancelAnimationFrame(this.frame);
    if (on) {
      this.lastTick = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    } else {
      this.render();
    }
  }

  seek(time: number) {
    if (!this.action || !this.mixer) return;
    this.action.time = time;
    this.mixer.update(0);
    this.onAnimationTime?.(time);
    this.render();
  }

  setSpeed(scale: number) {
    if (this.mixer) this.mixer.timeScale = scale;
  }

  /**
   * `keepView` keeps the camera where it is (a reload of the same file); `maxTextureSize` caps
   * every texture's longest side (full-size maps stay viewable in the texture inspector).
   */
  async load(path: string, textureMap?: TextureMap, { keepView = false, maxTextureSize = 2048 } = {}): Promise<ModelStats> {
    this.clear();
    const gen = ++this.generation;
    const ext = path.split(".").pop()!.toLowerCase();
    this.ext = ext;
    const resourcePath = `${RES}${encodeURI(dirname(path).replace(/\\/g, "/"))}/`;
    const missing = new Set<string>();
    const sources = new Map<string, string>(); // urlKey(asset URL) -> file
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const p = resolvePath(url, textureMap);
      if (p === null) return url;
      const u = assetUrl(p);
      sources.set(urlKey(u), p);
      return u;
    });
    // Failed URLs are already asset URLs (whole path percent-encoded in one segment).
    manager.onError = (url) => missing.add(basename(safeDecode(url.replace(/\?v=\d+$/, ""), decodeURIComponent)));
    for (const [re, loader] of [
      [/\.tga$/i, new TGALoader(manager)],
      [/\.dds$/i, new DDSLoader(manager)],
    ] as const) {
      // Data textures keep no URL of their own; remember it for the material inspector.
      const load = loader.load.bind(loader) as (url: string, ...rest: unknown[]) => THREE.Texture;
      (loader as { load: unknown }).load = (url: string, ...rest: unknown[]) => {
        const t = load(url, ...rest);
        t.userData.sourceUrl = manager.resolveURL((loader.path ?? "") + url);
        return t;
      };
      manager.addHandler(re, loader);
    }
    // LoadingManager only reports onLoad after something started, so count requests ourselves.
    let pending = 0;
    let settle!: () => void;
    const allLoaded = new Promise<void>((resolve) => {
      settle = resolve;
      setTimeout(resolve, 15000); // never hang on a stuck texture
    });
    const { itemStart, itemEnd } = manager;
    manager.itemStart = (url) => {
      pending++;
      itemStart(url);
    };
    manager.itemEnd = (url) => {
      itemEnd(url);
      if (--pending === 0) settle();
    };

    const res = await fetch(assetUrl(path));
    if (!res.ok) throw new Error(`Cannot read ${basename(path)} (${res.status})`);
    // A newer load() started while this one was waiting: never add both models.
    const superseded = () => gen !== this.generation;
    let object: THREE.Object3D;
    let animations: THREE.AnimationClip[] = [];
    const fromUrl = (t: THREE.Texture) => {
      const url = (t.userData.sourceUrl as string | undefined) ?? (t.image as { src?: string } | null)?.src;
      if (!url) return { path: null, embedded: false };
      if (/^(blob|data):/.test(url)) return { path: null, embedded: true };
      return { path: sources.get(urlKey(url)) ?? null, embedded: false };
    };

    if (ext === "glb" || ext === "gltf") {
      const gltf = await new GLTFLoader(manager).parseAsync(await res.arrayBuffer(), resourcePath);
      object = gltf.scene;
      animations = gltf.animations;
      // parseAsync waits for the images, and nothing has been drawn yet.
      object.traverse((o) => {
        const mats = (o as THREE.Mesh).material;
        if (mats) for (const m of Array.isArray(mats) ? mats : [mats]) for (const v of Object.values(m)) if (v instanceof THREE.Texture) capTexture(v, maxTextureSize);
      });
      this.sourceOf = (t) => this.gltfSource(gltf, t, resourcePath, textureMap);
    } else if (ext === "fbx") {
      const data = await res.arrayBuffer();
      object = tagTextureUrls(manager, maxTextureSize, () => new FBXLoader(manager).parse(data, resourcePath));
      animations = object.animations;
      this.sourceOf = fromUrl;
    } else if (ext === "obj") {
      const text = await res.text();
      const obj = new OBJLoader(manager);
      const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1].trim();
      if (mtl) {
        const mtlRes = await fetch(resolveResource(resourcePath + encodeURI(mtl.replace(/\\/g, "/"))));
        if (mtlRes.ok) {
          const materials = new MTLLoader(manager).setResourcePath(resourcePath).parse(await mtlRes.text(), resourcePath);
          tagTextureUrls(manager, maxTextureSize, () => materials.preload());
          obj.setMaterials(materials);
        } else {
          missing.add(basename(mtl));
        }
      }
      object = obj.parse(text);
      this.sourceOf = fromUrl;
    } else {
      throw new Error(`Unsupported mesh format .${ext}`);
    }
    if (pending === 0) settle(); // nothing to fetch (or everything already arrived)
    if (superseded()) {
      disposeObject(object);
      throw new Error("superseded");
    }

    this.model = object;
    this.scene.add(object);
    object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.originals.set(o as THREE.Mesh, (o as THREE.Mesh).material);
    });
    this.applyMode();
    if (keepView) this.fitGrid();
    else this.resetView();
    this.applyHelpers();
    // FBX files often carry an empty "Take 001"; only clips that move something count.
    this.clips = animations.filter((c) => c.tracks.length > 0 && c.duration > 0);
    if (this.clips.length) {
      this.mixer = new THREE.AnimationMixer(object);
      this.selectClip(0);
    }
    this.fixBlackMaterials();
    // Textures finish after the geometry; inventory and redraw once they are in.
    this.settled = allLoaded.then(() => {
      if (gen !== this.generation) return;
      this.report = this.inventory();
      this.fixBlackMaterials(true);
      this.render();
    });
    await Promise.race([this.settled, new Promise((r) => setTimeout(r, 1500))]);
    return this.stats(this.clips.length, [...missing]);
  }

  /** glTF textures come from `images[].uri`; the parser's associations lead there. */
  private gltfSource(gltf: GLTF, t: THREE.Texture, resourcePath: string, textureMap?: TextureMap) {
    const index = gltf.parser.associations.get(t)?.textures;
    const json = gltf.parser.json as { textures?: { source?: number }[]; images?: { uri?: string }[] };
    const image = index === undefined ? undefined : json.images?.[json.textures?.[index]?.source ?? -1];
    if (!image) return { path: null, embedded: false };
    if (!image.uri || image.uri.startsWith("data:")) return { path: null, embedded: true };
    return { path: resolvePath(resourcePath + image.uri, textureMap), embedded: false };
  }

  /** Resolves once the current model's textures have loaded (or given up). */
  whenSettled(): Promise<void> {
    return this.settled;
  }

  /** Materials of the loaded model with their texture slots, once textures have settled. */
  async materials(): Promise<MaterialInfo[]> {
    const gen = this.generation;
    await this.settled;
    return gen === this.generation ? this.report : [];
  }

  /** Taken before dead maps are stripped, so missing textures still show up in their slot. */
  private inventory(): MaterialInfo[] {
    const byMaterial = new Map<THREE.Material, number>();
    for (const mat of this.originals.values()) for (const m of Array.isArray(mat) ? mat : [mat]) byMaterial.set(m, (byMaterial.get(m) ?? 0) + 1);
    return [...byMaterial].map(([m, meshes], i) => {
      const slots: TextureSlot[] = [];
      for (const [key, v] of Object.entries(m)) {
        if (!(v instanceof THREE.Texture) || key === "envMap") continue;
        const src = this.sourceOf(v);
        const file = src.path ? basename(src.path) : v.name || (src.embedded ? "embedded" : "unknown");
        const status = v.version === 0 ? "missing" : src.embedded ? "embedded" : "ok";
        slots.push({ slot: key, label: slotLabel(key), file, path: src.path, status });
      }
      const color = (m as THREE.MeshStandardMaterial).color;
      return { name: m.name || `Material ${i + 1}`, type: m.type.replace(/^Mesh|Material$/g, ""), meshes, color: color instanceof THREE.Color ? `#${color.getHexString()}` : null, slots };
    });
  }

  /**
   * A texture that failed to load samples as black, and exporters often write a black base
   * color or black vertex colors next to a texture. Strip the dead maps and fall back to grey.
   */
  private fixBlackMaterials(stripDeadMaps = false) {
    const nearBlack = (c: THREE.Color) => c.r + c.g + c.b < 0.03;
    for (const [mesh, mat] of this.originals) {
      const colors = mesh.geometry.getAttribute("color");
      for (const m of (Array.isArray(mat) ? mat : [mat]) as THREE.MeshStandardMaterial[]) {
        let changed = false;
        for (const [key, v] of Object.entries(m)) {
          // version 0 = no image ever arrived; only judged once loading has settled.
          if (stripDeadMaps && v instanceof THREE.Texture && v.version === 0) {
            (m as unknown as Record<string, unknown>)[key] = null;
            v.dispose();
            changed = true;
          }
        }
        if (!m.map && m.color && nearBlack(m.color) && !(m.emissive && !nearBlack(m.emissive))) {
          m.color.setRGB(0.7, 0.7, 0.7);
          changed = true;
        }
        if (m.vertexColors && colors) {
          let max = 0;
          for (let i = 0; i < colors.count && max < 0.02; i++) max = Math.max(max, colors.getX(i), colors.getY(i), colors.getZ(i));
          if (max < 0.02) {
            m.vertexColors = false;
            changed = true;
          }
        }
        if (changed) m.needsUpdate = true;
      }
    }
  }

  private stats(animations: number, missingTextures: string[]): ModelStats {
    let meshes = 0, vertices = 0, triangles = 0, skinned = 0, uvSets = 0, bones = 0; // prettier-ignore
    const materials = new Set<THREE.Material>();
    for (const [mesh, mat] of this.originals) {
      meshes++;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned++;
      const g = mesh.geometry;
      const pos = g.getAttribute("position");
      if (pos) {
        vertices += pos.count;
        triangles += (g.index ? g.index.count : pos.count) / 3;
      }
      uvSets = Math.max(uvSets, Object.keys(g.attributes).filter((k) => /^uv\d*$/.test(k)).length);
      (Array.isArray(mat) ? mat : [mat]).forEach((m) => materials.add(m));
    }
    this.model!.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones++;
    });
    const box = new THREE.Box3().setFromObject(this.model!);
    const size = box.getSize(new THREE.Vector3());
    const unitScale = typeof this.model!.userData.unitScaleFactor === "number" ? (this.model!.userData.unitScaleFactor as number) : null;
    return {
      meshes, vertices, triangles: Math.round(triangles), materials: materials.size, skinned, bones, uvSets, animations, // prettier-ignore
      size: [size.x, size.y, size.z],
      unitScale,
      warnings: box.isEmpty() ? [] : this.exportWarnings(box, size, unitScale),
      missingTextures,
    };
  }

  /** Heuristics for scale and pivot mistakes that only show up once the asset is in an engine. */
  private exportWarnings(box: THREE.Box3, size: THREE.Vector3, unitScale: number | null): string[] {
    const out: string[] = [];
    const largest = Math.max(size.x, size.y, size.z);
    // glTF is metres by definition; FBX states its unit (centimetres when it does not); OBJ has none.
    const metres = this.ext === "fbx" ? (largest * (unitScale ?? 1)) / 100 : largest;
    const unit = this.ext === "obj" ? "units (OBJ has no unit)" : "m";
    // 200 m: big enough for architecture, small enough to catch a ×100 character or prop.
    if (metres > 200) out.push(`Largest side is ${fmtUnits(metres)} ${unit}: exported in centimetres or with a ×100 scale?`);
    else if (metres < 0.02) out.push(`Largest side is ${fmtUnits(metres)} ${unit}: very small, a ×0.01 scale applied twice?`);
    const gap = box.distanceToPoint(new THREE.Vector3());
    if (gap > largest * 0.5) out.push(`Pivot is ${fmtUnits(gap)} units away from the geometry`);
    return out;
  }

  resetView() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 0.8).normalize().multiplyScalar(dist));
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.fitGrid();
  }

  /** Grid sits under the model and scales with it. */
  private fitGrid() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 3 || 10;
    this.scene.remove(this.grid);
    this.grid.dispose();
    const visible = this.grid.visible;
    this.grid = new THREE.GridHelper(span, 20, 0x4a505c, 0x2c3038);
    this.grid.position.set(center.x, box.min.y, center.z);
    this.grid.visible = visible;
    this.scene.add(this.grid);
    this.render();
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.applyMode();
    this.render();
  }

  private applyMode() {
    if (this.mode === "uv" && !this.overrides.uv) this.overrides.uv = new THREE.MeshStandardMaterial({ map: makeChecker(), roughness: 0.8, side: THREE.DoubleSide });
    if (this.mode === "normals" && !this.overrides.normals) this.overrides.normals = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    for (const [mesh, original] of this.originals) {
      const list = Array.isArray(original) ? original : [original];
      list.forEach((m) => ("wireframe" in m ? ((m as THREE.MeshStandardMaterial).wireframe = this.mode === "wireframe") : null));
      const override = this.overrides[this.mode];
      mesh.material = override ?? original;
    }
  }

  setGrid(on: boolean) {
    this.grid.visible = on;
    this.render();
  }

  // ------------------------------------------------------------ helpers

  setHelpers({ skeleton, axes }: { skeleton?: boolean; axes?: boolean }) {
    if (skeleton !== undefined) this.showSkeleton = skeleton;
    if (axes !== undefined) this.showAxes = axes;
    this.applyHelpers();
    this.render();
  }

  private removeHelpers() {
    for (const h of [this.skeleton, this.axes]) {
      if (!h) continue;
      this.scene.remove(h);
      h.dispose();
    }
    this.skeleton = this.axes = null;
  }

  /** Bones drawn through the mesh; world axes at the asset's pivot (the scene origin). */
  private applyHelpers() {
    this.removeHelpers();
    if (!this.model) return;
    if (this.showSkeleton) {
      const helper = new THREE.SkeletonHelper(this.model);
      if (helper.bones.length) {
        this.skeleton = helper;
        this.scene.add(helper);
      } else helper.dispose();
    }
    if (this.showAxes) {
      const size = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3());
      this.axes = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.6 || 1);
      const m = this.axes.material as THREE.Material;
      m.depthTest = false;
      m.transparent = true;
      this.axes.renderOrder = 999;
      this.scene.add(this.axes);
    }
  }

  // ------------------------------------------------------------ lighting

  setLighting(p: Partial<LightingParams>) {
    Object.assign(this.lighting, p);
    this.renderer.toneMappingExposure = 2 ** this.lighting.exposure;
    this.scene.environmentIntensity = this.lighting.envIntensity;
    this.applyKeyLight();
    this.applyBackground();
    this.render();
  }

  /** Azimuth 0 / elevation 0 = from the front (the camera when following). */
  private applyKeyLight() {
    const { azimuth, elevation, intensity, follow } = this.lighting;
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(elevation);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const parent = follow ? this.camera : this.scene;
    if (this.key.parent !== parent) {
      parent.add(this.key, this.key.target);
    }
    // Following: shine from `dir` (camera space) towards a point in front of the camera.
    this.key.target.position.set(0, 0, follow ? -1 : 0);
    this.key.position.copy(dir).multiplyScalar(5).add(this.key.target.position);
    this.key.intensity = intensity;
  }

  /** Studio room, no environment, or an equirectangular HDR / EXR as image-based light. */
  async setEnvironment(src: EnvSource): Promise<void> {
    if (src.kind === "hdri" && this.hdri?.path !== src.path) {
      const ext = src.path.split(".").pop()!.toLowerCase();
      const equirect = await (ext === "exr" ? new EXRLoader() : new HDRLoader()).loadAsync(assetUrl(src.path));
      equirect.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromEquirectangular(equirect).texture;
      pmrem.dispose();
      this.disposeHdri();
      this.hdri = { path: src.path, equirect, env };
    }
    this.envKind = src.kind;
    this.scene.environment = src.kind === "studio" ? this.studioEnv : src.kind === "hdri" ? this.hdri!.env : null;
    this.applyBackground();
    this.render();
  }

  private applyBackground() {
    const show = this.lighting.background;
    this.scene.background = !show ? null : this.envKind === "hdri" ? this.hdri!.equirect : this.envKind === "studio" ? this.studioEnv : null;
    this.scene.backgroundBlurriness = this.envKind === "studio" ? 0.5 : 0;
    this.scene.backgroundIntensity = this.lighting.envIntensity;
  }

  private disposeHdri() {
    this.hdri?.equirect.dispose();
    this.hdri?.env.dispose();
    this.hdri = null;
  }

  // ------------------------------------------------------------ capture

  /**
   * Draw one frame at `pixelRatio` into a new 2D canvas. With `transparent`, the backdrop,
   * environment background and grid are left out so the PNG has an alpha channel.
   */
  capture({ pixelRatio = 2, transparent = true } = {}): HTMLCanvasElement {
    const { clientWidth: w, clientHeight: h } = this.host;
    const ratio = Math.min(pixelRatio, 4096 / Math.max(w, h, 1));
    const prevRatio = this.renderer.getPixelRatio();
    const background = this.scene.background;
    const grid = this.grid.visible;
    if (transparent) {
      this.scene.background = null;
      this.grid.visible = false;
      this.renderer.setClearAlpha(0);
    }
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.renderer.render(this.scene, this.camera);
    // Copy in the same task: the WebGL drawing buffer is cleared once the frame is presented.
    const out = document.createElement("canvas");
    out.width = this.renderer.domElement.width;
    out.height = this.renderer.domElement.height;
    out.getContext("2d")!.drawImage(this.renderer.domElement, 0, 0);
    this.scene.background = background;
    this.grid.visible = grid;
    this.renderer.setClearAlpha(1);
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.render(this.scene, this.camera);
    return out;
  }

  private clear() {
    this.setPlaying(false);
    this.removeHelpers();
    if (this.mixer && this.model) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    this.action = null;
    this.clips = [];
    this.report = [];
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = this.originals.get(mesh) ?? mesh.material;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
    });
    this.originals.clear();
    this.model = null;
  }

  dispose() {
    this.generation++;
    this.clear();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    Object.values(this.overrides).forEach((m) => {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    });
    this.controls.dispose();
    this.studioEnv.dispose();
    this.disposeHdri();
    this.renderer.dispose();
    // Release the WebGL context now rather than whenever it is garbage-collected.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
