// GetSongBPM — an optional, user-key-gated BPM database, tried best-effort when
// ReccoBeats can't resolve a tempo. Search by song+artist → `tempo`, resolving the
// /song/ endpoint when /search/ omits it. Returns a plain BPM number or null; the
// parse logic is pure (unit-testable) and the network call is fed an injected fetch.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function isBpm(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 300;
}

/** First numeric `tempo`-keyed value anywhere in a response object, else null. */
export function findTempo(node: unknown, depth = 0): number | null {
  if (depth > 6 || node == null || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase() === "tempo") {
      const n = Number(value);
      if (isBpm(n)) return Math.round(n);
    }
    const nested = findTempo(value, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

const GETSONGBPM_BASE = "https://api.getsong.co"; // the API host (NOT getsongbpm.com)

export function parseGetSongBpm(body: unknown): number | null {
  return findTempo(body); // tempo lives inside search[]/song, wherever the shape puts it
}

/** First song id in a search response (`search[].song_id`/`id`), else null. */
export function firstSongId(body: unknown): string | null {
  const arr = (body as { search?: unknown })?.search;
  for (const it of Array.isArray(arr) ? arr : []) {
    const idv = (it as { song_id?: unknown; id?: unknown })?.song_id ?? (it as { id?: unknown })?.id;
    if (typeof idv === "string" && idv) return idv;
    if (typeof idv === "number") return String(idv);
  }
  return null;
}

export async function fetchGetSongBpm(
  fetchFn: FetchLike,
  apiKey: string,
  title: string,
  artist?: string
): Promise<number | null> {
  if (!apiKey || !title) return null;
  const key = encodeURIComponent(apiKey);
  const lookup = artist ? `song:${title} artist:${artist}` : title;
  const searchUrl = `${GETSONGBPM_BASE}/search/?type=both&api_key=${key}&lookup=${encodeURIComponent(lookup)}`;
  try {
    const res = await fetchFn(searchUrl);
    if (!res.ok) return null; // bad key / rate-limited / miss → fail soft
    const body = await res.json();
    const direct = parseGetSongBpm(body);
    if (direct !== null) return direct; // some responses embed tempo in the search hit
    const songId = firstSongId(body);
    if (!songId) return null;
    const songRes = await fetchFn(`${GETSONGBPM_BASE}/song/?api_key=${key}&id=${encodeURIComponent(songId)}`);
    if (!songRes.ok) return null;
    return parseGetSongBpm(await songRes.json()); // tempo lives on the /song/ endpoint
  } catch {
    return null;
  }
}

// --- Musicae RapidAPI providers --------------------------------------------
// Two RapidAPI endpoints (one shared key) that resolve a real BPM straight from
// a Spotify track id — the coverage GetSongBPM's title/artist search misses and
// ReccoBeats' frozen cache lacks for current releases. Both are free-tier limited
// to a few calls/day, so callers gate them through ./ratelimit and run them only
// as a last resort before the preview scan.

const RAPIDAPI_HOST_FEATURES = "spotify-extended-audio-features-api.p.rapidapi.com";
const RAPIDAPI_HOST_DJ = "dj-track-audio-analysis-api.p.rapidapi.com";

/**
 * Outcome of one rate-limited provider call. `responded` is true iff the request
 * reached the provider and got an HTTP response (any status) — the caller counts
 * it against the daily budget only then, so a network error the provider never
 * saw doesn't waste a slot. `bpm` is the resolved tempo, or null on a miss/error.
 */
export interface ProviderResult {
  responded: boolean;
  bpm: number | null;
  /** Time-signature numerator (beats per bar) when the response carries one. */
  timeSignature?: number;
}

/** Coerce a time-signature value: a number, a "N/M" string, or beats_per_bar. Range 2..12. */
function tsValue(v: unknown): number | undefined {
  let n = NaN;
  if (typeof v === "number") n = Math.round(v);
  else if (typeof v === "string") {
    const m = v.match(/^\s*(\d+)\s*(?:\/\s*\d+)?/); // "4/4" → 4, "3" → 3
    if (m) n = Number(m[1]);
  }
  return Number.isFinite(n) && n >= 2 && n <= 12 ? n : undefined;
}

/**
 * First `time_signature` / `beats_per_bar`-keyed value anywhere in a response — the
 * Spotify shape puts an int at `audio_features[0].time_signature`; the DJ shape a
 * `"4/4"` string (and `beats_per_bar`) inside `rhythm`.
 */
export function findTimeSignature(node: unknown, depth = 0): number | undefined {
  if (depth > 6 || node == null || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (k === "time_signature" || k === "timesignature" || k === "beats_per_bar") {
      const n = tsValue(value);
      if (n !== undefined) return n;
    }
    const nested = findTimeSignature(value, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * First `tempo`/`bpm`-keyed numeric value anywhere in a response, fractional
 * precision preserved. Tolerant of shape: the features endpoint nests it at
 * `audio_features[0].tempo` (a number), the DJ endpoint at `rhythm.bpm` (a
 * number, alongside a string `tempo` like "123.00 BPM" which is skipped as NaN).
 */
export function findBpmLike(node: unknown, depth = 0): number | null {
  if (depth > 6 || node == null || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (k === "tempo" || k === "bpm") {
      const n = Number(value);
      if (isBpm(n)) return n; // keep the fraction (e.g. 188.25, 122.746)
    }
    const nested = findBpmLike(value, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

const rapidHeaders = (host: string, key: string): RequestInit => ({
  headers: { "x-rapidapi-key": key, "x-rapidapi-host": host },
});

/** GET a RapidAPI url and pull a BPM out, distinguishing a miss from a no-response. */
async function fetchRapidBpm(fetchFn: FetchLike, host: string, url: string, key: string): Promise<ProviderResult> {
  if (!key) return { responded: false, bpm: null };
  let res: Response;
  try {
    res = await fetchFn(url, rapidHeaders(host, key));
  } catch {
    return { responded: false, bpm: null }; // network error — provider never saw it
  }
  if (!res.ok) return { responded: true, bpm: null }; // 404 miss / 429 throttle / bad key
  try {
    const body = await res.json();
    return { responded: true, bpm: findBpmLike(body), timeSignature: findTimeSignature(body) };
  } catch {
    return { responded: true, bpm: null };
  }
}

/** Musicae "Spotify Extended Audio Features" — Spotify's tempo by track id (or ISRC). */
export function fetchMusicaeFeatures(fetchFn: FetchLike, apiKey: string, idOrIsrc: string): Promise<ProviderResult> {
  if (!apiKey || !idOrIsrc) return Promise.resolve({ responded: false, bpm: null });
  const url = `https://${RAPIDAPI_HOST_FEATURES}/v1/audio-features?ids=${encodeURIComponent(idOrIsrc)}`;
  return fetchRapidBpm(fetchFn, RAPIDAPI_HOST_FEATURES, url, apiKey);
}

/** Musicae "DJ Track Audio Analysis" — analysed rhythm.bpm by track id (or ISRC). */
export function fetchMusicaeDj(fetchFn: FetchLike, apiKey: string, idOrIsrc: string): Promise<ProviderResult> {
  if (!apiKey || !idOrIsrc) return Promise.resolve({ responded: false, bpm: null });
  const url = `https://${RAPIDAPI_HOST_DJ}/v2/audio-analysis/${encodeURIComponent(idOrIsrc)}`;
  return fetchRapidBpm(fetchFn, RAPIDAPI_HOST_DJ, url, apiKey);
}
