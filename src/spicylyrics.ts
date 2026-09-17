// Best-effort onset source from the Spicy Lyrics extension, when the user has it
// installed and has opted in. Spicy Lyrics exposes a frozen public API on
// `window.SpicyLyrics`; its `db.objectStores.lyricsStore.manager.get(uri)`
// returns the cached, parsed (TTML) lyrics for a track — syllable/line objects
// carrying `StartTime`. We harvest those start times as pulse onsets so the cat
// throbs on the sung syllables. No network, no auth, no impersonation: purely
// what Spicy Lyrics already fetched and cached.
//
// It is entirely best-effort: null is returned whenever Spicy Lyrics is absent,
// hasn't cached the track, or the lyrics are unsynced — and the pulse falls back
// to its beat clock.

/** The slice of Spicy Lyrics' exposed API we touch (all optional — it may be absent). */
export interface SpicyLyricsApi {
  db?: {
    objectStores?: {
      lyricsStore?: {
        manager?: { get?(uri: string): Promise<unknown> };
      };
    };
  };
}

/**
 * Recursively harvest every numeric `StartTime` (Spicy Lyrics' per-syllable /
 * per-line onset) from a parsed-lyrics tree. Depth-guarded; ignores `EndTime`
 * and everything else. Robust to the exact nesting, which varies by lyric type
 * (Syllable vs Line).
 */
export function collectStartTimes(node: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 12 || node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectStartTimes(item, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "StartTime") {
      if (typeof value === "number" && Number.isFinite(value)) out.push(value);
    } else if (value && typeof value === "object") {
      collectStartTimes(value, out, depth + 1);
    }
  }
  return out;
}

// A whole song's last onset is ~10^2 in seconds but ~10^5 in ms; anything below
// this reads as seconds and is scaled up. Cleanly separates real tracks either
// way, so it doesn't matter that Spicy Lyrics' unit could change.
const SECONDS_MAX_MS = 10_000;

/**
 * Sorted, de-duplicated onset times in **milliseconds**, or null when there
 * aren't at least two (unsynced / empty). Normalizes seconds → ms by scale.
 */
export function onsetsFromLyrics(parsed: unknown): number[] | null {
  const times = [...new Set(collectStartTimes(parsed))].sort((a, b) => a - b);
  if (times.length < 2) return null;
  const looksLikeSeconds = times[times.length - 1] < SECONDS_MAX_MS;
  return looksLikeSeconds ? times.map((t) => t * 1000) : times;
}

/**
 * Build a `fetchOnsets(uri)` backed by Spicy Lyrics' cache. `enabled` gates the
 * whole thing (so it no-ops until the user opts in), and `getApi` reads
 * `window.SpicyLyrics` lazily — Spicy Lyrics may load after us, or not at all.
 * Always resolves (never throws); null means "fall back to the beat".
 */
export function createSpicyOnsetReader(
  enabled: () => boolean,
  getApi: () => SpicyLyricsApi | undefined
): (uri: string) => Promise<number[] | null> {
  return async (uri: string): Promise<number[] | null> => {
    if (!enabled()) return null;
    const manager = getApi()?.db?.objectStores?.lyricsStore?.manager;
    if (!manager || typeof manager.get !== "function") return null;
    try {
      const parsed = await manager.get(uri);
      return parsed ? onsetsFromLyrics(parsed) : null;
    } catch {
      return null; // cache miss / DB error → beat fallback
    }
  };
}
