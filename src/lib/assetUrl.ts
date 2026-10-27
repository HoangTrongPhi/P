import { convertFileSrc } from "@tauri-apps/api/core";

/** Set by the dev-only mock backend: paths are then project-relative URLs served by Vite. */
const mock = () => !!(globalThis as { __PP_MOCK__?: boolean }).__PP_MOCK__;

/** Bumped to make the WebView refetch files it has cached (the asset protocol ignores the query). */
let revision = 0;

export function bumpAssetRevision() {
  revision++;
}

/** URL that streams a local file through Tauri's `asset://` protocol. */
export function assetUrl(path: string): string {
  const url = mock() ? path.replace(/\\/g, "/") : convertFileSrc(path);
  return revision ? `${url}?v=${revision}` : url;
}
