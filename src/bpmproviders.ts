// GetSongBPM — an optional, user-key-gated BPM database, tried best-effort when
// ReccoBeats can't resolve a tempo. Search by song+artist → `tempo`, resolving the
// /song/ endpoint when /search/ omits it. Returns a plain BPM number or null; the
// parse logic is pure (unit-testable) and the network call is fed an injected fetch.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function isBpm(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 40 && n <= 300;
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
