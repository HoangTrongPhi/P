import * as THREE from "three";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { assetUrl } from "../../lib/assetUrl";
import { decodeImage } from "../../lib/ipc";

export type Channel = "rgba" | "rgb" | "alpha" | "r" | "g" | "b";
const CHANNEL_INDEX: Record<Channel, number> = { rgba: 0, rgb: 1, alpha: 2, r: 3, g: 4, b: 5 };

export const TEXTURE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds", "hdr", "exr", "psd", "tif", "tiff"];

export interface TextureInfo {
  width: number;
  height: number;
  /** HDR / EXR: linear float data where exposure matters. */
  isFloat: boolean;
  format: string;
}

interface Loaded {
  texture: THREE.Texture;
  width: number;
  height: number;
  /** Values are display-referred (sRGB) rather than linear. */
  srgb: boolean;
  /** Row 0 of the uploaded data is the top of the image. */
  topDown: boolean;
}

async function loadTexture(path: string, ext: string): Promise<Loaded> {
  const url = assetUrl(path);
  switch (ext) {
    case "hdr": {
      const t = await new HDRLoader().loadAsync(url);
      return { texture: t, width: t.image.width, height: t.image.height, srgb: false, topDown: !t.flipY };
    }
    case "exr": {
      const t = await new EXRLoader().loadAsync(url);
      // EXRLoader already stores rows bottom-up (it reports flipY = false regardless).
      return { texture: t, width: t.image.width, height: t.image.height, srgb: false, topDown: false };
    }
    case "tga": {
      const t = await new TGALoader().loadAsync(url);
      return { texture: t, width: t.image.width, height: t.image.height, srgb: true, topDown: !t.flipY };
    }
    case "dds": {
      const t = await new DDSLoader().loadAsync(url);
      return { texture: t, width: t.image.width, height: t.image.height, srgb: true, topDown: true };
    }
    case "psd":
    case "tif":
    case "tiff": {
      const img = await decodeImage(path);
      const t = new THREE.DataTexture(img.pixels, img.width, img.height, THREE.RGBAFormat);
      t.needsUpdate = true;
      return { texture: t, width: img.width, height: img.height, srgb: true, topDown: true };
    }
    default: {
      const t = await new THREE.TextureLoader().loadAsync(url);
      return { texture: t, width: t.image.width, height: t.image.height, srgb: true, topDown: false };
    }
  }
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float exposure;
uniform float gamma;
uniform int channel;
uniform bool srgb;
uniform bool flipY;
varying vec2 vUv;
void main() {
  vec2 uv = flipY ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec4 t = texture2D(map, uv);
  // Work in linear light: exposure is in stops, gamma is the display gamma (2.2 = unchanged sRGB).
  vec3 lin = srgb ? pow(max(t.rgb, 0.0), vec3(2.2)) : t.rgb;
  vec3 c = pow(max(lin * exp2(exposure), 0.0), vec3(1.0 / gamma));
  float a = clamp(t.a, 0.0, 1.0);
  vec2 cell = floor(gl_FragCoord.xy / 8.0);
  vec3 checker = mix(vec3(0.16), vec3(0.24), mod(cell.x + cell.y, 2.0));
  vec3 outc;
  if (channel == 0) outc = mix(checker, c, a);
  else if (channel == 1) outc = c;
  else if (channel == 2) outc = vec3(a);
  else if (channel == 3) outc = vec3(c.r);
  else if (channel == 4) outc = vec3(c.g);
  else outc = vec3(c.b);
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

/** GPU texture inspector: pan (drag), zoom (wheel, towards the cursor), exposure, gamma, channels. */
export class TextureViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  private material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private texture: THREE.Texture | null = null;
  private size = { w: 1, h: 1 };
  private zoom = 1;
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private drag: { x: number; y: number } | null = null;
  onZoom: (zoom: number) => void = () => {};

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // The shader writes display values itself.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x101217);
    host.appendChild(this.renderer.domElement);
    const el = this.renderer.domElement;
    el.style.display = "block";
    el.style.cursor = "grab";

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        map: { value: null },
        exposure: { value: 0 },
        gamma: { value: 2.2 },
        channel: { value: 0 },
        srgb: { value: true },
        flipY: { value: false },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.quad.visible = false;
    this.scene.add(this.quad);

    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  /** `keepView` keeps pan and zoom when the image size is unchanged (a reload of the same file). */
  async load(path: string, { keepView = false } = {}): Promise<TextureInfo> {
    const ext = path.split(".").pop()!.toLowerCase();
    const loaded = await loadTexture(path, ext);
    this.texture?.dispose();
    const t = loaded.texture;
    t.colorSpace = THREE.NoColorSpace; // sample raw values; the shader decides
    t.magFilter = THREE.NearestFilter; // crisp pixels when zoomed in
    t.needsUpdate = true;
    this.texture = t;
    const sameSize = this.size.w === loaded.width && this.size.h === loaded.height;
    this.size = { w: loaded.width, h: loaded.height };
    this.material.uniforms.map.value = t;
    this.material.uniforms.srgb.value = loaded.srgb;
    this.material.uniforms.flipY.value = loaded.topDown;
    this.quad.scale.set(loaded.width, loaded.height, 1);
    this.quad.visible = true;
    if (keepView && sameSize) this.render();
    else this.fit();
    return { width: loaded.width, height: loaded.height, isFloat: !loaded.srgb, format: ext.toUpperCase() };
  }

  setParams(p: { exposure?: number; gamma?: number; channel?: Channel }) {
    const u = this.material.uniforms;
    if (p.exposure !== undefined) u.exposure.value = p.exposure;
    if (p.gamma !== undefined) u.gamma.value = p.gamma;
    if (p.channel !== undefined) u.channel.value = CHANNEL_INDEX[p.channel];
    this.render();
  }

  /** Fit the whole image with a small margin. */
  fit() {
    const { clientWidth: w, clientHeight: h } = this.host;
    this.setZoom(Math.min((w * 0.92) / this.size.w, (h * 0.92) / this.size.h) || 1);
    this.camera.position.set(0, 0, 1);
    this.updateCamera();
  }

  /** 100%: one image pixel per CSS pixel. */
  actualSize() {
    this.setZoom(1);
    this.updateCamera();
  }

  private setZoom(z: number) {
    this.zoom = Math.min(Math.max(z, 0.01), 64);
    this.onZoom(this.zoom);
  }

  private updateCamera() {
    const { clientWidth: w, clientHeight: h } = this.host;
    const hw = w / 2 / this.zoom;
    const hh = h / 2 / this.zoom;
    Object.assign(this.camera, { left: -hw, right: hw, top: hh, bottom: -hh });
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.updateCamera();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.renderer.domElement.getBoundingClientRect();
    // World point under the cursor stays put while zooming.
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = rect.height / 2 - (e.clientY - rect.top);
    const before = { x: this.camera.position.x + mx / this.zoom, y: this.camera.position.y + my / this.zoom };
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
    this.camera.position.x = before.x - mx / this.zoom;
    this.camera.position.y = before.y - my / this.zoom;
    this.updateCamera();
  };

  private onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY };
    this.renderer.domElement.style.cursor = "grabbing";
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag) return;
    this.camera.position.x -= (e.clientX - this.drag.x) / this.zoom;
    this.camera.position.y += (e.clientY - this.drag.y) / this.zoom;
    this.drag = { x: e.clientX, y: e.clientY };
    this.render();
  };

  private onUp = () => {
    this.drag = null;
    this.renderer.domElement.style.cursor = "grab";
  };

  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }

  /** Draw the current view now and copy it into a 2D canvas (the WebGL buffer is not kept). */
  capture(): HTMLCanvasElement {
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement("canvas");
    out.width = this.renderer.domElement.width;
    out.height = this.renderer.domElement.height;
    out.getContext("2d")!.drawImage(this.renderer.domElement, 0, 0);
    return out;
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.texture?.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
