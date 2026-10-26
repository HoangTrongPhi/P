/**
 * Persistent thumbnail cache in IndexedDB, keyed by path + size + modification time so an
 * edited file gets a new thumbnail. Kept free of three.js; rendering lives in the previewer.
 */
const DB_NAME = "pp-thumbnails";
const STORE = "thumbs";

interface Row {
  key: string;
  path: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** key -> object URL of the cached blob, so each thumbnail is decoded once per session. */
const urls = new Map<string, string>();

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" }).createIndex("path", "path");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const thumbKey = (a: { path: string; size: number; modifiedMs: number }) => `${a.path}|${a.size}|${a.modifiedMs}`;

export async function getCachedThumb(key: string): Promise<string | null> {
  const hit = urls.get(key);
  if (hit) return hit;
  try {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    const row = await new Promise<Row | undefined>((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as Row | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!row) return null;
    const url = URL.createObjectURL(row.blob);
    urls.set(key, url);
    return url;
  } catch {
    return null; // a cache that cannot open just means thumbnails are rendered again
  }
}

/** Store a thumbnail, replacing older ones of the same file. */
export async function putThumb(key: string, path: string, blob: Blob): Promise<string> {
  for (const [k, u] of urls)
    if (k !== key && k.startsWith(`${path}|`)) {
      URL.revokeObjectURL(u);
      urls.delete(k);
    }
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  try {
    const tx = (await db()).transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const old = store.index("path").getAllKeys(path);
    old.onsuccess = () => {
      for (const k of old.result) if (k !== key) store.delete(k);
      store.put({ key, path, blob } satisfies Row);
    };
    await done(tx);
  } catch {
    // keep the in-memory copy
  }
  return url;
}

export async function clearThumbCache(): Promise<void> {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  try {
    const tx = (await db()).transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch {
    // nothing cached
  }
}
