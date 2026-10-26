import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { assetUrl } from "../../lib/assetUrl";
import { basename, dirname } from "../../lib/pathUtil";

export type ViewMode = "shaded" | "wireframe" | "uv" | "normals";

export interface ModelStats {
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  skinned: number;
  uvSets: number;
  animations: number;
  size: [number, number, number];
  /** Texture files the model references that could not be loaded. */
  missingTextures: string[];
}

export const MESH_EXTS = ["fbx", "obj", "gltf", "glb"];

/** Prefix that marks loader-requested resources so the URL modifier can map them to files. */
const RES = "ppfile:///";

/** A stray `%` in a file name makes decoding throw; keep the raw text then. */
function safeDecode(s: string, decode: (s: string) => string = decodeURI): string {
  try {
    return decode(s);
  } catch {
    return s;
  }
}

/** Lower-cased texture file name -> file on disk (from the Rust FBX doctor). */
export type TextureMap = Map<string, string>;

/**
 * Map a URL a loader requests (`<RES><model dir>/<relative or absolute path>`) to an asset URL.
 * FBXLoader drops every directory and asks for `<model dir>/<file name>`, so for FBX the
 * doctor's resolved locations (`textureMap`) take precedence.
 */
export function resolveResource(url: string, textureMap?: TextureMap): string {
  if (!url.startsWith(RES)) return url; // data:, blob:, http(s): stay as they are
  let p = safeDecode(url.slice(RES.length)).replace(/\\/g, "/");
  const known = textureMap?.get(basename(p).toLowerCase());
  if (known) return assetUrl(known);
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
  return assetUrl(parts.join("/"));
}

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

/** Three.js scene with orbit controls, studio lighting and on-demand rendering. */
export class ModelViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  private controls: OrbitControls;
  private grid: THREE.GridHelper;
  private model: THREE.Object3D | null = null;
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private overrides: Partial<Record<ViewMode, THREE.Material>> = {};
  private mode: ViewMode = "shaded";
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private action: THREE.AnimationAction | null = null;
  private playing = false;
  private lastTick = 0;
  /** Called every animation frame while playing, and after a seek or clip change. */
  onAnimationTime?: (time: number) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor(0x13161c);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    // Phong/Lambert (FBX, OBJ) ignore the environment map, so the lights must carry them alone.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50555f, 1.2));
    // Key light rides with the camera (from its upper left) so whatever is in view is lit.
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-1, 1.2, 0.5);
    key.target.position.set(0, 0, -2);
    this.camera.add(key, key.target);
    this.scene.add(this.camera);
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

  async load(path: string, textureMap?: TextureMap): Promise<ModelStats> {
    this.clear();
    const ext = path.split(".").pop()!.toLowerCase();
    const resourcePath = `${RES}${encodeURI(dirname(path).replace(/\\/g, "/"))}/`;
    const missing = new Set<string>();
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => resolveResource(url, textureMap));
    // Failed URLs are already asset URLs (whole path percent-encoded in one segment).
    manager.onError = (url) => missing.add(basename(safeDecode(url.replace(/\?v=\d+$/, ""), decodeURIComponent)));
    manager.addHandler(/\.tga$/i, new TGALoader(manager));
    manager.addHandler(/\.dds$/i, new DDSLoader(manager));
    const allLoaded = new Promise<void>((resolve) => {
      manager.onLoad = () => resolve();
      setTimeout(resolve, 15000); // never hang on a stuck texture
    });

    const res = await fetch(assetUrl(path));
    if (!res.ok) throw new Error(`Cannot read ${basename(path)} (${res.status})`);
    let object: THREE.Object3D;
    let animations: THREE.AnimationClip[] = [];

    if (ext === "glb" || ext === "gltf") {
      const gltf = await new GLTFLoader(manager).parseAsync(await res.arrayBuffer(), resourcePath);
      object = gltf.scene;
      animations = gltf.animations;
    } else if (ext === "fbx") {
      object = new FBXLoader(manager).parse(await res.arrayBuffer(), resourcePath);
      animations = object.animations;
    } else if (ext === "obj") {
      const text = await res.text();
      const obj = new OBJLoader(manager);
      const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1].trim();
      if (mtl) {
        const mtlRes = await fetch(resolveResource(resourcePath + encodeURI(mtl.replace(/\\/g, "/"))));
        if (mtlRes.ok) {
          const materials = new MTLLoader(manager).setResourcePath(resourcePath).parse(await mtlRes.text(), resourcePath);
          materials.preload();
          obj.setMaterials(materials);
        } else {
          missing.add(basename(mtl));
        }
      }
      object = obj.parse(text);
    } else {
      throw new Error(`Unsupported mesh format .${ext}`);
    }

    this.model = object;
    this.scene.add(object);
    object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.originals.set(o as THREE.Mesh, (o as THREE.Mesh).material);
    });
    this.applyMode();
    this.resetView();
    // FBX files often carry an empty "Take 001"; only clips that move something count.
    this.clips = animations.filter((c) => c.tracks.length > 0 && c.duration > 0);
    if (this.clips.length) {
      this.mixer = new THREE.AnimationMixer(object);
      this.selectClip(0);
    }
    this.fixBlackMaterials();
    // Textures finish after the geometry; redraw once they are in.
    void allLoaded.then(() => {
      this.fixBlackMaterials(true);
      this.render();
    });
    await Promise.race([allLoaded, new Promise((r) => setTimeout(r, 1500))]);
    return this.stats(this.clips.length, [...missing]);
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
    let meshes = 0, vertices = 0, triangles = 0, skinned = 0, uvSets = 0; // prettier-ignore
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
    const size = new THREE.Box3().setFromObject(this.model!).getSize(new THREE.Vector3());
    return { meshes, vertices, triangles: Math.round(triangles), materials: materials.size, skinned, uvSets, animations, size: [size.x, size.y, size.z], missingTextures };
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
    // Grid sits under the model and scales with it.
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

  private clear() {
    this.setPlaying(false);
    if (this.mixer && this.model) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    this.action = null;
    this.clips = [];
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
    this.clear();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    Object.values(this.overrides).forEach((m) => {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    });
    this.controls.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
