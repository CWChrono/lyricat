// Persisted per-track data keyed by Spotify track id. Holds a manually resolved
// `bpm` (used when ReccoBeats' id lookup has no tempo) and/or a `doubleTime`
// flag that overrides the automatic octave-fold detection.
const STORAGE_KEY = "catjam-doubletime-overrides";

/** Minimal key/value store — Spicetify.LocalStorage satisfies this shape. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const MAX_DELAY_MS = 500;

export interface TrackOverride {
  /** Human-readable "Song - Artist", stored for readability in the whitelist. */
  name?: string;
  /** Manual BPM override; authoritative for playback when set. */
  bpm?: number;
  /** The auto-detected BPM, preserved even after a manual override so it can be reset to. */
  detectedBpm?: number;
  /** true = treat as double-time (halve), false = trust the raw tempo. */
  doubleTime?: boolean;
  /** Manual sync offset in ms [0, MAX_DELAY_MS] applied before the cat restarts. */
  delayMs?: number;
}

function isBpm(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isDelay(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Clamp an arbitrary number to a whole millisecond delay in range. */
export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(ms)));
}

/**
 * Read the whole map, tolerating missing/corrupt storage and migrating the
 * legacy `{ id: boolean }` shape (double-time only) to `{ id: { doubleTime } }`.
 */
export function readOverrides(store: KeyValueStore): Record<string, TrackOverride> {
  try {
    const parsed = JSON.parse(store.get(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, TrackOverride> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") {
        out[id] = { doubleTime: value }; // legacy format
      } else if (value && typeof value === "object") {
        const entry: TrackOverride = {};
        const { name, bpm, detectedBpm, doubleTime, delayMs } = value as TrackOverride;
        if (typeof name === "string" && name) entry.name = name;
        if (isBpm(bpm)) entry.bpm = bpm;
        if (isBpm(detectedBpm)) entry.detectedBpm = detectedBpm;
        if (typeof doubleTime === "boolean") entry.doubleTime = doubleTime;
        if (isDelay(delayMs)) entry.delayMs = clampDelay(delayMs);
        out[id] = entry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Stored data for a track, or undefined when nothing is recorded. */
export function getOverride(store: KeyValueStore, id: string): TrackOverride | undefined {
  return readOverrides(store)[id];
}

function writeOverride(
  store: KeyValueStore,
  id: string,
  patch: TrackOverride
): TrackOverride {
  const all = readOverrides(store);
  const merged: TrackOverride = { ...(all[id] ?? {}), ...patch };
  // Reconstruct with a stable, readable field order (name first).
  const ordered: TrackOverride = {};
  if (merged.name !== undefined) ordered.name = merged.name;
  if (merged.bpm !== undefined) ordered.bpm = merged.bpm;
  if (merged.detectedBpm !== undefined) ordered.detectedBpm = merged.detectedBpm;
  if (merged.doubleTime !== undefined) ordered.doubleTime = merged.doubleTime;
  if (merged.delayMs !== undefined) ordered.delayMs = merged.delayMs;
  all[id] = ordered;
  store.set(STORAGE_KEY, JSON.stringify(all));
  return ordered;
}

/** Persist the "Song - Artist" label for a track. */
export function setTrackName(store: KeyValueStore, id: string, name: string): void {
  if (name) writeOverride(store, id, { name });
}

/** Delete a track's entry from the whitelist. Returns true if one was removed. */
export function removeOverride(store: KeyValueStore, id: string): boolean {
  const all = readOverrides(store);
  if (!(id in all)) return false;
  delete all[id];
  store.set(STORAGE_KEY, JSON.stringify(all));
  return true;
}

/**
 * Best-effort search of whitelist entries by their stored name. `pattern` is
 * treated as a case-insensitive regex, falling back to a substring match if it
 * isn't valid regex. Returns the matching track ids.
 */
export function matchByName(store: KeyValueStore, pattern: string): string[] {
  const map = readOverrides(store);
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = null;
  }
  const needle = pattern.toLowerCase();
  return Object.entries(map)
    .filter(
      ([, o]) =>
        typeof o.name === "string" &&
        (re ? re.test(o.name) : o.name.toLowerCase().includes(needle))
    )
    .map(([id]) => id);
}

/** Persist a manual BPM override for a track (authoritative for playback). */
export function setStoredBpm(store: KeyValueStore, id: string, bpm: number): void {
  if (isBpm(bpm)) writeOverride(store, id, { bpm });
}

/** Persist the auto-detected BPM for a track (kept even when bpm is overridden). */
export function setDetectedBpm(store: KeyValueStore, id: string, bpm: number): void {
  if (isBpm(bpm)) writeOverride(store, id, { detectedBpm: bpm });
}

/**
 * Drop a track's manual bpm override (reverting playback to the detected bpm).
 * Removes the whole entry if nothing meaningful remains.
 */
export function clearStoredBpm(store: KeyValueStore, id: string): void {
  const all = readOverrides(store);
  const entry = all[id];
  if (!entry || entry.bpm === undefined) return;
  delete entry.bpm;
  if (
    entry.detectedBpm === undefined &&
    entry.doubleTime === undefined &&
    entry.delayMs === undefined
  ) {
    delete all[id]; // only a name (or nothing) left
  } else {
    all[id] = entry;
  }
  store.set(STORAGE_KEY, JSON.stringify(all));
}

/** Persist a manual sync delay (ms) for a track, clamped to [0, MAX_DELAY_MS]. */
export function setDelayMs(store: KeyValueStore, id: string, ms: number): void {
  writeOverride(store, id, { delayMs: clampDelay(ms) });
}

/**
 * Flip the effective double-time state and persist it. With no explicit flag
 * yet, `autoDoubleTime` (what the heuristic currently does) is the starting
 * point, so one press always inverts the behaviour the user is seeing.
 * Returns the newly stored value.
 */
export function flipDoubleTime(
  store: KeyValueStore,
  id: string,
  autoDoubleTime: boolean
): boolean {
  const current = readOverrides(store)[id]?.doubleTime;
  const next = !(typeof current === "boolean" ? current : autoDoubleTime);
  writeOverride(store, id, { doubleTime: next });
  return next;
}

/**
 * Drop a track's manual double-time override so it reverts to the automatic
 * octave-fold check. Removes the whole entry if nothing meaningful remains.
 */
export function clearDoubleTime(store: KeyValueStore, id: string): void {
  const all = readOverrides(store);
  const entry = all[id];
  if (!entry || entry.doubleTime === undefined) return;
  delete entry.doubleTime;
  if (
    entry.bpm === undefined &&
    entry.detectedBpm === undefined &&
    entry.delayMs === undefined
  ) {
    delete all[id];
  } else {
    all[id] = entry;
  }
  store.set(STORAGE_KEY, JSON.stringify(all));
}
