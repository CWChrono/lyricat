// LRCLIB (https://lrclib.net) — a free, open, no-auth synced-lyrics database. Used as the
// MIDDLE tier of the lyric chain: Spicy Lyrics (word-synced, top choice) → LRCLIB (line-synced
// fallback) → the heuristic/beat detection. LRCLIB returns standard LRC ("[mm:ss.xx] text"),
// i.e. one timestamp per *line*, so its spans flow through the same line-level onset path
// (audio-timed / syllable-estimated) the rest of the extension already uses.
//
// Pure parsing over an injected fetch, so it's unit-testable and fails closed (null) whenever
// the track isn't found, has no synced lyrics, or the network is unavailable.

import { LyricSpan } from "./syllables";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The track identity LRCLIB matches on. Album + duration sharpen the exact `/get`; without
 *  them we fall back to a fuzzy `/search`. */
export interface LrcTrack {
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
}

const BASE = "https://lrclib.net/api";

// One LRC timestamp tag: [mm:ss], [mm:ss.xx] (centiseconds) or [mm:ss.xxx] (ms). A line may
// carry several (a repeated lyric) — each becomes its own span.
const TAG_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Convert one tag's captures to milliseconds (2-digit fraction = centiseconds). */
function tagMs(min: string, sec: string, frac?: string): number {
  let ms = (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000;
  if (frac) ms += frac.length === 3 ? parseInt(frac, 10) : parseInt(frac, 10) * (frac.length === 2 ? 10 : 100);
  return ms;
}

/**
 * Parse an LRC string into line spans (ms, sorted, de-duped by start). Metadata-only lines
 * ([ar:…], [by:…]) and empty lyrics are dropped. Null when fewer than two timed lines survive
 * (nothing usable → caller falls through to the next tier).
 */
export function parseLrc(lrc: string): LyricSpan[] | null {
  if (!lrc || typeof lrc !== "string") return null;
  const byStart = new Map<number, LyricSpan>();
  for (const raw of lrc.split(/\r?\n/)) {
    const text = raw.replace(TAG_RE, "").trim();
    if (!text) continue; // timing-less or metadata line
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(raw))) {
      const start = tagMs(m[1], m[2], m[3]);
      if (!byStart.has(start)) byStart.set(start, { start, text });
    }
  }
  const lines = [...byStart.values()].sort((a, b) => a.start - b.start);
  return lines.length >= 2 ? lines : null;
}

/** Pull the LRC synced-lyrics string from a LRCLIB row, or null (instrumental / unsynced). */
function syncedFrom(row: unknown): string | null {
  const r = row as { syncedLyrics?: unknown; instrumental?: unknown } | null;
  if (!r || r.instrumental === true) return null;
  return typeof r.syncedLyrics === "string" && r.syncedLyrics.trim() ? r.syncedLyrics : null;
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch a track's raw synced-lyrics LRC string from LRCLIB, or null. Tries the exact `/get`
 * first (artist + title + album + duration — LRCLIB matches duration within a couple seconds),
 * then a fuzzy `/search` (first hit that actually has *parseable* synced lyrics). Returning the
 * raw string (not parsed spans) lets the caller persist it verbatim as an `.lrc`.
 */
export async function fetchLrclibSynced(fetchFn: FetchLike, track: LrcTrack): Promise<string | null> {
  if (!track?.title) return null;
  const q = (s: string): string => encodeURIComponent(s);

  if (track.artist && track.durationSec && track.durationSec > 0) {
    const params =
      `track_name=${q(track.title)}&artist_name=${q(track.artist)}` +
      (track.album ? `&album_name=${q(track.album)}` : "") +
      `&duration=${Math.round(track.durationSec)}`;
    const synced = syncedFrom(await getJson(fetchFn, `${BASE}/get?${params}`));
    if (synced && parseLrc(synced)) return synced;
  }

  const searchParams = `track_name=${q(track.title)}` + (track.artist ? `&artist_name=${q(track.artist)}` : "");
  const results = await getJson(fetchFn, `${BASE}/search?${searchParams}`);
  if (Array.isArray(results)) {
    for (const row of results) {
      const synced = syncedFrom(row);
      if (synced && parseLrc(synced)) return synced;
    }
  }
  return null;
}

/** As `fetchLrclibSynced`, but parsed into line spans (or null). */
export async function fetchLrclibLines(fetchFn: FetchLike, track: LrcTrack): Promise<LyricSpan[] | null> {
  const synced = await fetchLrclibSynced(fetchFn, track);
  return synced ? parseLrc(synced) : null;
}
