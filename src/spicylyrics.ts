// Best-effort onset source from the Spicy Lyrics extension, when the user has it
// installed and has opted in. Spicy Lyrics caches the synced lyrics it fetches
// per track in a per-origin CacheStorage ("SpicyLyrics_LyricsStore_g1", keyed by
// "/<trackId>", value { ExpiresAt, CacheVersion, Content }). Because CacheStorage
// is shared across extensions on the same origin, we read that cache directly —
// no dependency on Spicy Lyrics *exposing* anything, no network, no auth. We
// harvest each sung syllable's {Text, StartTime, EndTime} as a pulse onset span
// so the cat throbs on the syllables and holds through held notes.
//
// Entirely best-effort: null whenever Spicy Lyrics is absent (cache empty),
// hasn't cached the track yet, or the lyrics are unsynced — and the pulse falls
// back to its beat clock.

import { PulseOnset } from "./pulse";

/**
 * Recursively harvest sung units — objects carrying a numeric `StartTime` *and* a
 * string `Text` (a syllable in word-synced lyrics, or a line in line-synced) —
 * as {start, end} spans. Depth-guarded; robust to the exact nesting.
 */
export function collectSpans(node: unknown, out: PulseOnset[] = [], depth = 0): PulseOnset[] {
  if (depth > 12 || node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectSpans(item, out, depth + 1);
    return out;
  }
  const rec = node as Record<string, unknown>;
  if (
    typeof rec.StartTime === "number" &&
    Number.isFinite(rec.StartTime) &&
    typeof rec.Text === "string"
  ) {
    const end =
      typeof rec.EndTime === "number" && Number.isFinite(rec.EndTime) ? rec.EndTime : undefined;
    out.push({ start: rec.StartTime, end });
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") collectSpans(value, out, depth + 1);
  }
  return out;
}

// A whole song's last onset is ~10^2 in seconds but ~10^5 in ms; anything below
// this reads as seconds and is scaled up. Cleanly separates real tracks either
// way, so it doesn't matter that Spicy Lyrics' unit could change.
const SECONDS_MAX_MS = 10_000;

/**
 * Onset spans in **milliseconds**, sorted by start and de-duplicated by start,
 * or null when there aren't at least two (unsynced / empty). Normalizes
 * seconds → ms by scale.
 */
export function onsetSpansFromLyrics(parsed: unknown): PulseOnset[] | null {
  const spans = collectSpans(parsed);
  if (spans.length < 2) return null;
  const maxStart = spans.reduce((m, s) => Math.max(m, s.start), 0);
  const k = maxStart < SECONDS_MAX_MS ? 1000 : 1; // seconds → ms
  const byStart = new Map<number, PulseOnset>();
  for (const s of spans) {
    const start = s.start * k;
    const end = typeof s.end === "number" ? s.end * k : undefined;
    const existing = byStart.get(start);
    if (!existing || (existing.end === undefined && end !== undefined)) {
      byStart.set(start, end !== undefined ? { start, end } : { start });
    }
  }
  const out = [...byStart.values()].sort((a, b) => a.start - b.start);
  return out.length >= 2 ? out : null;
}

// CacheStorage name Spicy Lyrics uses for API-fetched lyrics (version-pinned by
// the "_g1" suffix — if Spicy Lyrics bumps it, this needs to follow).
const LYRICS_CACHE = "SpicyLyrics_LyricsStore_g1";

/** Read the parsed lyrics object Spicy Lyrics cached for a track id, else null. */
export async function readSpicyLyricsCache(trackId: string): Promise<unknown | null> {
  const cacheStorage: CacheStorage | undefined = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheStorage) return null;
  try {
    const cache = await cacheStorage.open(LYRICS_CACHE);
    const res = await cache.match(`/${trackId}`);
    if (!res) return null;
    const wrapped = (await res.json()) as { Content?: unknown };
    return wrapped?.Content ?? null;
  } catch {
    return null;
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Injectable transport, so the poll/parse logic stays unit-testable. */
export interface OnsetReaderOpts {
  read?: (trackId: string) => Promise<unknown | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Fast initial probe delays (ms): catch a warm cache instantly and cover the
   *  first few seconds densely. After these, polling continues at `pollIntervalMs`. */
  retries?: number[];
  /** Steady poll interval (ms) after the warmup probes. */
  pollIntervalMs?: number;
  /** Give up polling a cold track after this long (ms) and stay on the beat. */
  maxWaitMs?: number;
}

/**
 * Build a `fetchOnsets(uri)` backed by Spicy Lyrics' lyrics cache. `enabled` gates
 * it (no-op until opted in). Spicy Lyrics fetches+caches on song change, but on a
 * cold track that can land many seconds in — so we don't give up at a fixed point:
 * we probe fast at first (warm cache → instant), then keep polling through playback
 * and resolve the moment the lyrics land. Onsets carry absolute timestamps and the
 * pulse clock is player-driven, so applying them **mid-song** is correct — sync
 * engages as soon as the cache warms, even on the very first play. A newer request
 * supersedes any in-flight poll (track skipped). Always resolves; null → beat.
 */
export function createSpicyOnsetReader(
  enabled: () => boolean,
  opts: OnsetReaderOpts = {}
): (uri: string) => Promise<PulseOnset[] | null> {
  const read = opts.read ?? readSpicyLyricsCache;
  const sleep = opts.sleep ?? sleepDefault;
  const warmup = opts.retries ?? [0, 500, 1000, 2000, 3500, 5000];
  const pollIntervalMs = opts.pollIntervalMs ?? 2500;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  let latest = 0; // bumped per call; an older in-flight poll bails when superseded
  return async (uri: string): Promise<PulseOnset[] | null> => {
    const token = ++latest;
    if (!enabled()) return null;
    const parts = typeof uri === "string" ? uri.split(":") : [];
    const trackId = parts[0] === "spotify" && parts[1] === "track" ? parts[2] : "";
    if (!trackId) return null; // podcasts / local files have no track-lyrics cache

    let elapsed = 0;
    for (let idx = 0; ; idx++) {
      const inWarmup = idx < warmup.length;
      if (!inWarmup && elapsed >= maxWaitMs) return null; // cold track → give up to the beat
      const delay = inWarmup ? warmup[idx] : pollIntervalMs;
      if (delay > 0) {
        await sleep(delay);
        elapsed += delay;
      }
      if (token !== latest) return null; // a newer track superseded this poll
      if (!enabled()) return null; // toggled off during the wait
      let lyrics: unknown = null;
      try {
        lyrics = await read(trackId);
      } catch {
        lyrics = null;
      }
      const onsets = lyrics ? onsetSpansFromLyrics(lyrics) : null;
      if (onsets) return onsets;
      // Cached but no syllable/line timing (static lyrics / instrumental): once past
      // the dense warmup window, stop — re-parsing the same unchanged blob every tick
      // won't turn it synced. (A not-yet-cached track has `lyrics == null` → keep
      // polling; the warmup still allows a late first write.)
      if (lyrics && !inWarmup) return null;
    }
  };
}
