// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Lyricat Japanese romanizer — a SEPARATE Spicetify extension, compiled by its own esbuild step (see
// apply.sh), NOT by spicetify-creator. Keeping kuroshiro/kuromoji out of the main bundle is deliberate:
// spicetify-creator's bundler mangles their CJS/ESM interop and crashes the whole extension.
//
// CRITICAL: the vendor libs are loaded LAZILY via dynamic import() INSIDE the init, never as top-level
// imports. If a vendor module throws while evaluating in Spotify's runtime, we still want (a) the global
// `window.__catjamJa` to exist, and (b) the real error to surface on use — not a silent "not loaded".
// Top-level here does nothing heavier than register the global + define pure IndexedDB helpers.
//
// Dictionary: downloaded once from a CDN, cached DECOMPRESSED in IndexedDB → offline every later session.
// kuromoji's browser loader fetches+gunzips each file AND mangles the CDN URL via path.join, so we patch
// its loadArrayBuffer to rebuild a clean URL and layer IndexedDB caching around its own fetch/gunzip.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import "./node-shim"; // MUST be first: defines process/global before any vendor module evaluates
// Static imports (not dynamic import()) — esbuild's dynamic-import interop resolved the classes to
// non-constructors ("u is not a constructor"); static imports construct correctly. The node-shim above
// runs first, so `process` is defined before these vendor modules evaluate.
import * as KuroshiroNS from "kuroshiro";
import * as KuromojiAnalyzerNS from "kuroshiro-analyzer-kuromoji";
import * as BrowserDictionaryLoaderNS from "kuromoji/src/loader/BrowserDictionaryLoader";

/* eslint-disable @typescript-eslint/no-explicit-any */
const Kuroshiro: any = (KuroshiroNS as any).default ?? (KuroshiroNS as any);
const KuromojiAnalyzer: any = (KuromojiAnalyzerNS as any).default ?? (KuromojiAnalyzerNS as any);
const BrowserDictionaryLoaderCls: any = (BrowserDictionaryLoaderNS as any).default ?? (BrowserDictionaryLoaderNS as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

const CDN_DICT = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/"; // version-pinned → cache can't mismatch

// ── IndexedDB cache of the decompressed dict files (keyed by filename). Pure — no vendor code. ──
const DB_NAME = "catjam-kuromoji";
const STORE = "dict";
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as ArrayBuffer) ?? null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
async function idbPut(key: string, val: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const r = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    });
  } catch {
    /* storage unavailable → re-fetch from CDN each session */
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function patchLoader(BrowserDictionaryLoader: any): void {
  const proto = BrowserDictionaryLoader?.prototype;
  if (!proto || proto.__catjamPatched) return;
  const orig = proto.loadArrayBuffer; // kuromoji's XHR fetch + gunzip → decompressed buffer
  proto.loadArrayBuffer = function (url: string, callback: (err: unknown, buffer: ArrayBuffer | null) => void): void {
    const file = String(url).split(/[\\/]/).pop() || ""; // "base.dat.gz" — survives path.join mangling
    const cleanUrl = CDN_DICT + file;
    idbGet(file)
      .then((cached) => {
        if (cached) {
          callback(null, cached); // offline hit
          return;
        }
        orig.call(this, cleanUrl, (err: unknown, buffer: ArrayBuffer | null) => {
          if (!err && buffer) void idbPut(file, buffer);
          callback(err, buffer);
        });
      })
      .catch(() => orig.call(this, cleanUrl, callback));
  };
  proto.__catjamPatched = true;
}

// Lazy singleton — construction/dict-load happens on first use, but the classes are the statically
// imported ones above (constructed correctly, unlike esbuild's dynamic-import interop).
let kuroshiroP: Promise<any> | null = null;
function getKuroshiro(): Promise<any> {
  if (!kuroshiroP) {
    kuroshiroP = (async () => {
      patchLoader(BrowserDictionaryLoaderCls);
      const k = new Kuroshiro();
      await k.init(new KuromojiAnalyzer({ dictPath: CDN_DICT }));
      return k;
    })().catch((e) => {
      kuroshiroP = null; // allow a retry
      throw e;
    });
  }
  return kuroshiroP;
}

async function romanizeWords(words: string[]): Promise<string[]> {
  const k = await getKuroshiro();
  return Promise.all(
    words.map(async (w) => {
      const t = (w || "").trim();
      if (!t) return "";
      try {
        const r: string = await k.convert(t, { to: "romaji", romajiSystem: "hepburn", mode: "normal" });
        return r.replace(/\s+/g, "") || t;
      } catch {
        return t;
      }
    })
  );
}

// Register the global IMMEDIATELY — before any vendor code can run/throw — so the main extension always
// sees it. Real init failures surface via romanizeWords rejecting (shown as "Romanize failed — …").
(window as unknown as { __catjamJa?: unknown }).__catjamJa = {
  romanizeWords,
  ready: (): boolean => !!kuroshiroP,
  warm: (): Promise<unknown> => getKuroshiro(),
};
/* eslint-enable @typescript-eslint/no-explicit-any */
