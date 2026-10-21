// Persistent, versioned LRC store. Lives in **localStorage** (the same durable store the rest
// of Cat-Jam persists to) — NOT CacheStorage, which the client can evict under storage pressure.
// Each track's LRC is saved under a versioned key, `catjam-lyric:<version>:<id>`; versioning lets
// a future LRC-format change start a fresh namespace without colliding with old entries.
//
// This holds the raw *lyric source* (stable), separate from the derived onset bop-map
// (`onsetcache.ts`, VERSION-gated) — so bumping the onset logic recomputes from the saved LRC
// rather than re-hitting LRCLIB.

const PREFIX = "catjam-lyric";
export const LRC_VERSION = "v1";

/** The localStorage key a track's LRC is stored under — `catjam-lyric:v1:<id>`. */
export function lrcKey(id: string, version: string = LRC_VERSION): string {
  return `${PREFIX}:${version}:${id}`;
}

// The slice of the Storage API we use, so tests can inject a fake. Defaults to localStorage.
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
function defaultStore(): StorageLike | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage;
}

/** The saved LRC text for a track, or null when absent / storage is unavailable. */
export async function readLrcCache(
  id: string,
  version: string = LRC_VERSION,
  store: StorageLike | undefined = defaultStore()
): Promise<string | null> {
  if (!store || !id) return null;
  try {
    return store.getItem(lrcKey(id, version)) || null;
  } catch {
    return null;
  }
}

/** Persist a track's LRC text under its versioned key. Best-effort (no-op if storage is
 *  unavailable or full); never throws. */
export async function writeLrcCache(
  id: string,
  lrc: string,
  version: string = LRC_VERSION,
  store: StorageLike | undefined = defaultStore()
): Promise<void> {
  if (!store || !id || !lrc) return;
  try {
    store.setItem(lrcKey(id, version), lrc);
  } catch {
    /* storage unavailable or quota exceeded — the LRC just won't be cached this time */
  }
}

/** The track id in a `catjam-lyric:<version>:<id>` key, or null if it isn't one. */
function idFromKey(key: string, version: string): string | null {
  const prefix = `${PREFIX}:${version}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) || null : null;
}

/** Every saved LRC for a version: `{ id, lrc }`, sorted by id. Empty when none / unavailable. */
export async function listLrcCache(
  version: string = LRC_VERSION,
  store: StorageLike | undefined = defaultStore()
): Promise<{ id: string; lrc: string }[]> {
  if (!store) return [];
  const out: { id: string; lrc: string }[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key) continue;
      const id = idFromKey(key, version);
      if (!id) continue;
      const lrc = store.getItem(key);
      if (lrc) out.push({ id, lrc });
    }
  } catch {
    return [];
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Remove one track's saved LRC. Best-effort; never throws. */
export async function deleteLrcCache(
  id: string,
  version: string = LRC_VERSION,
  store: StorageLike | undefined = defaultStore()
): Promise<void> {
  if (!store || !id) return;
  try {
    store.removeItem(lrcKey(id, version));
  } catch {
    /* nothing to remove */
  }
}
