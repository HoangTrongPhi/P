/** Viewport lighting settings; free of three.js so the preview store can hold them. */
export interface LightingParams {
  /** Tone-mapping exposure in stops. */
  exposure: number;
  /** Key light direction in degrees; relative to the view when `follow` is on. */
  azimuth: number;
  elevation: number;
  intensity: number;
  follow: boolean;
  envIntensity: number;
  /** Show the environment behind the model instead of the flat backdrop. */
  background: boolean;
}

export type EnvSource = { kind: "studio" } | { kind: "none" } | { kind: "hdri"; path: string };

export const DEFAULT_LIGHTING: LightingParams = { exposure: 0, azimuth: -22, elevation: 24, intensity: 2.2, follow: true, envIntensity: 1, background: false };
