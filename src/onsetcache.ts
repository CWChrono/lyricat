// Persist a track's computed "bop map" (its pulse onset spans) so replays reuse it
// instead of re-reading Spicy Lyrics' cache, re-parsing, and re-estimating syllables
// every time. Stored compactly in one LocalStorage key as delta-encoded integers:
//
//   "<ver>|<base>|<Δ0>+<d0>,<Δ1>+<d1>,…"
//
// where `base` is the first onset's start (ms), each `Δ` is the gap from the previous
// onset's start, and `d` (optional) is the note's duration. Deltas are small integers,
// so a whole song is a few hundred short tokens. Bumping VERSION invalidates every
// cached map at once (e.g. after an estimator change), so stale bop maps are ignored.

import { PulseOnset } from "./pulse";
import { KeyValueStore } from "./overrides";

// Bump on any change to the onset computation (syllable counter / line spread) so
// every stale bop map is ignored and recomputed with the new rule.
const VERSION = "13"; // 13: main-cat onsets are now singer-driven (everything except Mittens/"a"),
// not lane-driven — bump so caches built under the old !secondary&&!duet rule recompute.
const CACHE_KEY = "catjam-onset-cache";
const MAX_ENTRIES = 500; // FIFO cap; oldest tracks drop out to bound LocalStorage

/** Delta-encode onset spans into the compact string form (empty string if none). */
export function encodeOnsets(onsets: readonly PulseOnset[]): string {
  if (!onsets || onsets.length === 0) return "";
  const sorted = [...onsets].sort((a, b) => a.start - b.start);
  const base = Math.round(sorted[0].start);
  let prev = base;
  const tokens: string[] = [];
  for (const o of sorted) {
    const start = Math.round(o.start);
    const delta = start - prev;
    prev = start;
    const dur = typeof o.end === "number" && o.end > o.start ? Math.round(o.end - o.start) : null;
    tokens.push(dur !== null ? `${delta}+${dur}` : `${delta}`);
  }
  return `${VERSION}|${base}|${tokens.join(",")}`;
}

/** Decode the compact form back into onset spans, or null if empty/malformed/stale. */
export function decodeOnsets(encoded: string | null | undefined): PulseOnset[] | null {
  if (!encoded) return null;
  const parts = encoded.split("|");
  if (parts.length !== 3 || parts[0] !== VERSION) return null; // wrong version → recompute
  const base = Number(parts[1]);
  if (!Number.isFinite(base)) return null;
  const out: PulseOnset[] = [];
  let cursor = base;
  for (const token of parts[2].split(",")) {
    if (!token) continue;
    const [dStr, durStr] = token.split("+");
    const delta = Number(dStr);
    if (!Number.isFinite(delta)) return null;
    const start = cursor + delta;
    cursor = start;
    if (durStr !== undefined) {
      const dur = Number(durStr);
      if (Number.isFinite(dur)) out.push({ start, end: start + dur });
      else return null;
    } else {
      out.push({ start });
    }
  }
  return out.length ? out : null;
}

// Memoize the parsed map keyed by the raw stored string (same trick as overrides.readOverrides), so
// a burst of saves — each of which reads the map, mutates one entry, and writes it back — doesn't
// JSON.parse the whole (up to 500-entry) blob every time. Any write changes the raw string, and the
// writers below refresh this memo in lockstep with store.set, so reads after a write stay instant too.
let mapCacheRaw: string | null = null;
let mapCacheObj: Record<string, string> = {};

function readMap(store: KeyValueStore): Record<string, string> {
  try {
    const raw = store.get(CACHE_KEY) || "{}";
    if (raw === mapCacheRaw) return mapCacheObj;
    const parsed = JSON.parse(raw);
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    mapCacheRaw = raw;
    mapCacheObj = obj;
    return obj;
  } catch {
    return {};
  }
}

/** Persist a freshly-mutated map and refresh the read memo so it matches the store with no re-parse. */
function writeMap(store: KeyValueStore, map: Record<string, string>): void {
  const raw = JSON.stringify(map);
  store.set(CACHE_KEY, raw);
  mapCacheRaw = raw;
  mapCacheObj = map;
}

/** The cached bop map for a track id, or null when absent/stale. */
export function readOnsetCache(store: KeyValueStore, id: string): PulseOnset[] | null {
  if (!id) return null;
  const map = readMap(store);
  return decodeOnsets(map[id]);
}

/** Drop every cached bop map (e.g. after switching syllable-estimation modes, so
 *  the next play recomputes with the new rule). */
export function clearOnsetCache(store: KeyValueStore): void {
  try {
    writeMap(store, {});
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/** Drop ONE track's cached bop map, so its next play recomputes from scratch (e.g. after the
 *  user deletes its generated LRC and we want a fresh regeneration). No-op when absent. */
export function removeOnsetCache(store: KeyValueStore, id: string): void {
  if (!id) return;
  if (!(id in readMap(store))) return;
  const map = { ...readMap(store) }; // mutate a clone — the memo only advances atomically via writeMap
  delete map[id];
  try {
    writeMap(store, map);
  } catch {
    /* storage unavailable — best-effort */
  }
}

/** Persist a track's bop map, evicting the oldest entries past the FIFO cap. */
export function writeOnsetCache(store: KeyValueStore, id: string, onsets: readonly PulseOnset[]): void {
  if (!id || !onsets || onsets.length === 0) return;
  const map = { ...readMap(store) }; // mutate a clone — the memo only advances atomically via writeMap
  delete map[id]; // re-insert at the end so it's the freshest key
  map[id] = encodeOnsets(onsets);
  const ids = Object.keys(map);
  for (let i = 0; i < ids.length - MAX_ENTRIES; i++) delete map[ids[i]]; // drop oldest
  try {
    writeMap(store, map);
  } catch {
    /* storage full / unavailable — the map is best-effort, just skip caching */
  }
}
