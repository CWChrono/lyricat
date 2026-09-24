import { FetchLike } from "./reccobeats";

// MusicBrainz is the last ISRC source: when neither the loaded track metadata nor
// Pathfinder exposes an ISRC, a title+artist search here often does. The public
// API needs no auth but asks for <=1 request/sec per IP (the caller serializes
// and caches, so we make at most one request per track). A custom User-Agent is
// recommended but can't be set from a browser (it's a forbidden fetch header);
// the client's real Chromium UA is meaningful enough not to be blocked. CORS is
// open (`Access-Control-Allow-Origin: *`), so plain fetch reaches it.
const SEARCH_ENDPOINT = "https://musicbrainz.org/ws/2/recording";

/** Escape and trim a value for use inside a MusicBrainz Lucene phrase query. */
function lucenePhrase(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").trim();
}

/** Build the recording search query for a title (+ optional artist). */
export function buildRecordingQuery(title: string, artist?: string): string {
  const t = `recording:"${lucenePhrase(title)}"`;
  const a = artist ? ` AND artist:"${lucenePhrase(artist)}"` : "";
  return t + a;
}

interface MbRecording {
  score?: unknown;
  isrcs?: unknown;
}

/**
 * Pick an ISRC out of a recording-search response: the first sufficiently
 * confident recording (score >= `minScore`, out of 100) that carries one. The
 * score gate guards against a fuzzy text match handing back a wrong recording's
 * ISRC — a wrong ISRC would resolve to a wrong tempo.
 */
export function parseSearchIsrc(body: unknown, minScore = 90): string | null {
  const recs = (body as { recordings?: MbRecording[] })?.recordings;
  if (!Array.isArray(recs)) return null;
  for (const r of recs) {
    const score = typeof r?.score === "number" ? r.score : 0;
    if (score < minScore) continue;
    if (!Array.isArray(r?.isrcs)) continue;
    const isrc = r.isrcs.find((x) => typeof x === "string" && x);
    if (typeof isrc === "string") return isrc;
  }
  return null;
}

/**
 * Resolve a recording's ISRC from MusicBrainz by a title (+ artist) text search.
 * A pure single request: the caller enforces the 1 req/sec limit and caches the
 * result. Returns null on no/low-confidence match, a busy or error response, or
 * a network failure — in every case the caller falls back to preview analysis,
 * so an absent ISRC never regresses behaviour.
 */
export async function fetchIsrcByText(
  fetchFn: FetchLike,
  title: string,
  artist?: string,
  minScore = 90
): Promise<string | null> {
  if (!title) return null;
  const query = encodeURIComponent(buildRecordingQuery(title, artist));
  const url = `${SEARCH_ENDPOINT}?query=${query}&limit=5&fmt=json`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null; // 503 "server busy", 4xx, etc. — treat as a miss
    return parseSearchIsrc(await res.json(), minScore);
  } catch {
    return null; // network error
  }
}
