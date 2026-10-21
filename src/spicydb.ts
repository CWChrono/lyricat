// Write TTML lyrics into Spicy Lyrics' OWN local library so our edited lyrics show in its panel.
// Spicy's "Lyrics Manager" persistent uploads live in IndexedDB db "spicylyrics" (v1) → object store
// "lyricsStore", keyed by the full Spotify URI (`spotify:track:<id>`), value = the raw TTML string.
// Spicy checks this store BEFORE fetching from its API, so an entry here wins. We open with the SAME
// schema Spicy uses (version 1, out-of-line keys) — if Spicy bumps the version, this must follow.

const DB_NAME = "spicylyrics";
const DB_VERSION = 1;
const STORE = "lyricsStore";

function openSpicyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); // matches Spicy's schema
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open Spicy Lyrics database"));
    req.onblocked = () => reject(new Error("Spicy Lyrics database is blocked — close other Spotify windows"));
  });
}

/** The set of Spotify URIs that already have a local TTML entry in Spicy's library. */
export async function spicyLocalLyricUris(): Promise<Set<string>> {
  const db = await openSpicyDb();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("could not read Spicy Lyrics keys"));
    });
    return new Set(keys.map(String));
  } finally {
    db.close();
  }
}

/** Remove one track's TTML entry from Spicy's local library (e.g. on unstar). */
export async function removeSpicyLocalLyric(uri: string): Promise<void> {
  const db = await openSpicyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(uri);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("delete failed"));
      tx.onabort = () => reject(tx.error ?? new Error("delete aborted"));
    });
  } finally {
    db.close();
  }
}

/** Write (overwrite) one track's TTML into Spicy's local library — "update to latest". */
export async function writeSpicyLocalLyric(uri: string, ttml: string): Promise<void> {
  const db = await openSpicyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(ttml, uri);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("write aborted"));
    });
  } finally {
    db.close();
  }
}

/**
 * Batch-write many TTML entries in one transaction. With `missingOnly`, entries whose URI already
 * exists in Spicy's library are left untouched (the "sync all → only missing" path). Returns how many
 * were written vs skipped.
 */
export async function syncSpicyLocalLyrics(
  entries: readonly { uri: string; ttml: string }[],
  opts: { missingOnly?: boolean } = {}
): Promise<{ written: number; skipped: number }> {
  const db = await openSpicyDb();
  try {
    let existing = new Set<string>();
    if (opts.missingOnly) {
      existing = await new Promise<Set<string>>((resolve, reject) => {
        const r = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
        r.onsuccess = () => resolve(new Set((r.result as IDBValidKey[]).map(String)));
        r.onerror = () => reject(r.error ?? new Error("could not read Spicy Lyrics keys"));
      });
    }
    const todo = opts.missingOnly ? entries.filter((e) => !existing.has(e.uri)) : entries;
    if (todo.length) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const e of todo) store.put(e.ttml, e.uri);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("write failed"));
        tx.onabort = () => reject(tx.error ?? new Error("write aborted"));
      });
    }
    return { written: todo.length, skipped: entries.length - todo.length };
  } finally {
    db.close();
  }
}
