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

/**
 * Which method produced a track's `detectedBpm` (its provenance):
 * - `reccobeats`         — ReccoBeats catalog features, by Spotify id (Spotify's tempo).
 * - `reccobeats-isrc`    — ReccoBeats catalog features, via a sibling ISRC (from Spotify).
 * - `reccobeats-isrc-mb` — same, but the ISRC was resolved through MusicBrainz.
 * - `getsongbpm`         — GetSongBPM database (user API key; a real BPM source).
 * - `musicae-spotify`    — Musicae "Spotify Extended Audio Features" RapidAPI (Spotify tempo by id).
 * - `musicae-dj`         — Musicae "DJ Track Audio Analysis" RapidAPI (analysed rhythm.bpm by id).
 * Each RapidAPI API is a distinct binding (subscribed separately), so its BPMs are
 * recorded under its own exact signature above rather than a shared "rapidapi" tag.
 * - `preview`            — ReccoBeats analysis of the 30s preview clip (rough, unverified).
 * A `manual` value lives in `bpm`, not here.
 */
export type BpmSource =
  | "reccobeats"
  | "reccobeats-isrc"
  | "reccobeats-isrc-mb"
  | "getsongbpm"
  | "musicae-spotify"
  | "musicae-dj"
  | "preview";
const BPM_SOURCES: readonly BpmSource[] = [
  "reccobeats",
  "reccobeats-isrc",
  "reccobeats-isrc-mb",
  "getsongbpm",
  "musicae-spotify",
  "musicae-dj",
  "preview",
];

export interface TrackOverride {
  /** Human-readable "Song - Artist", stored for readability in the whitelist. */
  name?: string;
  /** Recording ISRC, backpopulated from analysis; lets the ISRC tempo fallback run. */
  isrc?: string;
  /** Manual BPM override; authoritative for playback when set. */
  bpm?: number;
  /** The auto-detected BPM, preserved even after a manual override so it can be reset to. */
  detectedBpm?: number;
  /** How `detectedBpm` was found — undefined for pre-provenance entries (backfilled on rescan). */
  bpmSource?: BpmSource;
  /**
   * Meter divisor: cut the tempo into this many beats. 1 = raw, 2 = half-time
   * (the former `true`), 3/4 = 3- or 4-beat meters. Undefined = automatic octave
   * fold. Legacy booleans migrate: true → 2, false → 1. Both a manual pick and a
   * detected time signature write this single field (they never both apply).
   */
  doubleTime?: number;
  /** True when `doubleTime` came from time-signature detection (provenance for the
   *  "Meter: detected" label + reset button); a manual pick clears it. */
  meterDetected?: boolean;
  /** The detected time-signature numerator (kept for display), when detection ran. */
  timeSignature?: number;
  /** Manual sync offset in ms [0, MAX_DELAY_MS] applied before the cat restarts. */
  delayMs?: number;
  /**
   * Manual LYRIC sync offset in ms, **signed** [-MAX_LYRIC_OFFSET_MS, +MAX_LYRIC_OFFSET_MS]: shifts
   * every lyric line/word onset later (+) or earlier (−) without touching the per-word timing. The
   * editor loads it and the onset + overlay paths add it at consumption, so it's non-destructive.
   */
  lyricOffsetMs?: number;
  /**
   * Lyric-editor bookmark: a timeline position (ms ≥ 0) marking where the user left off editing a
   * track's words. Shown in purple in the editor + the cache list; cleared the next time the words
   * are changed. Pure UI state — no effect on playback.
   */
  bookmarkMs?: number;
  /** Per-track UI nicknames for the two duet voices — display aliases for the canonical TTML agents
   *  "a" / "b". Default to "Mittens" / "Biscuit" (see DEFAULT_SINGER_NAMES) when unset. Pure UI +
   *  TTML `<ttm:name>`; they never affect which cat pops (that's the word's `singer`). */
  singerA?: string;
  singerB?: string;
  /** The song's language for romanization — a code ("ko"/"ja"/"zh"/"other") chosen in the line editor's
   *  dropdown, overriding auto-detection. Unset = auto-detect. */
  language?: string;
}

/** Default UI aliases for the two duet voices (canonical ids "a" / "b"). */
export const DEFAULT_SINGER_NAMES: { a: string; b: string } = { a: "Mittens", b: "Biscuit" };

function isBpm(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** A valid meter divisor: a finite number ≥ 1 (2 = half-time). */
function isDivisor(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1;
}

/** Coerce a stored `doubleTime` (legacy boolean or number) to a divisor, or undefined. */
function toDivisor(v: unknown): number | undefined {
  if (typeof v === "boolean") return v ? 2 : 1; // legacy: true → half-time, false → raw
  return isDivisor(v) ? v : undefined;
}

function isBpmSource(v: unknown): v is BpmSource {
  return typeof v === "string" && (BPM_SOURCES as readonly string[]).includes(v);
}

function isDelay(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Clamp an arbitrary number to a whole millisecond delay in range. */
export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(ms)));
}

/** The lyric sync offset is signed and can be large (whole seconds); allow ±10s. */
export const MAX_LYRIC_OFFSET_MS = 10_000;

/** A valid stored lyric offset: a finite number (either sign). */
function isLyricOffset(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A valid stored bookmark: a finite timeline position ≥ 0. */
function isBookmark(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Clamp an arbitrary number to a whole-ms signed lyric offset in range. */
export function clampLyricOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_LYRIC_OFFSET_MS, Math.max(-MAX_LYRIC_OFFSET_MS, Math.round(ms)));
}

/**
 * Read the whole map, tolerating missing/corrupt storage and migrating the
 * legacy `{ id: boolean }` shape (double-time only) to `{ id: { doubleTime } }`.
 */
// Memoize the parsed+migrated map keyed by the raw stored string, so the many getOverride() calls
// (list rendering, per-track lookups) don't re-parse + re-migrate the whole store each time. Any
// write changes the raw string, so the next read re-parses automatically. Writers clone the result
// before mutating (see writeOverride/removeOverride/…), so the cached object is never mutated.
let ovCacheRaw: string | null = null;
let ovCacheMap: Record<string, TrackOverride> = {};

export function readOverrides(store: KeyValueStore): Record<string, TrackOverride> {
  try {
    const raw = store.get(STORAGE_KEY) || "{}";
    if (raw === ovCacheRaw) return ovCacheMap;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, TrackOverride> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") {
        out[id] = { doubleTime: value ? 2 : 1 }; // legacy `{id: boolean}` → divisor
      } else if (value && typeof value === "object") {
        const entry: TrackOverride = {};
        const { name, isrc, bpm, detectedBpm, bpmSource, doubleTime, meterDetected, timeSignature, delayMs, lyricOffsetMs, bookmarkMs, singerA, singerB, language } =
          value as Record<string, unknown>;
        if (typeof name === "string" && name) entry.name = name;
        if (typeof isrc === "string" && isrc) entry.isrc = isrc;
        if (typeof singerA === "string" && singerA) entry.singerA = singerA;
        if (typeof singerB === "string" && singerB) entry.singerB = singerB;
        if (typeof language === "string" && language) entry.language = language;
        if (isBpm(bpm)) entry.bpm = bpm;
        if (isBpm(detectedBpm)) entry.detectedBpm = detectedBpm;
        if (entry.detectedBpm !== undefined && isBpmSource(bpmSource)) entry.bpmSource = bpmSource;
        const divisor = toDivisor(doubleTime); // legacy boolean → number, or a stored number
        if (divisor !== undefined) entry.doubleTime = divisor;
        if (isDivisor(timeSignature)) entry.timeSignature = timeSignature;
        if (entry.doubleTime !== undefined && meterDetected === true) {
          // Legacy fix: common time (4/4) used to be stored as a detected meter (÷4,
          // later ÷1), which showed a "Detected" default. Common time now bounces raw
          // with no override — strip the detected meter so it reads as plain 1×. Other
          // detected meters (3/4 → ÷3, …) are kept.
          if (entry.timeSignature === 4) {
            delete entry.doubleTime;
            delete entry.timeSignature;
          } else {
            entry.meterDetected = true;
          }
        }
        if (isDelay(delayMs)) entry.delayMs = clampDelay(delayMs);
        if (isLyricOffset(lyricOffsetMs) && lyricOffsetMs !== 0) entry.lyricOffsetMs = clampLyricOffset(lyricOffsetMs);
        if (isBookmark(bookmarkMs)) entry.bookmarkMs = Math.round(bookmarkMs);
        out[id] = entry;
      }
    }
    ovCacheRaw = raw;
    ovCacheMap = out;
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
  const all = { ...readOverrides(store) };
  const merged: TrackOverride = { ...(all[id] ?? {}), ...patch };
  // Reconstruct with a stable, readable field order (name first).
  const ordered: TrackOverride = {};
  if (merged.name !== undefined) ordered.name = merged.name;
  if (merged.isrc !== undefined) ordered.isrc = merged.isrc;
  if (merged.bpm !== undefined) ordered.bpm = merged.bpm;
  if (merged.detectedBpm !== undefined) ordered.detectedBpm = merged.detectedBpm;
  if (merged.detectedBpm !== undefined && merged.bpmSource !== undefined) {
    ordered.bpmSource = merged.bpmSource; // provenance only meaningful with a detected value
  }
  if (merged.doubleTime !== undefined) ordered.doubleTime = merged.doubleTime;
  if (merged.doubleTime !== undefined && merged.meterDetected) ordered.meterDetected = true;
  if (merged.timeSignature !== undefined) ordered.timeSignature = merged.timeSignature;
  if (merged.delayMs !== undefined) ordered.delayMs = merged.delayMs;
  if (merged.lyricOffsetMs !== undefined && merged.lyricOffsetMs !== 0) ordered.lyricOffsetMs = merged.lyricOffsetMs;
  if (merged.bookmarkMs !== undefined) ordered.bookmarkMs = merged.bookmarkMs;
  if (merged.singerA !== undefined) ordered.singerA = merged.singerA;
  if (merged.singerB !== undefined) ordered.singerB = merged.singerB;
  if (merged.language !== undefined) ordered.language = merged.language;
  all[id] = ordered;
  store.set(STORAGE_KEY, JSON.stringify(all));
  return ordered;
}

/** Persist the "Song - Artist" label for a track. */
export function setTrackName(store: KeyValueStore, id: string, name: string): void {
  if (name) writeOverride(store, id, { name });
}

/** The two duet-voice UI nicknames for a track — stored overrides, or the Mittens/Biscuit defaults. */
export function getSingerNames(store: KeyValueStore, id: string): { a: string; b: string } {
  const o = id ? getOverride(store, id) : undefined;
  return {
    a: o?.singerA?.trim() || DEFAULT_SINGER_NAMES.a,
    b: o?.singerB?.trim() || DEFAULT_SINGER_NAMES.b,
  };
}

/** Rename one duet voice for a track. An empty/whitespace/default-equal name clears the override so it
 *  falls back to the Mittens/Biscuit default (keeps the whitelist tidy). */
export function setSingerName(store: KeyValueStore, id: string, which: "a" | "b", name: string): void {
  if (!id) return;
  const trimmed = name.trim();
  const def = which === "a" ? DEFAULT_SINGER_NAMES.a : DEFAULT_SINGER_NAMES.b;
  const value = trimmed && trimmed !== def ? trimmed : undefined; // undefined → clears back to the default
  writeOverride(store, id, which === "a" ? { singerA: value } : { singerB: value });
}

/** The track's chosen romanization language code, or "auto" when unset (→ auto-detect). */
export function getTrackLanguage(store: KeyValueStore, id: string): string {
  return (id ? getOverride(store, id)?.language : undefined) || "auto";
}

/** Set the track's romanization language ("auto" clears the override → auto-detect). */
export function setTrackLanguage(store: KeyValueStore, id: string, lang: string): void {
  if (!id) return;
  writeOverride(store, id, { language: lang && lang !== "auto" ? lang : undefined });
}

/**
 * Persist a track's ISRC (backpopulating older whitelist entries). Pure metadata,
 * like `name`: recorded when analysis discovers it so a later id-lookup miss can
 * retry the recording by ISRC without re-resolving it.
 */
export function setIsrc(store: KeyValueStore, id: string, isrc: string): void {
  if (isrc) writeOverride(store, id, { isrc });
}

/** Delete a track's entry from the whitelist. Returns true if one was removed. */
export function removeOverride(store: KeyValueStore, id: string): boolean {
  const all = { ...readOverrides(store) };
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

/**
 * Track ids eligible for API backfill: those whose detected BPM came from the
 * rough `preview` scan and that carry no manual override. A `preview` tag is the
 * greenlight — real/provider-sourced values (ReccoBeats, GetSongBPM, Musicae) and
 * manual overrides are left untouched, so a sweep only upgrades the unverified ones.
 */
export function previewBackfillCandidates(store: KeyValueStore): string[] {
  return Object.entries(readOverrides(store))
    .filter(([, o]) => o.bpmSource === "preview" && o.detectedBpm !== undefined && o.bpm === undefined)
    .map(([id]) => id);
}

/**
 * Legacy entries with a detected BPM but no recorded `bpmSource` (cached before
 * provenance tracking) and no manual override. The sync re-runs detection on these
 * to establish where the tempo comes from — upgrading them to a real provider, or
 * tagging them `preview` and giving the API a shot when no real source has them.
 */
export function unsourcedBackfillCandidates(store: KeyValueStore): string[] {
  return Object.entries(readOverrides(store))
    .filter(([, o]) => o.bpmSource === undefined && o.detectedBpm !== undefined && o.bpm === undefined)
    .map(([id]) => id);
}

/** Persist a manual BPM override for a track (authoritative for playback). */
export function setStoredBpm(store: KeyValueStore, id: string, bpm: number): void {
  if (isBpm(bpm)) writeOverride(store, id, { bpm });
}

/**
 * Persist the auto-detected BPM for a track (kept even when bpm is overridden),
 * tagged with the method that found it. Also lets replays reuse it instead of
 * re-hitting the APIs.
 */
export function setDetectedBpm(
  store: KeyValueStore,
  id: string,
  bpm: number,
  source?: BpmSource
): void {
  if (isBpm(bpm)) writeOverride(store, id, source ? { detectedBpm: bpm, bpmSource: source } : { detectedBpm: bpm });
}

/** A source trustworthy enough to become the authoritative BPM (everything but `preview`). */
export function isLegitimateSource(source: BpmSource): boolean {
  return source !== "preview";
}

/**
 * Record an auto-detected BPM with its provenance. A rough `preview` scan stays in
 * `detectedBpm` only — tentative, and still eligible for the API sync. A real
 * provider result (ReccoBeats / GetSongBPM / Musicae) is *also* written to the
 * authoritative `bpm`, so it counts as a legitimate value: kept out of the sync
 * sweep and shown by its source, not as a manual override. Either way the
 * `detectedBpm` + `bpmSource` pair is preserved for provenance.
 */
export function recordDetection(store: KeyValueStore, id: string, bpm: number, source: BpmSource): void {
  setDetectedBpm(store, id, bpm, source);
  if (isBpm(bpm) && isLegitimateSource(source)) setStoredBpm(store, id, bpm);
}

/**
 * Drop a track's manual bpm override (reverting playback to the detected bpm).
 * Removes the whole entry if nothing meaningful remains.
 */
export function clearStoredBpm(store: KeyValueStore, id: string): void {
  const all = { ...readOverrides(store) };
  const entry = all[id];
  if (!entry || entry.bpm === undefined) return;
  delete entry.bpm;
  if (
    entry.detectedBpm === undefined &&
    entry.doubleTime === undefined &&
    entry.delayMs === undefined &&
    entry.lyricOffsetMs === undefined &&
    entry.bookmarkMs === undefined
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
 * Persist a *manual* meter divisor (cut the tempo into this many beats): 1 = raw,
 * 2 = half-time, 3/4 = 3- or 4-beat meters. Ignores invalid values (< 1). Clears
 * the detected-meter provenance (this is now a manual pick). Use `clearDoubleTime`
 * to revert to the automatic octave fold.
 */
export function setDoubleTime(store: KeyValueStore, id: string, divisor: number): void {
  if (!isDivisor(divisor)) return;
  const entry = readOverrides(store)[id];
  writeOverride(store, id, { doubleTime: divisor });
  if (entry?.meterDetected || entry?.timeSignature !== undefined) clearMeterDetection(store, id);
}

/**
 * Persist a *detected* meter: `divisor` is the felt-tempo divisor (a time-signature
 * numerator for an odd meter, or an octave-fold factor like 2 for a double-time
 * tempo), and the provenance flag is set so the UI shows "Detected ÷N". A time
 * signature is recorded when the divisor came from one (for the "N/4" label). Callers
 * clear the meter first, so nothing stale is carried over.
 */
export function setDetectedMeter(
  store: KeyValueStore,
  id: string,
  divisor: number,
  timeSignature?: number
): void {
  if (!isDivisor(divisor)) return;
  writeOverride(
    store,
    id,
    isDivisor(timeSignature)
      ? { doubleTime: divisor, meterDetected: true, timeSignature }
      : { doubleTime: divisor, meterDetected: true }
  );
}

/** Drop only the detected-meter provenance (keeps doubleTime as a plain manual value). */
function clearMeterDetection(store: KeyValueStore, id: string): void {
  const all = { ...readOverrides(store) };
  const entry = all[id];
  if (!entry) return;
  delete entry.meterDetected;
  delete entry.timeSignature;
  all[id] = entry;
  store.set(STORAGE_KEY, JSON.stringify(all));
}

/**
 * Drop a track's meter override entirely (divisor + detection provenance) so it
 * reverts to the automatic octave fold. Removes the whole entry if nothing else remains.
 */
export function clearDoubleTime(store: KeyValueStore, id: string): void {
  const all = { ...readOverrides(store) };
  const entry = all[id];
  if (!entry || (entry.doubleTime === undefined && entry.meterDetected === undefined)) return;
  delete entry.doubleTime;
  delete entry.meterDetected;
  delete entry.timeSignature;
  if (
    entry.bpm === undefined &&
    entry.detectedBpm === undefined &&
    entry.delayMs === undefined &&
    entry.lyricOffsetMs === undefined &&
    entry.bookmarkMs === undefined
  ) {
    delete all[id];
  } else {
    all[id] = entry;
  }
  store.set(STORAGE_KEY, JSON.stringify(all));
}

/** A track's signed lyric sync offset (ms), or 0 when none is set. */
export function getLyricOffset(store: KeyValueStore, id: string): number {
  return readOverrides(store)[id]?.lyricOffsetMs ?? 0;
}

/**
 * Persist a track's signed lyric sync offset (ms), clamped to ±MAX_LYRIC_OFFSET_MS. Setting it to 0
 * drops the field (and the whole entry if nothing else remains) so a reset leaves no clutter.
 */
export function setLyricOffset(store: KeyValueStore, id: string, ms: number): void {
  const v = clampLyricOffset(ms);
  if (v === 0) {
    clearLyricOffset(store, id);
    return;
  }
  writeOverride(store, id, { lyricOffsetMs: v });
}

/** Remove a track's lyric offset (and the whole entry if it's then empty). */
function clearLyricOffset(store: KeyValueStore, id: string): void {
  const all = { ...readOverrides(store) };
  const entry = all[id];
  if (!entry || entry.lyricOffsetMs === undefined) return;
  delete entry.lyricOffsetMs;
  if (
    entry.bpm === undefined &&
    entry.detectedBpm === undefined &&
    entry.doubleTime === undefined &&
    entry.delayMs === undefined &&
    entry.bookmarkMs === undefined
  ) {
    delete all[id]; // only a name (or nothing) left
  } else {
    all[id] = entry;
  }
  store.set(STORAGE_KEY, JSON.stringify(all));
}

/** A track's editor bookmark (timeline ms), or null when none is set. */
export function getBookmark(store: KeyValueStore, id: string): number | null {
  const v = readOverrides(store)[id]?.bookmarkMs;
  return typeof v === "number" ? v : null;
}

/** Persist a track's editor bookmark (timeline ms ≥ 0). */
export function setBookmark(store: KeyValueStore, id: string, ms: number): void {
  writeOverride(store, id, { bookmarkMs: Math.max(0, Math.round(ms)) });
}

/** Remove a track's editor bookmark (and the whole entry if it's then empty). */
export function clearBookmark(store: KeyValueStore, id: string): void {
  const all = { ...readOverrides(store) };
  const entry = all[id];
  if (!entry || entry.bookmarkMs === undefined) return;
  delete entry.bookmarkMs;
  if (
    entry.bpm === undefined &&
    entry.detectedBpm === undefined &&
    entry.doubleTime === undefined &&
    entry.delayMs === undefined &&
    entry.lyricOffsetMs === undefined
  ) {
    delete all[id]; // only a name (or nothing) left
  } else {
    all[id] = entry;
  }
  store.set(STORAGE_KEY, JSON.stringify(all));
}
